// 通用浏览器钱包余额抓取器
// 原理：用 playwright 打开各平台钱包页面，在页面文本中按「关键字 + 正则」提取余额
// 适用：没有官方余额 API 或需要登录控制台才能看余额的平台（腾讯云、小米、Kimi、阿里云百炼、MiniMax、火山引擎等）
// 登录态两种来源（按优先级）：
//   1. 连接桌面 Chrome 实时登录态（CDP，端口 9222）：与你日常浏览器同一登录态，登录一次长期有效，
//      需用 scripts/start-chrome-debug.cmd 以调试模式启动 Chrome 并保持打开。
//   2. 独立浏览器档案 src/playwright-user-data：首次运行 scripts/wallet-login.mjs 登录一次，之后定时巡检复用。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 与 MiniMax 抓取器共用同一登录态目录（src/playwright-user-data）
export const PROFILE_DIR = path.join(__dirname, '..', 'playwright-user-data');

// 桌面 Chrome 调试端口（scripts/start-chrome-debug.cmd 启动）
export const CDP_PORT = 9222;

// 探测桌面 Chrome 调试端口是否可用（即用户已用调试模式打开 Chrome）
export function isDesktopChromeRunning(port = CDP_PORT) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: 1500 },
      (res) => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 连接桌面 Chrome（共享其实时登录态）
async function connectDesktopChrome(port = CDP_PORT) {
  return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
}

// 解析 balance_json_path 里的提取规则：
//   - 纯关键字：如 "可用额度"
//   - JSON：{"keyword":"可用额度","regex":"[0-9.,]+","max":10000000}
export function parseScrapeRule(raw) {
  let keyword = null;
  let keywords = null;
  let regex = null;
  let max = 1e7;
  let entries = null;
  if (raw) {
    try {
      // JSON 字符串内不允许出现真实换行，先把真实换行转义为 \n 再解析
      // （规则中的换行用于定位相邻两行文本，例如 "可用余额\n￥ "）
      const escaped = String(raw).replace(/\n/g, '\\n');
      const obj = JSON.parse(escaped);
      keyword = obj.keyword || null;
      // 运营商网厅页面文案随版本变化，允许配一组候选关键字（任一命中即算命中）
      keywords = Array.isArray(obj.keywords) ? obj.keywords.filter(Boolean) : null;
      regex = obj.regex || null;
      max = obj.max ?? 1e7;
      // entries：网厅首页只有菜单时，按这些文字依次点击进入余额子页
      entries = Array.isArray(obj.entries) ? obj.entries.filter(Boolean) : null;
    } catch {
      keyword = raw; // 不是 JSON，整串当作关键字
    }
  }
  return { keyword, keywords, regex, max, entries };
}

// 内置各平台"安全宽松关键字"（登录检测与抓取兜底使用）：
// 数据库规则可能被页面编辑/误填写成带符号的坏值（如"可用余额￥ "），导致登录检测
// 永远等不到、抓取永远失败。内置宽松词只匹配纯中文标签，页面只要出现即算命中，
// 金额提取交给 PRECISE_REGEX_BY_KEY 精确完成。
export const SAFE_KEYWORD_BY_KEY = {
  minimax: '可用额度',
  tencent: '可用余额',
  mimo: '现金余额',
  kimi: '可用余额',
  bailian: '可用额度',
  volc: '可用余额',
  // 三大运营商个人卡：登录后网厅右上角出现"退出登录"；部分省份版本不显示退出文字，
  // 登录后首页/余额页会出现余额标签，因此两者并用，任一命中即视为已登录
  carrier_cmcc: ['退出登录', '退出', '账户余额', '账户可用余额', '可用余额', '当前余额'],
  carrier_ct: ['退出登录', '退出', '账户余额', '本月可用余额', '可用余额', '当前余额'],
  carrier_cu: ['退出登录', '退出', '账户余额', '账户当前可用余额', '可用余额', '当前余额'],
};

// 内置各平台精确提取正则（按登录态 key 匹配）：
// 与规则里的 regex 字段等价，但无需用户配置——抓取时自动套用。
// 模板说明：关键字后 12 个非数字/非金额符号字符内必须出现 ¥/￥，再接金额（捕获组1=金额）。
// 这样提示语（"可用余额、今日消费…延迟10分钟"）、栏目名（"可用余额预警"）、账号数字都不会被误中。
export const PRECISE_REGEX_BY_KEY = {
  // MiniMax：账户钱包\n可用额度\n¥\n15.00
  minimax: '可用额度[^\\d¥￥]{0,12}?[¥￥]\\s*(-?\\d[\\d,]*(?:\\.[0-9]+)?)',
  // 腾讯云：可用余额\n余额预警\n0.00元（无货币符号，直接取紧跟数字）
  tencent: '可用余额[^\\d]{0,15}?(-?\\d[\\d,]*(?:\\.[0-9]+)?)',
  // MIMO：现金余额：¥ 0.00
  mimo: '现金余额[^\\d¥￥]{0,12}?[¥￥]\\s*(-?\\d[\\d,]*(?:\\.[0-9]+)?)',
  // Kimi：可用余额\n￥ 15.00000
  kimi: '可用余额[^\\d¥￥]{0,12}?[¥￥]\\s*(-?\\d[\\d,]*(?:\\.[0-9]+)?)',
  // 阿里云：账户可用额度\n¥ 0
  bailian: '可用额度[^\\d¥￥]{0,12}?[¥￥]\\s*(-?\\d[\\d,]*(?:\\.[0-9]+)?)',
  // 火山引擎：可用余额 \n¥0.00（"可用余额预警"栏目名后无金额符号，天然不中）
  volc: '可用余额[^\\d¥￥]{0,12}?[¥￥]\\s*(-?\\d[\\d,]*(?:\\.[0-9]+)?)',
};

// 三大运营商网厅入口（登录后靠 CARRIER_RULES.entries 点菜单进入余额页）
// 页面结构与登录方式各省略有差异，可在平台配置里覆盖 balance_api_url
export const CARRIER_ENTRY_URLS = {
  // 中国移动：首页「服务专区 → 余额查询」直达地址（实测 2026-11-20）
  carrier_cmcc: 'https://shop.10086.cn/i/?f=home',
  carrier_ct: 'https://www.189.cn/',
  carrier_cu: 'https://www.10010.com/',
};

// 三大运营商个人卡专用配置（个人实体卡没有自助申请的官方余额 API，走网厅页面抓取）：
//  - balanceKeywords：余额在页面上的标签（等待命中用，任一命中即算命中）
//  - regex：精确提取余额（单位元，负数表示欠费）
//  - entries：网厅首页的菜单入口文字，抓取时依次点击进入余额子页
export const CARRIER_RULES = {
  carrier_cmcc: {
    balanceKeywords: ['账户余额', '账户可用余额', '可用余额', '当前余额'],
    regex: '(?:账户余额|账户可用余额|可用余额|当前余额)[\\s:：()（）¥￥元]*(-?\\d[\\d,]*(?:\\.[0-9]{1,2})?)',
    // 实测首页「服务专区」有「余额查询」入口（指向 shop.10086.cn/i/?f=home）
    entries: ['余额查询', '余量查询', '话费余额', '我的移动'],
  },
  carrier_ct: {
    balanceKeywords: ['账户余额', '本月可用余额', '可用余额', '当前余额'],
    regex: '(?:账户余额|本月可用余额|可用余额|当前余额)[\\s:：()（）¥￥元]*(-?\\d[\\d,]*(?:\\.[0-9]{1,2})?)',
    // 实测：电信网厅在无头浏览器下反爬拦截（正文为 0），需靠桌面 Chrome 真实浏览器或
    // 已保存的登录态文件；菜单文字按常见网厅路径依次尝试
    entries: ['服务大厅', '查询服务', '费用查询', '话费账单', '余额查询', '我的账户'],
  },
  carrier_cu: {
    balanceKeywords: ['账户余额', '账户当前可用余额', '可用余额', '当前余额'],
    regex: '(?:账户余额|账户当前可用余额|可用余额|当前余额)[\\s:：()（）¥￥元]*(-?\\d[\\d,]*(?:\\.[0-9]{1,2})?)',
    // 实测：联通首页余额入口在 hover 展开的「查询」二级菜单里（首页无余额链接），
    // 顺序为「先展开一级菜单，再点二级入口」
    entries: ['查询', '余额查询', '余量查询', '账户余额', '查话费'],
  },
};

// 给规则补上内置安全关键字与精确正则（内置优先，防止数据库规则被写成坏值），返回新规则对象
export function enrichRuleWithBuiltin(rule, name, provider) {
  if (!rule) return rule;
  const key = STORAGE_KEY_BY_NAME[name] || provider;
  // 运营商：套用内置的标签组、精确正则与网厅菜单入口
  const carrier = CARRIER_RULES[key];
  if (carrier) {
    return {
      keyword: rule.keyword || carrier.balanceKeywords[0],
      keywords: rule.keywords || carrier.balanceKeywords,
      regex: rule.regex || carrier.regex,
      max: rule.max,
      entries: rule.entries || carrier.entries,
    };
  }
  if (key) {
    const safeKeyword = SAFE_KEYWORD_BY_KEY[key];
    const precise = PRECISE_REGEX_BY_KEY[key];
    if (safeKeyword || precise) {
      return {
        keyword: safeKeyword || rule.keyword,
        keywords: rule.keywords || null,
        regex: rule.regex || precise || null,
        max: rule.max,
        entries: rule.entries || null,
      };
    }
  }
  return rule;
}

// 从页面文本中提取余额，两条路径：
//   1. 精确正则优先：整页扫"关键字+金额符号+数字"，支持捕获组（取组1=金额），
//      页面提示语、栏目名、账号名里的同名文字不会误中；
//   2. 关键字兜底：正则未命中时，在关键字各出现位置中优先选"后跟金额符号（¥/￥）"的那处，
//      取其后的第一个数字。
export function extractBalance(text, { keyword, regex, max }) {
  const limit = max ?? 1e7;
  const pick = (m) => {
    const g = m[1] !== undefined ? m[1] : m[0];
    const n = parseFloat(String(g).replace(/,/g, ''));
    return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
  };
  if (regex) {
    const hits = [...text.matchAll(new RegExp(regex, 'g'))].map(pick).filter((v) => v !== null);
    if (hits.length) return hits[0];
  }
  let segment = text;
  if (keyword) {
    // 关键字允许是字符串或候选数组（运营商页面文案多变，任一命中即可）
    const keys = (Array.isArray(keyword) ? keyword : [keyword]).filter(Boolean);
    const positions = [];
    for (const k of keys) {
      let idx = text.indexOf(k);
      while (idx >= 0) {
        positions.push(idx);
        idx = text.indexOf(k, idx + k.length);
      }
    }
    if (positions.length === 0) return null; // 关键字都没出现，视为页面结构不符
    positions.sort((a, b) => a - b);
    let chosen = positions[0]; // 无符号特征时退回第一次出现
    for (const pos of positions) {
      if (/[¥￥]/.test(text.slice(pos, pos + 40))) { // 关键字后 40 字符内有金额符号即视为真实标签
        chosen = pos;
        break;
      }
    }
    segment = text.slice(chosen, chosen + 160); // 关键字后面 160 字符通常是金额区域
  }
  // 默认正则支持千分位逗号与负号（欠费）
  const numRe = /-?[0-9][0-9,]*(?:\.[0-9]+)?/g;
  const matches = [...segment.matchAll(numRe)].map((m) => parseFloat(m[0].replace(/,/g, '')));
  const valid = matches.filter((n) => Number.isFinite(n) && Math.abs(n) <= limit);
  if (valid.length === 0) return null;
  // 关键字后出现的第一个数字即余额
  return valid[0];
}

function isLoginUrl(url) {
  return /login|passport|signin|cas\/|auth\/login/i.test(url);
}

// 打开页面并等待余额关键字出现（最长 waitKeywordMs 毫秒）。
// 注意：部分平台登录后访问钱包页会先跳一次登录/令牌服务再回跳（如小米 sts），
// 因此 URL 出现登录关键字时不能立刻判失败，要连续两次检查都停在登录页才确认未登录。
// 返回 { ok, loginUrl }：ok=true 表示页面文本已包含关键字；loginUrl 非空表示确认停在登录页。
async function waitForKeyword(page, keyword, { waitKeywordMs = 30000 } = {}) {
  const deadline = Date.now() + waitKeywordMs;
  let loginStreak = 0;
  while (Date.now() < deadline) {
    const cur = page.url();
    if (isLoginUrl(cur)) {
      loginStreak += 1;
      if (loginStreak >= 2) return { ok: false, loginUrl: cur }; // 连续两次停在登录页
    } else {
      loginStreak = 0;
    }
    if (keyword) {
      // keyword 允许是字符串或候选数组（运营商页面文案多变）
      const list = Array.isArray(keyword) ? keyword : [keyword];
      const has = await page.evaluate((kws) => {
        const text = document.body?.innerText || '';
        return kws.some((k) => text.includes(k));
      }, list);
      if (has) return { ok: true };
    }
    await page.waitForTimeout(2000);
  }
  return { ok: false, loginUrl: null };
}

// 登录态文件目录（storageState 导出，参照 E:\ai-wallet-monitor-portable 方案）：
// 运行 scripts/wallet-login.mjs 登录后自动导出到 src/wallet-states/storage_<key>.json，
// 巡检时无头浏览器加载该文件注入登录态，无需保持桌面 Chrome 打开。
export const STORAGE_DIR = path.join(__dirname, '..', 'wallet-states');

// 平台名 → 登录态文件 key 的映射（与 wallet-login.mjs / setup-wallet-platforms.mjs 一致）
// 兼容新简称（腾讯云/MIMO/Kimi/阿里云）与旧全称
export const STORAGE_KEY_BY_NAME = {
  '腾讯云TokenHub': 'tencent',
  '腾讯云': 'tencent',
  '小米MiMo': 'mimo',
  'MIMO': 'mimo',
  '月之暗面Kimi': 'kimi',
  'Kimi': 'kimi',
  '阿里云百炼': 'bailian',
  '阿里云': 'bailian',
  'MiniMax': 'minimax',
  '火山引擎': 'volc',
  // 三大运营商个人卡（网厅抓取）
  '中国移动话费': 'carrier_cmcc',
  '中国电信话费': 'carrier_ct',
  '中国联通话费': 'carrier_cu',
};

// 按平台名找登录态文件；找不到返回 null
// fallbackKey：非预设平台（新添加的 scrape 平台）用 provider 字段兜底匹配
export function storageFileFor(name, fallbackKey = null) {
  const key = STORAGE_KEY_BY_NAME[name] || fallbackKey;
  if (!key) return null;
  const f = path.join(STORAGE_DIR, `storage_${key}.json`);
  return fs.existsSync(f) ? f : null;
}

// 统一浏览器启动参数：
//  - 禁用 Device Bound Sessions：腾讯云/小米/阿里云等平台使用 Chrome 设备绑定会话时，
//    cookie 绑定在启动它的 Chrome 实例上，关闭浏览器后重新启动即失效；
//    禁用后这些平台回退到普通 cookie，登录态才能跨实例持久保存。
// 注意：登录脚本（wallet-login.mjs）也必须用同一组参数，否则登录态与抓取环境不一致。
export const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-features=DeviceBoundSessions,DeviceBoundSessionsV2',
];

// 按可见文字点击页面元素（网厅菜单入口），成功返回 true
// 先按精确文字找（避免点到同义栏目），找不到再退回模糊匹配
async function clickByText(page, text, timeoutMs = 6000) {
  for (const exact of [true, false]) {
    try {
      const loc = page.getByText(text, { exact }).first();
      await loc.click({ timeout: timeoutMs });
      // 一级菜单点击后可能展开二级菜单，等页面稳定
      await page.waitForTimeout(1800);
      return true;
    } catch { /* 换一种匹配方式继续 */ }
  }
  return false;
}

// 在给定页面上完成一次抓取：打开钱包页 → 等待关键字 → 提取余额
// CDP 模式下不拦截图片（路由拦截只对独立启动的浏览器有效）
async function scrapeOnePage(page, { url, rule, debugLabel = '平台', waitMs = 8000, blockAssets = true }) {
  if (blockAssets) {
    await page.route('**/*.{png,jpg,jpeg,webp,svg,gif,ico,woff,woff2}', (r) => r.abort());
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(waitMs);

  // 余额标签：运营商页面文案多变，用规则里的候选组，任一命中即算命中
  const targets = (rule.keywords && rule.keywords.length ? rule.keywords : [rule.keyword]).filter(Boolean);

  // 等待余额关键字出现；期间若连续两次停在登录页则判定未登录
  let { ok, loginUrl } = await waitForKeyword(page, targets);
  if (!ok && !loginUrl && Array.isArray(rule.entries) && rule.entries.length) {
    // 网厅首页通常只有菜单：依次点击入口文字，进入余额子页后重新找关键字
    for (const entry of rule.entries) {
      if (!(await clickByText(page, entry))) continue;
      const again = await waitForKeyword(page, targets, { waitKeywordMs: 12000 });
      if (again.ok) { ok = true; break; }
      if (again.loginUrl) { loginUrl = again.loginUrl; break; }
    }
  }
  if (!ok) {
    if (loginUrl) {
      throw new Error(`${debugLabel} 未登录（跳转至 ${loginUrl}）`);
    }
    throw new Error(`${debugLabel}: 页面中未找到余额（关键字="${targets.join('/')}"）`);
  }


  const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
  const balance = extractBalance(text, rule);
  if (balance === null) {
    throw new Error(`${debugLabel}: 页面中未找到余额（关键字="${rule.keyword}"）`);
  }
  return balance;
}

// 无头抓取时的浏览器上下文参数：
// 运营商网厅（尤其电信 189.cn）对无头浏览器的指纹敏感，实测无头环境下页面正文为空、
// 链接数为 0（反爬拦截）。补上真实 Chrome UA、中文区域与时区，降低被拦截的概率；
// 仍然拿不到时，靠桌面 Chrome CDP（真实浏览器指纹）作为回退路径。
const HEADLESS_CONTEXT_OPTIONS = {
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/131.0.0.0 Safari/537.36',
};

// 用登录态文件（storageState）无头抓取单平台
async function scrapeWithStorage(storageFile, { url, rule, debugLabel, waitMs }) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const context = await browser.newContext({ storageState: storageFile, ...HEADLESS_CONTEXT_OPTIONS });
    const page = await context.newPage();
    try {
      return await scrapeOnePage(page, { url, rule, debugLabel, waitMs, blockAssets: true });
    } finally {
      try { await page.close(); } catch {}
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

// 连接桌面 Chrome（共享其实时登录态）并在其中抓取
// 注意：不关闭 browser——连接的是用户桌面 Chrome，关闭会关掉用户浏览器
async function scrapeViaDesktopChrome({ url, rule, debugLabel, waitMs }) {
  const browser = await connectDesktopChrome();
  let page;
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    return await scrapeOnePage(page, { url, rule, debugLabel, waitMs, blockAssets: false });
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
  }
}

// 单平台抓取（优先级）：
//   1. 登录态文件 src/wallet-states/storage_<key>.json（参照 E:\ai-wallet-monitor-portable 方案）；
//   2. 连接桌面 Chrome 实时登录态（CDP，端口 9222）；
//   3. 回退到独立浏览器档案 src/playwright-user-data。
// headless=false 仅用于独立档案的登录场景。
export async function scrapeWalletBalance({ url, rule, debugLabel = '平台', headless = true, waitMs = 8000, storageFile = null, allowCdpFallback = false }) {
  // allowCdpFallback=true：登录态文件抓取失败后，退回桌面 Chrome（真实浏览器指纹）。
  // 运营商网厅对无头浏览器反爬明显（实测电信 189.cn 无头下页面为空），需要这条退路。
  if (storageFile) {
    try {
      return await scrapeWithStorage(storageFile, { url, rule, debugLabel, waitMs });
    } catch (err) {
      if (!allowCdpFallback) throw err;
      const cdpUp = await isDesktopChromeRunning();
      if (!cdpUp) throw err;
      console.warn(`[scrape] ${debugLabel} 无头抓取失败（${err.message}），改用桌面 Chrome 重试`);
      return await scrapeViaDesktopChrome({ url, rule, debugLabel, waitMs });
    }
  }

  const cdpUp = await isDesktopChromeRunning();
  if (cdpUp) {
    return await scrapeViaDesktopChrome({ url, rule, debugLabel, waitMs });
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    // 用完整版 Chrome（Chrome for Testing）的无头模式，与登录脚本同一二进制，
    // 避免 headless shell 与完整版之间登录态读取不一致的问题
    channel: 'chromium',
    viewport: { width: 1920, height: 1080 },
    args: BROWSER_ARGS,
  });
  let page;
  try {
    page = await browser.newPage();
    return await scrapeOnePage(page, { url, rule, debugLabel, waitMs, blockAssets: true });
  } catch (e) {
    // 独立档案模式：保存现场截图便于排查
    if (page) {
      try {
        const shot = path.join(__dirname, '..', 'debug_scrape.png');
        await page.screenshot({ path: shot, fullPage: true });
        e.message += `，已保存截图 ${shot}`;
      } catch {}
    }
    throw e;
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
    await browser.close();
  }
}

// 批量抓取（供验证脚本与巡检使用）：
// 每个平台加载各自的登录态文件（task.storageFile），无头顺序抓取；
// 没有登录态文件的平台直接标记「无登录态文件」。
export async function scrapeWalletsBatch(tasks) {
  const results = [];
  const withStorage = tasks.filter((t) => t.storageFile);
  if (withStorage.length) {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const t of withStorage) {
        const context = await browser.newContext({ storageState: t.storageFile, viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        try {
          const balance = await scrapeOnePage(page, {
            url: t.url,
            rule: t.rule,
            debugLabel: t.debugLabel,
            waitMs: t.waitMs ?? 8000,
            blockAssets: true,
          });
          results.push({ label: t.debugLabel, ok: true, balance });
        } catch (e) {
          results.push({ label: t.debugLabel, ok: false, error: e.message });
        } finally {
          try { await page.close(); } catch {}
          try { await context.close(); } catch {}
        }
      }
    } finally {
      await browser.close();
    }
  }
  for (const t of tasks) {
    if (!t.storageFile) {
      results.push({ label: t.debugLabel, ok: false, error: '无登录态文件（请运行 node scripts/wallet-login.mjs 登录）' });
    }
  }
  return results;
}
