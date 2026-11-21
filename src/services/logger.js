// 服务日志落盘：把 console 的输出同时写进 logs/server-YYYY-MM-DD.log
//
// 为什么需要（实测 2026-11-21）：
//   服务此前所有日志只进控制台，进程一退出就什么都没留下。
//   用户来问「登录态是什么时候掉的」时，只能靠登录态文件的 cookie 过期时间
//   反推——推出来的是「最后一次成功访问」的时刻，不是「第一次失效」的时刻，
//   两者能差出两个小时（会话已经死了，但系统两小时后才在界面上显示未登录）。
//   有了落盘日志，事后可以直接查证，不用猜。
//
// 落盘策略：
//   - 按天分文件（server-YYYY-MM-DD.log），天然轮转，不用自己做清理
//   - 同步追加写（appendFileSync）：进程被杀也不丢已写的内容
//   - 同一份内容同时进控制台，不改变现有观察方式
//
// 安全：日志里会出现网厅 URL 与错误文案，但不该出现凭据。
// 这里对「长串 token」做统一打码（cookie 值、票据都是这种形态），
// 避免某个异常把 cookie 原文打进日志文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 日志目录：默认 <项目根>/logs，可用环境变量覆盖（测试隔离用）
//
// 为什么跟着 LLM_MANAGER_DATA_DIR 走：冒烟测试会用临时数据目录起一个隔离实例，
// 若日志还写到项目的 logs/，测试输出会混进真实日志，事后查日志就被噪声淹没了。
export const LOG_DIR = process.env.LLM_MANAGER_LOG_DIR
  || (process.env.LLM_MANAGER_DATA_DIR
    ? path.join(process.env.LLM_MANAGER_DATA_DIR, 'logs')
    : path.join(__dirname, '..', '..', 'logs'));

// 长 token 打码：40 个字符以上的连续 base64/hex 串
// （cookie 值、票据、refresh token 都是这种形态；错误文案与堆栈不会命中）
const TOKEN_RE = /[A-Za-z0-9_\-+/=]{40,}/g;

export function redact(text) {
  return String(text ?? '').replace(TOKEN_RE, (m) => `***(${m.length}字符)`);
}

function logFileFor(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return path.join(LOG_DIR, `server-${day}.log`);
}

// 已经处理过 BOM 的文件（避免重复处理）
const createdFiles = new Set();

// 确保文件开头有 UTF-8 BOM。
// 为什么需要：Windows 自带的 PowerShell 5.1 与记事本默认按 ANSI(GBK) 读无 BOM 的
// UTF-8 文件，中文会显示成乱码（实测 2026-11-21：日志内容是对的，
// 用 PowerShell 看却全是「鍒锋柊澶辫触」这种乱码）。
// 注意：文件可能已经存在（服务重启后接着写同一天的日志），
// 所以不能只看「文件不存在」——已存在但没有 BOM 的文件同样要补上。
function ensureBom(file) {
  if (createdFiles.has(file)) return;
  createdFiles.add(file);
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '﻿', 'utf-8');
      return;
    }
    const buf = fs.readFileSync(file);
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    if (!hasBom) {
      // 补 BOM：把 BOM 放到文件开头，原内容整体后移
      fs.writeFileSync(file, Buffer.concat([Buffer.from('﻿', 'utf-8'), buf]));
    }
  } catch {
    // 补 BOM 失败不影响后续追加
  }
}

// 把一段内容写进当天的日志文件（失败不影响主流程）
export function appendLog(level, text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = logFileFor();
    ensureBom(file);
    const ts = new Date().toISOString();
    fs.appendFileSync(file, `[${ts}] [${level}] ${redact(text)}\n`, 'utf-8');
  } catch {
    // 日志失败不能影响业务（磁盘满、目录不可写等）
  }
}

// 把 Error 对象转成可读文本（含堆栈，但不吞掉原始信息）
function formatArg(a) {
  if (a instanceof Error) {
    return `${a.message}\n${a.stack || ''}`;
  }
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

// 安装日志钩子：接管 console.log / warn / error，同时写文件。
// 必须在任何业务输出之前调用（src/server.js 顶部）。
export function installFileLogger() {
  const levels = ['log', 'warn', 'error'];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      appendLog(level.toUpperCase(), args.map(formatArg).join(' '));
    };
  }
}
