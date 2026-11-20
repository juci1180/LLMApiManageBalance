// 智谱 Token 自动续期脚本
// 用法：
//   1. 更新 token：node scripts/zhipu-token-refresh.mjs --token "eyJ..."  （验证并写入平台+刷新余额）
//   2. 自检：node scripts/zhipu-token-refresh.mjs（或 --token-file config\zhipu-token.txt）
//   注意：账密直连登录被智谱验证码墙挡住（loginType=password 返回「请完成安全验证」，需数美滑块），
//   无法全自动换 token；token 过期时需人工从浏览器复制一次。
//   3. 定时任务示例（每天 9 点用 token 方式自检，路径按实际安装位置替换）：
//      schtasks /create /tn "zhipu-token" /tr "node <项目绝对路径>\scripts\zhipu-token-refresh.mjs --token-file <项目绝对路径>\config\zhipu-token.txt" /sc daily /st 09:00
// ponytail: 已知天花板——账密直连登录被智谱服务端禁用（cusLoginGranter null，疑似必须数美验证码/设备指纹），
//           因此无法全自动无头换 token；token 触发 401 后需人工从浏览器复制一次新 token。
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const cfgDir = join(PROJECT_ROOT, 'config');
mkdirSync(cfgDir, { recursive: true });
const tokenFile = join(cfgDir, 'zhipu-token.txt');

// 解析参数
const args = process.argv.slice(2);
const getArg = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};

const BALANCE_URL = 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report';

// 服务地址：端口从 config.json 读，与 src/server.js 保持一致
export function baseUrl() {
  let port = 3000;
  try {
    const cfg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'config.json'), 'utf-8'));
    if (cfg.port) port = cfg.port;
  } catch {}
  return `http://127.0.0.1:${port}`;
}

// 智谱平台不按固定 id 找（平台会随增删变动 id），而是按名称/匹配 provider 定位
const ZHIPU_NAME_PATTERNS = [/智谱/i, /bigmodel/i, /zhipu/i];

async function fetchPlatforms() {
  const res = await fetch(`${baseUrl()}/api/platforms`);
  if (!res.ok) throw new Error(`读取平台列表失败: HTTP ${res.status}（服务是否已启动？）`);
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

export async function findZhipuPlatform(explicitName) {
  const list = await fetchPlatforms();
  if (explicitName) {
    const hit = list.find((p) => p.name === explicitName);
    if (hit) return hit;
    throw new Error(`未找到平台「${explicitName}」。现有平台：${list.map((p) => p.name).join('、') || '（空）'}`);
  }
  const byName = list.find((p) => ZHIPU_NAME_PATTERNS.some((re) => re.test(p.name || '')));
  if (byName) return byName;
  const byProvider = list.find((p) => p.provider === 'zhipu');
  if (byProvider) return byProvider;
  throw new Error('未找到智谱平台（按名称含「智谱」或 provider=zhipu 匹配）。'
    + '请在页面「添加平台」创建智谱平台，或用 --platform <名称> 指定。');
}

async function checkToken(token) {
  const r = await fetch(BALANCE_URL, {
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'Mozilla/5.0' },
  });
  const body = await r.json().catch(() => ({}));
  // 1001/401 = token 失效；code 200 = 有效
  if (body.code === 200 && body.data) {
    return { ok: true, balance: body.data.balance ?? body.data.availableBalance };
  }
  return { ok: false, code: body.code, msg: body.msg };
}

async function writePlatform(token, explicitName) {
  const platform = await findZhipuPlatform(explicitName);
  // 写入 api_key_secret（控制台登录 Token）并刷新余额
  const put = await fetch(`${baseUrl()}/api/platforms/${platform.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key_secret: token }),
  });
  if (!put.ok) throw new Error('更新平台失败: ' + put.status);
  const rf = await fetch(`${baseUrl()}/api/platforms/${platform.id}/refresh`, { method: 'POST' });
  const res = await rf.json();
  writeFileSync(tokenFile, token);
  return { platform: platform.name, platformId: platform.id, refresh: res };
}

// 仅当直接执行本文件时才跑 CLI（被 import 时只导出函数，方便测试）
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) await main();

async function main() {
const mode = args[0];
if (mode === '--token' || getArg('--token')) {
  const token = mode === '--token' ? args[1] : getArg('--token');
  const c = await checkToken(token);
  if (!c.ok) {
    console.error('Token 无效:', c);
    process.exit(1);
  }
  console.log('Token 有效，余额:', c.balance);
  const res = await writePlatform(token, getArg('--platform'));
  console.log(`已写入平台「${res.platform}」(id=${res.platformId}) 并刷新:`, JSON.stringify(res.refresh));
} else if (getArg('--token-file')) {
  const f = getArg('--token-file');
  if (!existsSync(f)) { console.error('token 文件不存在:', f); process.exit(1); }
  const token = readFileSync(f, 'utf-8').trim();
  const c = await checkToken(token);
  if (!c.ok) {
    console.error('Token 已失效（code=' + c.code + '）。请重新登录智谱控制台，从 DevTools 复制新 token 后运行:');
    console.error('  node scripts/zhipu-token-refresh.mjs --token "新token"');
    process.exit(2);
  }
  console.log('Token 仍有效，余额:', c.balance);
} else {
  console.log('用法:');
  console.log('  自检:  node scripts/zhipu-token-refresh.mjs --token-file config\\zhipu-token.txt');
  console.log('  更新:  node scripts/zhipu-token-refresh.mjs --token "eyJ..."');
  console.log('  指定平台: node scripts/zhipu-token-refresh.mjs --token "eyJ..." --platform "智谱AI"');
  // 默认执行自检
  if (existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, 'utf-8').trim();
    const c = await checkToken(token);
    console.log(c.ok ? '当前 token 有效，余额: ' + c.balance : 'token 已失效: ' + JSON.stringify(c));
  }
}
}
