// 抓取验证脚本：从数据库读取浏览器抓取型平台配置，无头浏览器逐个抓取余额并打印
// 覆盖两类：balance_type='scrape' 的钱包平台，以及 provider LIKE 'carrier_%' 的三大运营商网厅
// 用法：node scripts/wallet-check.mjs [平台名]
import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrapeWalletsBatch, parseScrapeRule, storageFileFor, enrichRuleWithBuiltin, CARRIER_ENTRY_URLS } from '../src/services/scraper_wallets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbFile = join(__dirname, '..', 'src', 'data', 'llm-manager.db');

const only = process.argv[2] || null;

const SQL = await initSqlJs();
const db = new SQL.Database(readFileSync(dbFile));

const res = db.exec(
  "SELECT id, name, provider, balance_api_url, balance_json_path FROM platforms " +
  "WHERE (balance_type IN ('scrape','api_scrape') OR provider LIKE 'carrier_%') AND active=1"
);
if (!res.length) {
  console.log('数据库中没有浏览器抓取型平台，请先运行 node scripts/setup-wallet-platforms.mjs 或 node scripts/setup-carrier-platforms.mjs');
  process.exit(1);
}

let tasks = res[0].values
  .map((r) => {
    const [id, name, provider, url, jsonPath] = r;
    // 运营商平台可以没填 balance_api_url（如「移动副卡」这类自定义名平台），用内置网厅入口兜底
    const entryUrl = url || CARRIER_ENTRY_URLS[provider];
    if (!entryUrl) return null;
    // 运营商平台用内置规则（候选标签组 + 网厅菜单入口），与运行时一致
    const rule = enrichRuleWithBuiltin(parseScrapeRule(jsonPath), name, provider);
    return {
      url: entryUrl,
      rule,
      debugLabel: name,
      // 登录态文件按「账号」唯一：同运营商的多个号码各用各的文件（传入平台 id）
      storageFile: storageFileFor(name, provider, id),
    };
  })
  .filter(Boolean);

if (only) tasks = tasks.filter((t) => t.debugLabel === only);
if (!tasks.length) {
  console.log('没有匹配的平台');
  process.exit(1);
}

const missing = tasks.filter((t) => !t.storageFile);
if (missing.length) {
  console.log('以下平台缺少登录态文件，登录后才有余额：');
  for (const m of missing) console.log('  - ' + m.debugLabel);
  console.log('');
}

console.log('开始无头抓取 ' + tasks.length + ' 个平台（约需 1-2 分钟）...\n');
const results = await scrapeWalletsBatch(tasks);
let okCount = 0;
for (const r of results) {
  if (r.ok) {
    okCount++;
    console.log('OK   ' + r.label + ' : ' + r.balance);
  } else {
    console.log('FAIL ' + r.label + ' : ' + r.error);
  }
}
console.log('\n成功 ' + okCount + '/' + results.length);
