// 一次性迁移：把「浏览器抓取型」平台接上官方余额 API（balance_type='api_scrape'）
//
// 背景（2026-11-25 核实各平台官方文档后）：
//   页面上那批抓取型平台里，多数其实都有官方余额接口：
//     Kimi/月之暗面 GET  api.moonshot.cn/v1/users/me/balance  → data.available_balance（元）
//     小米MiMo      GET  api.xiaomimimo.com/v1/platform/balance → balance_infos[0].total_available（元）
//     腾讯云       POST billing.tencentcloudapi.com DescribeAccountBalance → Response.RealBalance（分→元）
//     阿里云       GET  business.aliyuncs.com QueryAccountBalance → Data.AvailableAmount（元）
//     火山引擎     GET  billing.volcengineapi.com QueryBalanceAcct → Result.AvailableBalance（元）
//     智谱         GET  open.bigmodel.cn 控制台内部接口（非公开）→ data.balance（元）
//   抓取依赖浏览器 + 登录态，会失效、会弹窗；官方接口不会。
//   所以改成「官方接口优先，查不到再退回抓取」（balance_type='api_scrape'）。
//
// 两个不动的：
//   MiniMax —— 官方接口 /v1/token_plan/remains 返回的是「剩余请求次数」，不是金额，
//               量纲和抓取到的「可用额度（元）」不同，混用会污染余额曲线，所以保持纯抓取。
//   音潮开放平台 —— 官方文档站没有账户/余额接口，没有 API 可接，保持纯抓取。
//
// 重要：改 provider 不会丢登录态。
//   登录态文件名由 storageKeyFor(name, provider, id) 决定，而它**先查平台名映射**
//   （STORAGE_KEY_BY_NAME）：腾讯云→tencent、MIMO→mimo、Kimi→kimi、阿里云→bailian、
//   MiniMax→minimax、火山引擎→volc、智谱AI→（无映射，走 zhipu_<id>）。
//   这些登录态文件都已存在（storage_tencent.json / storage_mimo.json / storage_kimi.json …），
//   所以改 provider 字段不改变登录态文件的定位。
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbFile = join(__dirname, '..', 'src', 'data', 'llm-manager.db');

// 平台名 → 官方 API 配置
const API_TARGETS = [
  {
    name: 'Kimi',
    provider: 'moonshot',
    api_url: 'https://api.moonshot.cn/v1/users/me/balance',
    api_json_path: 'data.available_balance',
    same_account_note: 'moonshot',
  },
  {
    name: 'MIMO',
    provider: 'mimo',
    api_url: 'https://api.xiaomimimo.com/v1/platform/balance',
    api_json_path: 'balance_infos[0].total_available',
  },
  {
    name: '腾讯云',
    provider: 'tencent',
    api_url: 'https://billing.tencentcloudapi.com',
    api_json_path: 'Response.RealBalance',
  },
  {
    name: '阿里云',
    provider: 'dashscope',
    api_url: 'https://business.aliyuncs.com',
    api_json_path: 'Data.AvailableAmount',
  },
  {
    name: '火山引擎',
    provider: 'volcengine',
    api_url: 'https://billing.volcengineapi.com',
    api_json_path: 'Result.AvailableBalance',
  },
  {
    name: '智谱AI',
    provider: 'zhipu',
    api_url: 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report',
    api_json_path: 'data.balance',
  },
];

// 同一账户分组：同一账户余额被多个实例监控时，标上分组键，
// 界面显示「与「月之暗面」同一账户余额」，且只生成一张充值单。
// moonshot：id=13「月之暗面」与 id=16「Kimi」都查 api.moonshot.cn/v1/users/me/balance
//   （已由用户确认是同一个账户：Kimi 官方文档给的余额接口就是这个地址）
// 注意：id=12「火山引擎API」与 id=19「火山引擎」虽然都指向火山引擎费用中心，
//   但没有证据证明是同一个账户（主账号 vs 子账号都可能），所以不归组——
//   归错了会漏掉真正需要的充值提醒。
const SAME_ACCOUNT = {
  月之暗面: 'moonshot',
  Kimi: 'moonshot',
};

// Kimi 的官方接口用的就是 env.kimi 里的那把 Key（Kimi 官方文档给的就是
// api.moonshot.cn/v1/users/me/balance，实测同一把 Key 通用）。
function readMoonshotKey() {
  const envFile = join(__dirname, '..', 'env.kimi');
  if (!existsSync(envFile)) return null;
  const m = readFileSync(envFile, 'utf-8').match(/^MOONSHOT_API_KEY=(.+)$/m);
  return m ? m[1].trim() : null;
}

const SQL = await initSqlJs();
const db = new SQL.Database(readFileSync(dbFile));

// 自己补齐新增的列（不依赖服务先启动——sql.js 的 schema 迁移在服务启动时才跑）
// 幂等：列已存在就跳过。
function ensureColumn(table, column, type) {
  const cols = db.exec(`PRAGMA table_info(${table})`);
  const names = cols.length ? cols[0].values.map((r) => r[1]) : [];
  if (names.includes(column)) return false;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  console.log(`已新增列 ${table}.${column}`);
  return true;
}
ensureColumn('platforms', 'same_account_note', 'TEXT');
ensureColumn('platforms', 'api_url', 'TEXT');
ensureColumn('platforms', 'api_json_path', 'TEXT');
ensureColumn('platforms', 'balance_source', 'TEXT');

const names = db.exec('SELECT name FROM platforms')[0].values.map((r) => r[0]);

for (const t of API_TARGETS) {
  if (!names.includes(t.name)) {
    console.log(`跳过（平台不存在）：${t.name}`);
    continue;
  }
  const setParts = [
    'provider=?',
    "balance_type='api_scrape'",
    'api_url=?',
    'api_json_path=?',
  ];
  const params = [t.provider, t.api_url, t.api_json_path];
  if (t.same_account_note) {
    setParts.push('same_account_note=?');
    params.push(t.same_account_note);
  }
  db.run(
    `UPDATE platforms SET ${setParts.join(', ')} WHERE name=?`,
    [...params, t.name]
  );
  console.log(`已接官方 API：${t.name} → provider=${t.provider}, balance_type=api_scrape`);
}

// 同一账户分组（不限平台类型，两个实例都要标上）
for (const [name, group] of Object.entries(SAME_ACCOUNT)) {
  if (!names.includes(name)) continue;
  db.run('UPDATE platforms SET same_account_note=? WHERE name=?', [group, name]);
  console.log(`同一账户标注：${name} → ${group}`);
}

// Kimi 实例补上 API Key（从 env.kimi 读，不写进任何被提交的文件）
const kimiKey = readMoonshotKey();
if (kimiKey && names.includes('Kimi')) {
  db.run('UPDATE platforms SET api_key=? WHERE name=?', [kimiKey, 'Kimi']);
  console.log('已为「Kimi」写入 API Key（取自 env.kimi）');
} else if (!kimiKey) {
  console.log('未找到 env.kimi，「Kimi」的 API Key 未写入（可在界面手动填）');
}

writeFileSync(dbFile, Buffer.from(db.export()));
console.log('数据库已更新:', dbFile);

// 回读确认
console.log('\n--- 回读 ---');
const res = db.exec(
  "SELECT id, name, provider, balance_type, api_url, same_account_note, " +
  "(api_key IS NOT NULL AND api_key<>'') AS has_key FROM platforms ORDER BY id"
);
for (const row of res[0].values) {
  const o = {};
  res[0].columns.forEach((c, i) => { o[c] = row[i]; });
  console.log(JSON.stringify(o));
}
