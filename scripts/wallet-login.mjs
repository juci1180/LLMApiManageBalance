// 一次性登录脚本（storageState 方案，参照 E:\ai-wallet-monitor-portable\login.js）
// 弹出浏览器窗口，逐个平台等你登录；登录成功后自动把登录态(cookie+localStorage)
// 导出到 src/wallet-states/storage_<key>.json，之后定时巡检无头加载该文件即可。
// 用法：
//   node scripts/wallet-login.mjs            # 登录数据库里全部浏览器抓取型平台（空库则用预设）
//   node scripts/wallet-login.mjs bailian    # 只登录指定平台（tencent/mimo/kimi/bailian/minimax/volc/carrier_cmcc/carrier_ct/carrier_cu）
//   node scripts/wallet-login.mjs --list     # 只列出需要登录的平台，不打开浏览器
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import db, { initSchema } from '../src/db/index.js';
import { parseScrapeRule, STORAGE_DIR, STORAGE_KEY_BY_NAME, BROWSER_ARGS, SAFE_KEYWORD_BY_KEY, detectCarrierLoggedIn, storageKeyFor, ruleKeyFor, CARRIER_ENTRY_URLS, enrichRuleWithBuiltin, CARRIER_RULES, clickByText, normalizePageText } from '../src/services/scraper_wallets.mjs';
import { missingRequiredCookies } from '../src/services/session_status.mjs';
import { markSessionLoggedIn, parseMaskedAccount } from '../src/services/session_meta.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 平台定义（key → 名称/钱包页/提取规则）——仅作为数据库为空时的兜底预设
const PRESET_PLATFORMS = [
  { key: 'tencent',  name: '腾讯云TokenHub', url: 'https://console.cloud.tencent.com/expense',              rule: '{"keyword":"可用余额","max":10000000}' },
  { key: 'mimo',     name: '小米MiMo',       url: 'https://platform.xiaomimimo.com/console/balance',        rule: '{"keyword":"现金余额","max":10000000}' },
  { key: 'kimi',     name: '月之暗面Kimi',   url: 'https://platform.kimi.com/console/account',              rule: '{"keyword":"可用余额","max":10000000}' },
  { key: 'bailian',  name: '阿里云百炼',     url: 'https://billing-cost.console.aliyun.com',                rule: '{"keyword":"可用额度","max":10000000}' },
  { key: 'minimax',  name: 'MiniMax',        url: 'https://platform.minimax.cn/console/recharge-records',   rule: '{"keyword":"可用额度","max":10000000}' },
  { key: 'volc',     name: '火山引擎',       url: 'https://console.volcengine.com/finance/account-overview', rule: '{"keyword":"可用余额","max":10000000}' },
  // 三大运营商个人卡：网上营业厅（登录后靠内置规则点菜单进余额页）
  { key: 'carrier_cmcc', name: '中国移动话费', url: 'https://shop.10086.cn/i/?f=home', rule: '' },
  { key: 'carrier_ct',   name: '中国电信话费', url: 'https://www.189.cn/',   rule: '' },
  { key: 'carrier_cu',   name: '中国联通话费', url: 'https://www.10010.com/', rule: '' },
];

// 从数据库动态读取所有"浏览器抓取型"平台（新添加的 scrape 平台也会被覆盖到）
// 三大运营商个人卡走 provider=carrier_* 且 balance_type=api，同样需要网厅登录态，一并纳入
function targetsFromDb() {
  const rows = db.prepare(
    "SELECT id, name, provider, balance_api_url, balance_json_path FROM platforms WHERE (balance_type='scrape' OR provider LIKE 'carrier_%') AND active = 1"
  ).all();
  return rows
    .filter((r) => r.balance_api_url || CARRIER_ENTRY_URLS[r.provider])
    .map((r) => ({
      // 登录态文件 key 按「账号」唯一：同运营商的多个号码各存各的文件（带平台 id）
      key: storageKeyFor(r.name, r.provider, r.id),
      // 规则/关键字按「网站」维度取：同运营商的所有号码共用一套网厅规则
      ruleKey: ruleKeyFor(r.name, r.provider),
      id: r.id,
      name: r.name,
      // 运营商平台可以没填 balance_api_url（如「移动副卡」这类自定义名平台），
      // 用内置网厅入口兜底，否则它不会出现在登录目标里
      url: r.balance_api_url || CARRIER_ENTRY_URLS[r.provider] || null,
      rule: r.balance_json_path || '',
    }))
    .filter((r) => r.url);
}

const isLoginUrl = (u) => /login|passport|signin|cas\/|auth\/login/i.test(u || '');

// 登录成功后「预热」登录态：把网厅的余额/用户中心模块真正加载一遍。
// 为什么必须做（实测 2026-11-20）：
//   网厅登录成功的那一刻，浏览器里并不一定已经有全部关键 cookie。
//   189.cn 的网关会话 cookie（_secure_gateway_v2_token）与用户档案 cookie
//   （_user_location_auth_v2_profile）是在用户中心/余额模块真正加载之后才下发的。
//   若在登录判定刚成立时就保存登录态，存下的是一份残缺登录态：
//   抓取时服务端不认这个会话，页面回到未登录态（余额显示为 --）。
//   实测事故：2026-11-20 17:14 就是这么把一份完整登录态覆盖成了残缺态。
// 返回 { ok, missing }：missing 非空表示关键 cookie 还没下发齐全。
async function warmUpSession(page, context, { url, rule, requiredCookies, timeoutMs = 90000 }) {
  const spec = Array.isArray(requiredCookies) ? requiredCookies : [];
  const deadline = Date.now() + timeoutMs;
  let missing = spec.map((r) => r.exact || r.prefix);

  // 入口页 → 点菜单进余额/用户中心模块 → 网厅下发会话 cookie
  const visit = async () => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch { /* 跳转失败不致命，继续看 cookie */ }
    await page.waitForTimeout(2500);
    // 点菜单（电信首页的余额/用户中心入口），让相关模块真正加载
    for (const entry of (rule?.entries || []).slice(0, 4)) {
      if (!(await clickByText(page, entry, 5000))) continue;
      await page.waitForTimeout(2500);
      const cookies = await context.cookies().catch(() => []);
      missing = missingRequiredCookies(cookies, spec);
      if (!missing.length) return true;
    }
    return false;
  };

  while (Date.now() < deadline) {
    await visit();
    const cookies = await context.cookies().catch(() => []);
    missing = missingRequiredCookies(cookies, spec);
    if (!missing.length) return { ok: true, missing: [] };
    // 还没齐：刷新入口页再来一轮（有时需要第二次访问网厅才补发会话 cookie）
    await page.waitForTimeout(3000);
  }
  return { ok: false, missing };
}

// 等待页面满足：URL 不在登录页 + 页面文本包含余额关键字（连续两次确认）
// 如果用户手动关闭了登录窗口，立即放弃当前平台（不再傻等超时）
async function waitLoggedIn(page, keyword, { timeoutMs = 10 * 60 * 1000, isCarrier = false } = {}) {
  const start = Date.now();
  let stable = 0;
  let closed = false;
  page.on('close', () => { closed = true; });
  while (Date.now() - start < timeoutMs) {
    if (closed) return false; // 窗口被用户关闭 → 放弃该平台
    try {
      const url = page.url();
      const text = normalizePageText(await page.evaluate(() => (document.body ? document.body.innerText : '')));
      // keyword 可能是字符串或候选数组（运营商页面文案多变，任一命中即算命中）
      const kws = Array.isArray(keyword) ? keyword : [keyword];
      // isCarrier 由调用方传入（见函数签名）
      // 运营商网厅：标签在未登录态也存在（如 189.cn 首页的「账户余额 --」），
      // 必须用 detectCarrierLoggedIn 判定，避免把未登录页面误判成已登录并导出无效登录态
      const hit = isCarrier ? detectCarrierLoggedIn(text, kws) : kws.some((k) => k && text.includes(k));
      const ok = !isLoginUrl(url) && (!keyword || hit);
      // 诊断日志：每 10 秒打印一次当前 URL 和关键字命中情况，便于排查登录卡住
      const elapsed = Date.now() - start;
      if (elapsed % 10000 < 2000) {
        const sample = text.slice(0, 80).replace(/\s+/g, ' ');
        console.log(`  [等待登录 ${Math.floor(elapsed / 1000)}s] url=${url} 命中关键字=${ok} 文本=${sample}`);
      }
      if (ok) {
        stable += 1;
        if (stable >= 2) return true;
      } else {
        stable = 0;
      }
    } catch (e) {
      // 不能静默吞掉：页面跳转中属正常，但代码错误（如引用了作用域外的变量）会表现为
      // 每轮都抛异常、既不打印诊断也不判定登录，只能干等到超时。上次就踩过这个坑。
      const elapsed = Date.now() - start;
      if (elapsed % 10000 < 2000) {
        console.log(`  [等待登录 ${Math.floor(elapsed / 1000)}s] 读取页面异常：${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

(async () => {
  await initSchema(); // 确保数据库已加载（sql.js 惰性初始化）

  const args = process.argv.slice(2);
  // 支持多个 key（按参数顺序逐个登录）——错峰重登要用：
  // 服务端把三家的登录态文件 key 按「建议重登顺序」传进来，
  // 脚本就按这个顺序一个一个弹窗口，用户扫完一个关掉、自动弹下一个。
  const onlyKeys = args.filter((a) => !a.startsWith('--'));
  const onlyKey = onlyKeys.length === 1 ? onlyKeys[0] : null;

  // 需要登录的目标：数据库里的浏览器抓取型平台优先；空库时用预设兜底
  const dbTargets = targetsFromDb();
  const allTargets = dbTargets.length ? dbTargets : PRESET_PLATFORMS;
  const matchKey = (p, key) => p.key === key || p.name === key || String(p.id) === key;
  let targets;
  if (onlyKeys.length) {
    // 按参数顺序排列（而不是按数据库顺序），保证重登顺序就是用户该扫的顺序
    targets = onlyKeys
      .map((k) => allTargets.find((p) => matchKey(p, k)))
      .filter(Boolean);
    const missing = onlyKeys.filter((k) => !allTargets.some((p) => matchKey(p, k)));
    if (missing.length) {
      console.log(`未找到平台: ${missing.join(', ')}。可用: ${allTargets.map((p) => p.key).join(', ')}`);
      process.exit(1);
    }
  } else {
    targets = allTargets;
  }
  if (onlyKey && targets.length === 0) {
    console.log(`未找到平台: ${onlyKey}。可用: ${allTargets.map((p) => p.key).join(', ')}`);
    process.exit(1);
  }

  if (args.includes('--list')) {
    console.log(`需要登录的浏览器抓取型平台（${targets.length} 个）${dbTargets.length ? '（来自数据库配置）' : '（预设兜底）'}：`);
    for (const p of targets) console.log(`  ${p.name}  (key=${p.key})\n    url=${p.url}`);
    process.exit(0);
  }

  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  console.log(`=== AI 钱包一次性登录${onlyKeys.length ? `（仅 ${onlyKeys.join('、')}）` : ''} ===`);
  console.log(`本次登录 ${targets.length} 个平台${dbTargets.length ? '（读取数据库配置，新添加的平台也会包含）' : '（数据库无抓取平台，使用预设）'}。\n`);

  // 与抓取端使用同一组启动参数（禁用设备绑定会话），保证登录态可跨实例持久保存
  const browser = await chromium.launch({ headless: false, channel: 'chrome', args: BROWSER_ARGS });
  let closedAll = false; // 用户把所有窗口都关了 → 终止整个流程
  browser.on('disconnected', () => { closedAll = true; });
  try {
    for (const p of targets) {
      if (closedAll) {
        console.log('检测到浏览器窗口已全部关闭，结束登录流程。');
        break;
      }
      const storageFile = path.join(STORAGE_DIR, `storage_${p.key}.json`);
      const rule = parseScrapeRule(p.rule);
      const ruleKey = p.ruleKey || p.key;
      const isCarrier = /^carrier_/.test(ruleKey);
      // 运营商用内置规则（菜单入口、关键 cookie 声明），与抓取端一致
      const fullRule = enrichRuleWithBuiltin(rule, p.name, ruleKey);
      const requiredCookies = CARRIER_RULES[ruleKey]?.sessionRequiredCookies || null;
      // 登录检测用内置宽松关键字兜底：数据库规则可能被页面误写成带符号坏值（如"可用余额￥ "），
      // 内置宽松词（如"可用余额"）只要页面出现即判定已登录，避免干等超时
      const loginKeyword = SAFE_KEYWORD_BY_KEY[p.ruleKey || p.key] || rule.keyword;
      console.log(`[${p.name}] 打开 ${p.url}`);
      console.log('  请在浏览器窗口里登录（关闭窗口 = 放弃当前平台）。');
      let context, page;
      try {
        context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        page = await context.newPage();
        await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      } catch (e) {
        console.log(`  ✗ 浏览器已不可用（窗口被关闭），结束登录流程。`);
        break;
      }
      const ok = await waitLoggedIn(page, loginKeyword, { isCarrier });
      if (ok) {
        // 预热：把网厅的余额/用户中心模块真正加载一遍，等关键 cookie 下发齐全再保存。
        // 否则存下的是残缺登录态（网关会话 cookie 缺失），抓取必然报未登录。
        let warm = { ok: true, missing: [] };
        if (isCarrier && requiredCookies && requiredCookies.length) {
          console.log('  正在加载网厅余额模块，等待关键会话 cookie 下发...');
          warm = await warmUpSession(page, context, { url: p.url, rule: fullRule, requiredCookies });
          if (warm.ok) {
            console.log('  ✓ 关键会话 cookie 已下发齐全');
          } else {
            console.log(`  ✗ 关键会话 cookie 仍缺失（${warm.missing.join(', ')}）`);
          }
        }
        // 残缺登录态绝不覆盖已有的完整登录态
        if (!warm.ok) {
          console.log(`  ✗ ${p.name} 登录态不完整，未覆盖 ${storageFile}（避免把可用登录态写成残缺态）`);
        } else {
          await context.storageState({ path: storageFile });
          // 记录会话起点与绑定号码：
          //   实测（2026-11-20 晚）移动的会话是「登录后固定 ~60 分钟」的硬上限，
          //   访问不延长它 → 「预计存活」必须从登录时刻起算；
          //   同时记下网厅认定的号码，避免副卡被登成主卡号后余额串号。
          const pageText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
          const account = parseMaskedAccount(pageText);
          markSessionLoggedIn(storageFile, account);
          console.log(`  ✓ ${p.name} 登录成功，登录态已保存到 ${storageFile}`);
          if (account) console.log(`  · 绑定号码：${account}`);
        }
      } else {
        console.log(`  ✗ ${p.name} 未完成登录（窗口关闭或超时），跳过。`);
      }
      try { await page.close(); } catch {}
      try { await context.close(); } catch {}
    }
  } finally {
    try { await browser.close(); } catch {}
  }
  console.log('\n登录流程结束。现在可运行 node scripts/wallet-check.mjs 验证，或启动服务定时巡检。');
})();
