// 一次性初始化：把三大运营商个人卡（手机 SIM 卡）加入余额监控
// provider=carrier_cmcc / carrier_ct / carrier_cu，走网上营业厅页面抓取
// 首次需运行 node scripts/wallet-login.mjs 完成一次网厅登录（需服务密码或短信验证码）
//
// 用法：node scripts/setup-carrier-platforms.mjs [--only cmcc|ct|cu]
//
// 写入通道说明（重要）：
// 服务用 sql.js，数据库整个读进内存、每次写操作把全库覆盖写回文件。
// 因此「服务运行中」时直接改数据库文件会被服务的下一次落盘抹掉。
// 本脚本检测到服务在跑就走 HTTP API（服务自己的内存就是权威副本），
// 服务没跑才直接改文件。
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbFile = join(__dirname, '..', 'src', 'data', 'llm-manager.db');
const ROOT = join(__dirname, '..');

const CARRIERS = [
  // 移动：首页「服务专区 → 余额查询」直达地址（实测 2026-11-20）
  { key: 'cmcc', name: '中国移动话费', provider: 'carrier_cmcc', url: 'https://shop.10086.cn/i/?f=home' },
  { key: 'ct',   name: '中国电信话费', provider: 'carrier_ct',   url: 'https://www.189.cn/' },
  { key: 'cu',   name: '中国联通话费', provider: 'carrier_cu',   url: 'https://www.10010.com/' },
];

// 只初始化指定运营商（--only cmcc），默认三家全上
const onlyIdx = process.argv.indexOf('--only');
const targets = onlyIdx >= 0
  ? CARRIERS.filter((c) => c.key === process.argv[onlyIdx + 1])
  : CARRIERS;
if (!targets.length) {
  console.error('--only 参数无效，可选：cmcc / ct / cu');
  process.exit(1);
}

// 服务端口：config.json 的 port，默认 3000
function servicePort() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
    return Number(cfg.port) || 3000;
  } catch {
    return 3000;
  }
}
const PORT = servicePort();
const BASE = `http://127.0.0.1:${PORT}`;

// 服务是否在跑（能列出平台即认为在跑）
async function serviceAlive() {
  try {
    const res = await fetch(`${BASE}/api/platforms`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// 走服务 API 写入：POST 新建 / PUT 更新
async function writeViaService(c) {
  const list = await (await fetch(`${BASE}/api/platforms`)).json();
  const existing = list.find((p) => p.name === c.name);
  const body = {
    name: c.name,
    provider: c.provider,
    balance_type: 'api',
    balance_api_url: c.url,
    balance_json_path: null,
    currency: 'CNY',
    threshold: 20,
    recharge_amount: 100,
    target_amount: null,
    active: 1,
  };
  if (existing) {
    await fetch(`${BASE}/api/platforms/${existing.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log('更新为运营商抓取:', c.name, `(id=${existing.id})`);
  } else {
    const res = await fetch(`${BASE}/api/platforms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    console.log('新增运营商平台:', c.name, `(id=${json.id})`);
  }
}

async function main() {
  if (await serviceAlive()) {
    console.log(`检测到服务在 ${BASE} 运行，走服务 API 写入（避免直接改库被服务落盘覆盖）\n`);
    for (const c of targets) await writeViaService(c);
  } else {
    if (!existsSync(dbFile)) {
      console.error('未找到数据库，请先启动一次服务（npm run dev）再执行本脚本');
      process.exit(1);
    }
    console.log('服务未运行，直接写数据库文件\n');
    const SQL = await initSqlJs();
    const db = new SQL.Database(readFileSync(dbFile));
    const existingRes = db.exec('SELECT name FROM platforms');
    const existingNames = existingRes.length ? existingRes[0].values.map((r) => r[0]) : [];
    for (const c of targets) {
      if (existingNames.includes(c.name)) {
        db.run(
          `UPDATE platforms SET provider=?, balance_type='api', balance_api_url=?, balance_json_path=NULL, currency='CNY', threshold=20, recharge_amount=100, active=1 WHERE name=?`,
          [c.provider, c.url, c.name]
        );
        console.log('更新为运营商抓取:', c.name);
      } else {
        db.run(
          `INSERT INTO platforms (name, provider, balance_type, balance_api_url, balance_json_path, currency, threshold, recharge_amount, active)
           VALUES (?, ?, 'api', ?, NULL, 'CNY', 20, 100, 1)`,
          [c.name, c.provider, c.url]
        );
        console.log('新增运营商平台:', c.name);
      }
    }
    writeFileSync(dbFile, Buffer.from(db.export()));
    console.log('数据库已更新:', dbFile);
  }
  console.log('\n下一步：');
  console.log('  node scripts/wallet-login.mjs   # 逐个平台登录网厅（运营商需要输服务密码/短信验证码）');
  console.log('  node scripts/wallet-check.mjs   # 无头验证抓取结果');
}

await main();
