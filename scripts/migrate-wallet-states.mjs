// 一次性迁移（2026-11-27 登录态隔离）：规范名平台（腾讯云/MIMO/MiniMax/音潮/火山引擎等）
// 原本所有实例共用一份登录态文件 storage_<规范名>.json；隔离后每个实例用
// storage_<规范名>_<id>.json（见 scraper_wallets.mjs storageKeyFor）。
// 本脚本把现有共用文件复制为每个存量实例的独立文件（含 .meta.json 会话元数据）：
// 存量实例立即自持登录态（读到的 cookie 与迁移前一致），此后各自重新登录互不影响。
// 幂等：独立文件已存在则跳过。运营商（carrier_*）不参与：单会话硬约束，保持共用。
// 用法：node scripts/migrate-wallet-states.mjs
import db, { initSchema } from '../src/db/index.js';
import { STORAGE_KEY_BY_NAME, STORAGE_DIR } from '../src/services/scraper_wallets.mjs';
import fs from 'node:fs';
import path from 'node:path';

await initSchema();

const rows = db.prepare('SELECT id, name, provider FROM platforms ORDER BY id').all();
let copied = 0, skipped = 0, noLegacy = 0;
for (const r of rows) {
  const canonical = STORAGE_KEY_BY_NAME[r.name];
  if (!canonical || canonical.startsWith('carrier_')) continue;
  const legacy = path.join(STORAGE_DIR, `storage_${canonical}.json`);
  const perId = path.join(STORAGE_DIR, `storage_${canonical}_${r.id}.json`);
  if (!fs.existsSync(legacy)) { noLegacy++; continue; }
  if (fs.existsSync(perId)) { skipped++; continue; }
  fs.copyFileSync(legacy, perId);
  const legacyMeta = `${legacy}.meta.json`;
  const perIdMeta = `${perId}.meta.json`;
  if (fs.existsSync(legacyMeta) && !fs.existsSync(perIdMeta)) fs.copyFileSync(legacyMeta, perIdMeta);
  copied++;
  console.log(`✓ ${r.name} #${r.id}（provider=${r.provider}）：storage_${canonical}.json → storage_${canonical}_${r.id}.json`);
}
console.log(`\n迁移完成：复制 ${copied}，已存在跳过 ${skipped}，无共用文件跳过 ${noLegacy}。`);
