// 一次性初始化：把三大运营商个人卡（手机 SIM 卡）加入余额监控
// provider=carrier_cmcc / carrier_ct / carrier_cu，走网上营业厅页面抓取
// 首次需运行 node scripts/wallet-login.mjs 完成一次网厅登录（需服务密码或短信验证码）
//
// 用法：node scripts/setup-carrier-platforms.mjs
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbFile = join(__dirname, '..', 'src', 'data', 'llm-manager.db');

const CARRIERS = [
  { name: '中国移动话费', provider: 'carrier_cmcc', url: 'https://www.10086.cn/' },
  { name: '中国电信话费', provider: 'carrier_ct',   url: 'https://www.189.cn/' },
  { name: '中国联通话费', provider: 'carrier_cu',   url: 'https://www.10010.com/' },
];

if (!existsSync(dbFile)) {
  console.error('未找到数据库，请先启动一次服务（npm run dev）再执行本脚本');
  process.exit(1);
}

const SQL = await initSqlJs();
const db = new SQL.Database(readFileSync(dbFile));

const existingRes = db.exec('SELECT name FROM platforms');
const existingNames = existingRes.length ? existingRes[0].values.map((r) => r[0]) : [];

for (const c of CARRIERS) {
  if (existingNames.includes(c.name)) {
    db.run(
      `UPDATE platforms SET provider=?, balance_type='api', balance_api_url=?, currency='CNY', threshold=20, recharge_amount=100, active=1 WHERE name=?`,
      [c.provider, c.url, c.name]
    );
    console.log('更新为运营商抓取:', c.name);
  } else {
    db.run(
      `INSERT INTO platforms (name, provider, balance_type, balance_api_url, balance_json_path, currency, threshold, recharge_amount, active)
       VALUES (?, ?, 'api', ?, '', 'CNY', 20, 100, 1)`,
      [c.name, c.provider, c.url]
    );
    console.log('新增运营商平台:', c.name);
  }
}

writeFileSync(dbFile, Buffer.from(db.export()));
console.log('数据库已更新:', dbFile);
console.log('\n下一步：');
console.log('  node scripts/wallet-login.mjs   # 逐个平台登录网厅（运营商需要输服务密码/短信验证码）');
console.log('  node scripts/wallet-check.mjs   # 无头验证抓取结果');
