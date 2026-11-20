#!/usr/bin/env node
// 端到端冒烟测试：自动启动隔离实例（临时数据库 + 空闲端口），跑完自动清理，不碰真实数据。
//
// 用法：
//   npm test                              # 自动选空闲端口 + 系统临时目录建库
//   node scripts/test-smoke.mjs --port 3931
//
// 覆盖：平台创建/删除、密钥掩码、数值校验、充值单状态机（pending→notified→paid→credited）、
//       打款基准线快照、到账自动检测、撤销打款、停用平台刷新、删除级联清理、智谱 token 脚本。
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const argPortIdx = process.argv.indexOf('--port');
const argPort = argPortIdx > 0 ? Number(process.argv[argPortIdx + 1]) : null;

async function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start) {
  for (let p = start; p < start + 20; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`端口 ${start}~${start + 19} 全部被占用`);
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? `   [${detail}]` : ''}`);
}

const port = argPort || (await findFreePort(3931));
const base = `http://127.0.0.1:${port}`;
const dbDir = mkdtempSync(join(tmpdir(), 'llm-smoke-'));

// 测试实例环境变量：隔离端口 + 隔离数据库 + 关闭桌面弹窗
// 登录态目录也隔离：否则开发机上真实存在的登录态文件会让「未登录」用例失真
const walletStateDir = mkdtempSync(join(tmpdir(), 'llm-smoke-wallet-'));
process.env.LLM_MANAGER_PORT = String(port);
process.env.LLM_MANAGER_DATA_DIR = dbDir;
process.env.LLM_MANAGER_WALLET_STATE_DIR = walletStateDir;
process.env.LLM_MANAGER_NO_DESKTOP_ALERT = '1';

console.log(`测试实例：${base}（数据库 ${dbDir}）\n`);

const child = spawn(process.execPath, [join(PROJECT_ROOT, 'src', 'server.js')], {
  cwd: PROJECT_ROOT,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => (childLog += d));
child.stderr.on('data', (d) => (childLog += d));

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, ok: res.ok, json };
}

let exitCode = 1;
try {
  // ===== 0. 服务就绪 =====
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try { if ((await fetch(`${base}/api/platforms`)).ok) ready = true; } catch { /* 尚未启动 */ }
  }
  check('服务就绪（临时库 + 测试端口）', ready);
  if (!ready) throw new Error('服务未就绪，子进程输出：\n' + childLog.slice(-2000));

  // ===== 1. 平台创建与密钥掩码 =====
  const created = await api('POST', '/api/platforms', {
    // balance_type=manual：巡检刷新读历史余额，不依赖真实接口，适合状态机测试
    name: '冒烟测试平台', provider: 'generic', balance_type: 'manual',
    api_key: 'sk-secret-123', currency: 'USD', threshold: 200, recharge_amount: 500,
  });
  check('创建平台', created.ok && Number.isFinite(created.json?.id), `id=${created.json?.id}`);
  const pid = created.json.id;

  const detail = await api('GET', `/api/platforms/${pid}`);
  check('详情接口密钥掩码', detail.ok
    && detail.json?.api_key === '••••••••'
    && detail.json?.has_api_key === true
    && !JSON.stringify(detail.json).includes('sk-secret-123'));

  // ===== 2. 数值字段校验 =====
  const v1 = await api('POST', '/api/platforms', { name: '坏阈值', threshold: 'abc' });
  check('threshold 非数值被拒绝', v1.status === 400, `status=${v1.status}`);
  const v2 = await api('POST', '/api/platforms', { name: '注入测试', threshold: '<img src=x onerror=alert(1)>' });
  check('threshold 注入串被拒绝', v2.status === 400, `status=${v2.status}`);
  const v3 = await api('POST', `/api/platforms/${pid}/balance`, { balance: 'abc' });
  check('balance 非数值被拒绝', v3.status === 400, `status=${v3.status}`);

  // ===== 3. 充值单状态机 =====
  const b1 = await api('POST', `/api/platforms/${pid}/balance`, { balance: 100 });
  check('手动录入余额 100', b1.ok);
  // 平台表不存 balance，最新余额在 balance_history；详情/列表均无 balance 字段
  const d2 = await api('GET', `/api/platforms/${pid}/history`);
  check('平台余额已更新（历史最新=100）', Array.isArray(d2.json) && d2.json.length > 0 && Number(d2.json[0].balance) === 100, `latest=${d2.json?.[0]?.balance}`);

  const mr = await api('POST', '/api/monitor/run');
  check('手动巡检触发', mr.ok);
  let o1 = (await api('GET', '/api/orders')).json?.find((o) => o.platform_id === pid);
  check('低余额自动生成充值单', !!o1, `status=${o1?.status}`);
  if (o1 && o1.status === 'pending') await api('POST', `/api/orders/${o1.id}/notify`);
  o1 = o1 ? (await api('GET', '/api/orders')).json.find((o) => o.id === o1.id) : null;
  check('订单流转到已通知', o1?.status === 'notified', `status=${o1?.status}`);

  const paid = await api('POST', `/api/orders/${o1.id}/paid`);
  check('登记打款', paid.ok);
  o1 = (await api('GET', '/api/orders')).json.find((o) => o.id === o1.id);
  check('打款快照基准 balance_at_paid=100', o1?.status === 'paid' && Number(o1?.balance_at_paid) === 100, `at_paid=${o1?.balance_at_paid}`);

  const paidAgain = await api('POST', `/api/orders/${o1.id}/paid`);
  check('重复登记打款被拒绝', paidAgain.status === 400, `status=${paidAgain.status}`);

  // 到账判定条件是 r.balance > before + amount*0.5（粗略防误判）：
  // amount=500、基准=100，需要余额 >350，此处给 700
  await api('POST', `/api/platforms/${pid}/balance`, { balance: 700 });
  const credit = await api('POST', `/api/orders/${o1.id}/credit`);
  check('余额上涨自动确认到账', credit.ok, credit.json?.error || '');
  o1 = (await api('GET', '/api/orders')).json.find((o) => o.id === o1.id);
  check('订单状态 credited', o1?.status === 'credited', `status=${o1?.status}`);

  const fund = await api('GET', '/api/fund');
  check('累计充值计入统计 500', Number(fund.json?.total_recharged) === 500, `total_recharged=${fund.json?.total_recharged}`);

  // ===== 4. 撤销打款 =====
  await api('POST', `/api/platforms/${pid}/balance`, { balance: 50 });
  await api('POST', '/api/monitor/run');
  let o2 = (await api('GET', '/api/orders')).json?.find((o) => o.platform_id === pid && o.status !== 'credited');
  check('再次低余额生成新充值单', !!o2, `id=${o2?.id}`);
  if (o2 && o2.status === 'pending') await api('POST', `/api/orders/${o2.id}/notify`);
  if (o2) await api('POST', `/api/orders/${o2.id}/paid`);
  const unmarked = o2 ? await api('POST', `/api/orders/${o2.id}/unmark-paid`) : null;
  check('撤销打款回到已通知', unmarked?.ok && unmarked.json?.status === 'notified', `status=${unmarked?.json?.status}`);

  // ===== 5. 停用平台刷新（不得崩溃，须返回结构化失败） =====
  const dis = await api('PUT', `/api/platforms/${pid}`, { active: false });
  check('停用平台', dis.ok);
  const rf = await api('POST', `/api/platforms/${pid}/refresh`);
  check('停用平台刷新返回结构化失败', rf.json?.ok === false, JSON.stringify(rf.json || {}).slice(0, 100));

  // ===== 6. 删除平台级联清理 =====
  const del = await api('DELETE', `/api/platforms/${pid}`);
  check('删除平台', del.ok);
  const ordersAfter = (await api('GET', '/api/orders')).json;
  check('充值单级联清理', Array.isArray(ordersAfter) && ordersAfter.length === 0, `len=${ordersAfter?.length}`);
  const hist = await api('GET', `/api/platforms/${pid}/history`);
  check('余额历史级联清理', hist.ok && Array.isArray(hist.json) && hist.json.length === 0, `len=${hist.json?.length}`);

  // ===== 7. 智谱 token 脚本（复用同一测试实例） =====
  const zhipu = await import('./zhipu-token-refresh.mjs');
  const zc = await api('POST', '/api/platforms', {
    name: '智谱测试平台', provider: 'zhipu', balance_type: 'api',
    api_key: 'model-key-x', api_key_secret: 'fake.jwt.token', threshold: 200,
  });
  check('创建智谱平台', zc.ok && Number.isFinite(zc.json?.id), `id=${zc.json?.id}`);
  const zid = zc.json.id;

  const auto = await zhipu.findZhipuPlatform();
  check('脚本按名称自动定位智谱平台', auto?.id === zid, `found=${auto?.id} ${auto?.name}`);
  const explicit = await zhipu.findZhipuPlatform('智谱测试平台');
  check('脚本显式名称定位', explicit?.id === zid);
  let missMsg = '';
  try { await zhipu.findZhipuPlatform('不存在平台'); } catch (e) { missMsg = e.message; }
  check('未找到时报错并列出现有平台', missMsg.includes('未找到平台') && missMsg.includes('智谱测试平台'));

  const zr = await api('POST', `/api/platforms/${zid}/refresh`);
  check('假 Token 刷新报 Token 失效（证实读 api_key_secret）',
    typeof zr.json?.error === 'string' && zr.json.error.includes('Token 已失效'),
    String(zr.json?.error || '').slice(0, 60));
  const zd = await api('GET', `/api/platforms/${zid}`);
  check('智谱平台两把密钥均掩码', zd.json?.api_key === '••••••••' && zd.json?.api_key_secret === '••••••••'
    && zd.json?.has_api_key === true && zd.json?.has_api_key_secret === true);
  await api('DELETE', `/api/platforms/${zid}`);

  // ===== 8. 三大运营商个人卡（无登录态时的可读失败） =====
  const cc = await api('POST', '/api/platforms', {
    name: '运营商冒烟测试', provider: 'carrier_cmcc', balance_type: 'api',
    balance_api_url: 'https://www.10086.cn/', currency: 'CNY', threshold: 20, recharge_amount: 100,
  });
  check('创建运营商平台', cc.ok && Number.isFinite(cc.json?.id), `id=${cc.json?.id}`);
  const cid = cc.json.id;

  const cLogin = await api('GET', `/api/platforms/${cid}/login-state`);
  check('运营商平台登录态检测接口可用', cLogin.ok && cLogin.json?.exists === false && cLogin.json?.key === 'carrier_cmcc',
    `exists=${cLogin.json?.exists} key=${cLogin.json?.key}`);

  const cRefresh = await api('POST', `/api/platforms/${cid}/refresh`);
  check('未登录时刷新返回结构化失败（不是 500）', cRefresh.json?.ok === false, JSON.stringify(cRefresh.json || {}).slice(0, 120));
  check('未登录错误提示可读且指向登录脚本',
    typeof cRefresh.json?.error === 'string' && cRefresh.json.error.includes('wallet-login.mjs') && cRefresh.json.error.includes('carrier_cmcc'),
    String(cRefresh.json?.error || '').slice(0, 80));

  const cOrders = (await api('GET', '/api/orders')).json?.filter((o) => o.platform_id === cid);
  check('抓取失败不生成充值单', Array.isArray(cOrders) && cOrders.length === 0, `len=${cOrders?.length}`);

  const cHist = await api('GET', `/api/platforms/${cid}/history`);
  check('抓取失败不写入余额历史', cHist.ok && Array.isArray(cHist.json) && cHist.json.length === 0, `len=${cHist.json?.length}`);

  await api('DELETE', `/api/platforms/${cid}`);

  // ===== 9. 收尾：测试数据清零 =====
  const fin = await api('GET', '/api/platforms');
  check('测试平台全部清理', Array.isArray(fin.json) && fin.json.length === 0, `len=${fin.json?.length}`);

  exitCode = 0;
} catch (err) {
  console.error('\n测试中途异常：', err.message);
  exitCode = 1;
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
}

const fail = results.filter((r) => !r.pass);
console.log(`\n结果：共 ${results.length} 项，通过 ${results.length - fail.length}，失败 ${fail.length}`);
if (fail.length) {
  console.log('失败项：');
  for (const f of fail) console.log('  - ' + f.name);
}
process.exit(exitCode);
