// 关闭本项目的监控服务（AI 钱包余额监控）
//
// 用法：
//   node scripts/stop-server.mjs
//   node scripts/stop-server.mjs --port 3000
//   node scripts/stop-server.mjs --force     （不先尝试温和终止，直接强制结束）
//
// 设计要点（都是实测踩过的坑）：
//
// 1. 只停「这个项目自己的服务进程」，不误杀机器上别的 node 进程。
//    判定方式：进程的命令行里同时包含「server.js」与本项目目录名。
//    只靠端口判断不够——端口上可能跑的是别的东西（比如手动起的一个测试实例），
//    只靠命令行判断也不够——别的项目也可能有同名 server.js。
//
// 2. 先温和终止，再强制结束。
//    `taskkill /PID` 不带 /F 时，Windows 会尝试让进程自行退出；
//    对控制台程序往往不生效（服务是被 `start /min` 拉到独立窗口里跑的，
//    没有可接收关闭消息的主窗口），所以要带 /T 结束进程树。
//    等一段时间还在，就用 /F 强杀。
//    强杀不会丢数据：余额历史每次写入即落盘到 src/data/llm-manager.db，
//    登录态存 src/wallet-states/，都不依赖退出时的收尾动作。
//
// 3. 停完必须验证端口真的空了。
//    进程消失 ≠ 端口释放（还有子进程占着的情况）。
//    「停掉了」这句话只能在端口确认释放之后才说。

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const force = process.argv.includes('--force');

// ---- 端口：优先命令行参数，其次环境变量，再次 config.json，最后兜底 3000 ----
function resolvePort() {
  const fromArg = argValue('--port');
  if (fromArg && /^\d+$/.test(fromArg)) return Number(fromArg);
  if (process.env.LLM_MANAGER_PORT && /^\d+$/.test(process.env.LLM_MANAGER_PORT)) {
    return Number(process.env.LLM_MANAGER_PORT);
  }
  try {
    const cfg = JSON.parse(readFileSync(join(projectRoot, 'config.json'), 'utf-8'));
    if (cfg.port) return Number(cfg.port);
  } catch {
    // config.json 读不到就退回默认端口
  }
  return 3000;
}

const port = resolvePort();

// ---- 工具函数 ----

// 端口有没有被占着
function portInUse(p) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: p });
    const done = (used) => {
      sock.destroy();
      resolve(used);
    };
    sock.setTimeout(1500);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// netstat -ano 里找出监听指定端口的 PID
function pidsListeningOn(p) {
  let out = '';
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf-8', windowsHide: true });
  } catch {
    return [];
  }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (m && Number(m[1]) === p) pids.add(Number(m[2]));
  }
  return [...pids];
}

// 取进程的命令行（辅助判据）
function commandLineOf(pid) {
  try {
    const ps = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
      ],
      { encoding: 'utf-8', windowsHide: true },
    );
    return (ps || '').trim();
  } catch {
    return '';
  }
}

// 问端口上的服务「你是谁」：打一个本应用独有的接口，看返回是不是本应用的形状。
// 为什么必须这么判（实测 2026-11-21）：
//   服务是用 `start /min node src\server.js` 起的，进程命令行是**相对路径**
//   「node  src\server.js」——里面根本没有项目目录名。
//   所以「命令行里含项目路径」这条判据在真实启动方式下直接失效，
//   会把**自己项目的服务**当成别人的进程跳过（实测就踩到了）。
// 改用应用层身份来认：/api/platforms 返回的是本应用的平台数组，
// 且每个平台都带本应用特有的字段（id / provider / balance_type / threshold）。
async function identifyApp(p) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${p}/api/platforms`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, why: `接口返回 HTTP ${res.status}` };
    const data = await res.json();
    // 该接口返回的就是平台数组本身（不是 { platforms: [...] }）——
    // 第一版判据按对象写，结果把自家服务判成「不是本应用」，实测才发现。
    if (!Array.isArray(data)) {
      return { ok: false, why: '端口上的服务返回的不是本应用格式' };
    }
    // 必须是空数组或含本应用特有字段的数组
    const looksRight = data.length === 0 || data.every(
      (x) => x && typeof x === 'object' && 'id' in x && 'provider' in x && 'balance_type' in x,
    );
    if (!looksRight) {
      return { ok: false, why: '端口上的服务返回的不是本应用格式' };
    }
    return { ok: true, why: '', platforms: data.length };
  } catch (e) {
    return { ok: false, why: `接口探测失败：${e.message}` };
  }
}

// 是不是「本项目的服务进程」
// 判定链（任一环节不成立就不杀）：
//   ① 端口上的服务确实是本应用（identifyApp）
//   ② 监听该端口的进程是 node.exe
//   ③ 命令行里提到 server.js（辅助确认，不作为唯一依据——见上方实测记录）
function classify(pid, appIdentified) {
  const cmd = commandLineOf(pid);
  if (!cmd) return { ok: false, cmd, why: '读不到命令行（进程可能已退出）' };
  const low = cmd.toLowerCase();
  if (!/node(\.exe)?/i.test(cmd)) {
    return { ok: false, cmd, why: '不是 node 进程' };
  }
  if (!/server\.js/i.test(cmd)) {
    return { ok: false, cmd, why: '命令行里没有 server.js' };
  }
  if (!appIdentified) {
    return { ok: false, cmd, why: '端口上的服务不是本应用' };
  }
  return { ok: true, cmd, why: '' };
}

function taskkill(pid, forceIt) {
  const args = ['/PID', String(pid), '/T'];
  if (forceIt) args.push('/F');
  try {
    execFileSync('taskkill', args, { encoding: 'utf-8', windowsHide: true, stdio: 'pipe' });
    return { ok: true };
  } catch {
    // 不转发 taskkill 的原始输出：它是 GBK 编码，转到 UTF-8 终端全是乱码
    // （实测 2026-11-21：「成功: 已终止 PID...」显示成「�ɹ�: ����...」）。
    // 只保留「成功/失败」这个事实，细节由后续的存活检查来判定。
    return { ok: false };
  }
}

function pidAlive(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      encoding: 'utf-8', windowsHide: true, stdio: 'pipe',
    });
    // tasklist 找不到时输出的是「信息: 没有找到任何...」之类的提示，不含 PID
    return new RegExp(`\\s${pid}\\s`).test(out);
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 主流程 ----
console.log(`[stop] 项目目录：${projectRoot}`);
console.log(`[stop] 目标端口：${port}`);

if (!(await portInUse(port))) {
  console.log(`[stop] 端口 ${port} 空闲，服务本来就没在运行。`);
  process.exit(0);
}

// 端口上监听的 PID
const candidates = pidsListeningOn(port);

if (candidates.length === 0) {
  console.log(`[stop] 端口 ${port} 显示被占用，但没查到监听它的 PID。`);
  console.log('[stop] 可手动执行：');
  console.log(`[stop]   netstat -ano | findstr :${port}`);
  console.log(`[stop]   taskkill /PID <PID> /T`);
  process.exit(2);
}

let stopped = 0;
let skipped = 0;

// 先问端口上的服务是谁——这是本次改动的核心：不再依赖命令行里的路径
const app = await identifyApp(port);
if (app.ok) {
  console.log(`[stop] 端口 ${port} 上确认是本应用（/api/platforms 返回 ${app.platforms} 个平台）。`);
} else {
  console.log(`[stop] 端口 ${port} 上的服务不是本应用：${app.why}`);
  console.log('[stop] 不做任何操作，避免误杀别的程序。');
  console.log('[stop] 若确认就是要停它，可手动执行：');
  console.log(`[stop]   netstat -ano | findstr :${port}`);
  console.log(`[stop]   taskkill /PID <PID> /T /F`);
  process.exit(2);
}

for (const pid of candidates) {
  const verdict = classify(pid, app.ok);
  if (!verdict.ok) {
    console.log(`[stop] 跳过 PID ${pid}：${verdict.why}`);
    console.log(`[stop]   命令行：${verdict.cmd || '(未知)'}`);
    skipped++;
    continue;
  }
  console.log(`[stop] 命中服务进程 PID ${pid}：${verdict.cmd}`);

  if (!force) {
    const first = taskkill(pid, false);
    if (!first.ok) {
      console.log('[stop]   温和终止未生效（服务是无窗口后台进程，收不到关闭消息）');
    }
    // 等它自己退
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      if (!pidAlive(pid)) break;
    }
  }
  if (pidAlive(pid)) {
    console.log('[stop]   仍在运行，改为强制结束（/F）');
    const second = taskkill(pid, true);
    if (!second.ok) console.log('[stop]   强制结束未成功');
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      if (!pidAlive(pid)) break;
    }
  }
  if (pidAlive(pid)) {
    console.log(`[stop]   PID ${pid} 依然存在，终止未成功。`);
    skipped++;
  } else {
    console.log(`[stop]   PID ${pid} 已结束。`);
    stopped++;
  }
}

// ---- 验证：端口真的空了吗 ----
let released = false;
for (let i = 0; i < 20; i++) {
  if (!(await portInUse(port))) { released = true; break; }
  await sleep(250);
}

console.log('');
if (released) {
  console.log(`[stop] 完成：已结束 ${stopped} 个服务进程，端口 ${port} 已释放。`);
  console.log('[stop] 提醒：定时巡检与运营商保活也随之停止；下次启动会自动巡检一轮。');
  process.exit(0);
}

console.log(`[stop] 未完全成功：端口 ${port} 仍被占用。`);
console.log(`[stop] 已结束 ${stopped} 个进程，跳过 ${skipped} 个。`);
console.log('[stop] 可手动查：netstat -ano | findstr :' + port);
process.exit(1);
