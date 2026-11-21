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
import { findDegradedCookies } from './session_status.mjs';
import { markSessionAlive, markSessionDead } from './session_meta.mjs';

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
  // 注意：运营商的标签必须配合「后面跟真实数字」才算已登录，见 detectCarrierLoggedIn
  carrier_cmcc: ['退出登录', '退出', '账户余额', '账户可用余额', '可用余额', '当前余额'],
  carrier_ct: ['退出登录', '退出', '账户余额', '本月可用余额', '可用余额', '当前余额'],
  carrier_cu: ['退出登录', '退出', '账户余额', '账户当前可用余额', '可用余额', '当前余额'],
};

// 运营商网厅登录判定。
// 为什么不能只看标签是否出现（实测 2026-11-20，189.cn 未登录首页文本）：
//   "…中国电信欢迎你 登录 手机 宽带 固话 -- 账户余额 -- 已用通用流量 -- 剩余积分 充值…"
//   未登录时「账户余额」等标签就在页面上，只是值为 "--"。若只按标签出现判断，
//   会把未登录页面误判成已登录，导出一份无效登录态，后续巡检永远抓不到余额。
// 规则：满足任一条即视为已登录
//   1. 页面出现登录后专属文案「退出登录 / 退出」（未登录态不存在，实测出现次数为 0）
//   2. 余额标签后面紧跟真实数字（分隔符不超过 12 个，不允许夹杂其他中文标签）
export function detectCarrierLoggedIn(text, keywords) {
  if (!text) return false;
  if (text.includes('退出登录') || text.includes('退出')) return true;
  const keyList = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  const SEP = '[\\s:：()（）¥￥元]{0,12}';
  const NUM = '-?\\d[\\d,]*(?:\\.[0-9]{1,2})?';
  for (const k of keyList) {
    if (k === '退出登录' || k === '退出') continue;   // 已在上方单独处理
    const re = new RegExp(`${k}${SEP}(${NUM})`);
    if (re.test(text)) return true;
  }
  return false;
}

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
//  - exclude：标签里带这些词的金额不采信（防止误取"账户总余额"这类旁支数字）
// 运营商会话的「滑动续期窗口」与保活节奏（实测 2026-11-20）
//
// 实测的 cookie 过期时间（登录后 / 访问后）：
//   移动 chargeresource：登录后 30 分钟过期，每次访问续期到「访问时刻 + 30 分钟」
//   电信 yiUIIlbdQT3fT  ：续期到「访问时刻 + 7 天」
//   电信 yiUIIlbdQT3fS  ：续期到「访问时刻 + 1 年」
//
// 关键：滑动续期必须「在窗口内再访问一次」，否则窗口一到，浏览器下次就不再带上
// 该 cookie，服务端认不出会话 → 跳登录页。所以保活间隔必须小于窗口，
// 且访问后要把续期后的 cookie 写回文件（见 persistStorageState）。
//
// keepAliveMs：保活访问间隔，取窗口的一半留出余量。
// 电信的窗口以天计，但 189.cn 只能有头窗口抓（会弹窗），因此间隔不宜太短。
//
// 实测 2026-11-20 的频率调整依据：
//  - 电信：余额巡检本身就是每小时访问一次 189.cn 并写回续期后的 cookie，
//    7 天窗口已经被它续住，再单独挂一个「每小时保活」属于纯冗余——而且每次
//    都会多弹一次窗口（189.cn 拦无头，只能有头）。因此单独保活放宽到 12 小时，
//    保留为「巡检被禁用/失败时的兜底」，弹窗从每小时 2 次降到 1 次。
//  - 移动：窗口 30 分钟，保活 10 分钟一次，实测会话仍在登录后约 30 分钟失效
//    （保活续不了硬上限），但保活能第一时间发现失效标记并提醒用户重新登录，故保留。
export const CARRIER_KEEPALIVE_MS = {
  // 移动：会话是「登录后固定 ~60 分钟」的服务端硬上限（实测 2026-11-20 晚 + 11-21 复核）：
  //   11-20 21:09 登录 → 22:15 巡检已死（约 66 分钟）
  //   11-21 02:09 登录 → 03:10 保活已死（约 61 分钟）
  //   期间每次访问 chargeresource 的**值不变**（对比 .bak 确认），只有过期时间被推到
  //   「访问时刻+30 分钟」——服务端并未换发会话。
  //   所以保活**延长不了**移动的会话，它只能做到「尽早发现失效」。
  //   间隔取 10 分钟：失效后 10 分钟内就能发现并提醒，不让用户面对一个静默的死会话。
  carrier_cmcc: 10 * 60 * 1000,
  // 电信：实测同样活不过约 60~80 分钟（11-21 02:12 抓到余额 → 03:26 已死），
  //   03:01 那次保活确实换发了新票据（yiUIIlbdQT3fT 值变），但**并没有换来更长的会话**。
  //   所以「访问能续命」这个说法对电信也不成立——不要再拿它当续命手段，
  //   保活的价值只是「尽早发现失效」。
  //   间隔取 20 分钟：比巡检（1 小时）快得多，能提前 40 分钟知道要重新登录；
  //   代价是 189.cn 拦无头，保活需要有头窗口、会弹窗，这是提前预警的必要代价。
  carrier_ct: 20 * 60 * 1000,
  carrier_cu: 30 * 60 * 1000,    // 联通未联调，先按 30 分钟保守取值
};

export const CARRIER_RULES = {
  carrier_cmcc: {
    balanceKeywords: ['可用余额', '账户可用余额', '账户余额', '当前余额'],
    regex: '(?:可用余额|账户可用余额|账户余额|当前余额)[\\s:：()（）¥￥元]*(-?\\d[\\d,]*(?:\\.[0-9]{1,2})?)',
    // 实测首页「服务专区」有「余额查询」入口（指向 shop.10086.cn/i/?f=home）
    entries: ['余额查询', '余量查询', '话费余额', '我的移动'],
    // 实测同页并存「可用余额 70.90元」与「账户总余额 0.00元」，后者不是话费余额
    exclude: ['账户总', '总额', '累计', '预存', '冻结', '赠费'],
    // 会话失效标记（实测 2026-11-20）：服务端在会话作废时下发 ssoFail cookie，
    // 此时 URL 仍是首页、不会跳登录页——只查 URL 会漏判，导致保活误报「续期成功」。
    sessionFailMarkers: ['ssoFail'],
    // 关键会话 cookie：决定登录态还能活多久的那一枚（实测 30 分钟滑动窗口）
    sessionCookie: { exact: 'chargeresource' },
    // 实测会话最长存活时长（毫秒）——「预计存活」倒计时用它，而不是 cookie 过期时间。
    // 实测（2026-11-20 晚 + 11-21 复核）：登录后约 60~66 分钟必失效，
    // 期间保活每次访问都没能延长它（chargeresource 值不变，只推过期时间）。
    sessionMaxAgeMs: 60 * 60 * 1000,
    // 访问能否真的「续命」：移动不行。
    // 实测（2026-11-20 晚 + 11-21 复核，对比 .bak 与当前文件）：每次访问后
    // chargeresource 的**值不变**、只有过期时间被推后——服务端没有换发新会话，
    // 所以定期访问只能让 cookie 看起来还新鲜，救不回服务端会话。
    // 结论：移动的会话寿命从「登录时刻」起算，访问不延长它。
    sessionRenewable: false,
  },
  carrier_ct: {
    balanceKeywords: ['可用余额', '本月可用余额', '账户余额', '当前余额'],
    // 实测（2026-11-20，189.cn 登录后首页正文节选）：
    //   "…手机 宽带 固话 54 .61 元 账户余额 0 .00 KB 已用专用流量 0 分钟 已用通用语音 0…"
    // 布局与移动相反——数值在上、标签在下；且数字被拆成 "54" + "\n" + ".61" 两段渲染。
    // 因此这里用「数值在前 + 标签在后」的正则，并配合 valueBeforeLabel 兜底。
    regex: '(-?\\d[\\d,]*(?:\\.[0-9]{1,2})?)[\\s¥￥元]{0,8}账户余额',
    valueBeforeLabel: true,
    // 实测：189.cn 对无头浏览器做站点级拦截（有头正文 1257 字 / 无头正文 0 字），
    // 与 AutomationControlled 无关。该站只能用有头窗口抓（窗口短暂弹出后自动关闭）。
    headlessBlocked: true,
    // 菜单文字按常见网厅路径依次尝试
    entries: ['服务大厅', '查询服务', '费用查询', '话费账单', '余额查询', '我的账户'],
    exclude: ['账户总', '总额', '累计', '预存', '冻结', '赠费'],
    // 189.cn 首页直接带余额与「退出登录」，访问后可用正文判定会话是否还在，
    // 不必只靠 URL（实测：会话作废后仍停在 /web/，URL 看不出异常）
    sessionCheck: 'text',
    // 关键会话 cookie：网厅每次访问下发的「同前缀成对票据」中较短的那枚（7 天窗口）。
    // 前缀是随机的（如 yiUIIlbdQT3f），不能硬编码全名——按「后缀 T + 存在同前缀 S 兄弟」识别。
    sessionCookie: { suffix: 'T', siblingSuffix: 'S' },
    // 登录态必须包含的关键 cookie（实测 2026-11-20，见 §3.12）：
    //   _secure_gateway_v2_token*    网关会话 cookie，缺了服务端不认这个会话（余额显示为 --）
    //   _user_location_auth_v2_profile*  用户档案 cookie，缺了用户中心/余额模块不渲染
    // 这两枚不是「登录判定用」，而是「登录判定刚成立时网厅还没下发」——
    // 登录脚本若在这个时刻保存，存下来的是残缺登录态，抓取必然报未登录。
    sessionRequiredCookies: [
      { prefix: '_secure_gateway_v2_token' },
      { prefix: '_user_location_auth_v2_profile' },
    ],
    // 实测会话最长存活时长（毫秒）——「预计存活」倒计时用它。
    // 实测（2026-11-20 晚 + 11-21 复核）：登录后约 60~80 分钟必失效。
    // 期间保活确实换发了新票据（yiUIIlbdQT3fT 值变），**但并没有换来更长的会话**：
    // 11-21 03:01 保活换发票据、03:26 巡检已判失效（25 分钟后）。
    // 所以「电信能靠访问续命」是错的——已撤销该结论，两家统一按「登录后固定时长」处理。
    sessionMaxAgeMs: 60 * 60 * 1000,
    // 访问能否真的「续命」：实测不能（11-21 复核）。保活改走完整抓取路径
    // （见 keepaliveFullScrape）只是多一次让服务端刷新票据的机会，不作数。
    sessionRenewable: false,
    // 保活时是否走完整抓取路径（点菜单进余额模块）而非只访问入口页。
    // 对电信：入口页访问只会换发入口页的票据，而实测能刷新会话的只有完整抓取那次。
    // 保留这个开关是为了「多一次机会」，不代表它真能续命。
    keepaliveFullScrape: true,
  },
  carrier_cu: {
    balanceKeywords: ['可用余额', '账户当前可用余额', '账户余额', '当前余额'],
    regex: '(?:可用余额|账户当前可用余额|账户余额|当前余额)[\\s:：()（）¥￥元]*(-?\\d[\\d,]*(?:\\.[0-9]{1,2})?)',
    // 实测：联通首页余额入口在 hover 展开的「查询」二级菜单里（首页无余额链接），
    // 顺序为「先展开一级菜单，再点二级入口」
    entries: ['查询', '余额查询', '余量查询', '账户余额', '查话费'],
    // 联通未联调，关键会话 cookie 尚未标定。此时不能随便取「最早过期的 cookie」——
    // 那是 SDK cookie 的假值（电信会显示 7 小时而不是 7 天）。未标定前显示「未标定」。
    sessionCookie: null,
    exclude: ['账户总', '总额', '累计', '预存', '冻结', '赠费'],
  },
};

// 给规则补上内置安全关键字与精确正则（内置优先，防止数据库规则被写成坏值），返回新规则对象
export function enrichRuleWithBuiltin(rule, name, provider) {
  if (!rule) return rule;
  // 规则按「网站」维度取（同一运营商的多个号码共享同一套网厅规则）
  const key = ruleKeyFor(name, provider);
  // 运营商：套用内置的标签组、精确正则与网厅菜单入口
  const carrier = CARRIER_RULES[key];
  if (carrier) {
    // 用户显式配了关键字时，不再叠加内置标签组（否则用户规则会被内置词干扰）
    const userSetKeyword = Boolean(rule.keyword || (rule.keywords && rule.keywords.length));
    return {
      keyword: rule.keyword || carrier.balanceKeywords[0],
      keywords: userSetKeyword ? (rule.keywords || null) : carrier.balanceKeywords,
      regex: rule.regex || carrier.regex,
      max: rule.max,
      entries: rule.entries || carrier.entries,
      exclude: rule.exclude || carrier.exclude,
      // 数值在上、标签在下（实测 189.cn 首页）：让提取走「往前找金额」的路径
      valueBeforeLabel: rule.valueBeforeLabel ?? carrier.valueBeforeLabel ?? false,
      // 站点级拦截无头浏览器：抓取时改用有头窗口
      headlessBlocked: rule.headlessBlocked ?? carrier.headlessBlocked ?? false,
      // 会话失效标记（服务端作废会话时下发的标记 cookie，URL 看不出异常）
      sessionFailMarkers: rule.sessionFailMarkers ?? carrier.sessionFailMarkers ?? null,
      // 会话有效性判定方式：'text' = 用页面正文判定（会话作废后 URL 可能不变）
      sessionCheck: rule.sessionCheck ?? carrier.sessionCheck ?? null,
      // 关键会话 cookie 声明：决定「预计存活」倒计时取哪一枚 cookie
      sessionCookie: rule.sessionCookie ?? carrier.sessionCookie ?? null,
      // 登录态必须包含的关键 cookie 声明：登录保存与写回都要校验它（见 persistStorageState）
      sessionRequiredCookies: rule.sessionRequiredCookies ?? carrier.sessionRequiredCookies ?? null,
      // 会话最长存活时长（实测标定）：用于「预计存活」倒计时，避免拿 cookie 票据寿命当会话寿命
      sessionMaxAgeMs: rule.sessionMaxAgeMs ?? carrier.sessionMaxAgeMs ?? null,
      // 访问是否真能续命：false = 寿命从登录时刻起算，访问只是让 cookie 看起来新鲜
      sessionRenewable: rule.sessionRenewable ?? carrier.sessionRenewable ?? null,
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
        exclude: rule.exclude || null,
      };
    }
  }
  return rule;
}

// 从页面文本中提取余额，三条路径：
//   1. 精确正则优先：整页扫"关键字+金额符号+数字"，支持捕获组（取组1=金额），
//      页面提示语、栏目名、账号名里的同名文字不会误中；
//   2. 关键字兜底：正则未命中时，在关键字各出现位置中找"紧跟其后"的金额，
//      关键字与数字之间只允许分隔符（空白/标点/货币符号/单位），
//      不允许夹杂其他中文标签——否则「可用余额预警\n设置阈值 100」会误取到 100；
//   3. 排除词（exclude）：标签里带排除词的金额一律不采信。
//      真实场景：移动网厅同页同时有「可用余额 70.90元」和「账户总余额 0.00元」，
//      若版本差异导致先命中总余额，会把 0.00 当成欠费并错误触发充值单。
export function extractBalance(text, { keyword, keywords, regex, max, exclude, valueBeforeLabel }) {
  const limit = max ?? 1e7;
  const excludes = Array.isArray(exclude) ? exclude.filter(Boolean) : [];
  // 归一化：部分网厅把一个金额拆成多段渲染（实测 189.cn 首页："54" + "\n" + ".61" + "元"），
  // 不接回来的话只能取到整数部分 54，把 54.61 误读成 54。
  const src = String(text ?? '').replace(/(\d)[ \t]*\n[ \t]*(\.\d)/g, '$1$2');
  // 标签上下文：往后看整段匹配，往前多看几个字（用于识别「账户总余额」这类含排除词的标
  const isExcluded = (start, len) => {
    if (!excludes.length) return false;
    const win = src.slice(Math.max(0, start - 6), start + len);
    return excludes.some((w) => win.includes(w));
  };
  const pick = (m) => {
    const g = m[1] !== undefined ? m[1] : m[0];
    const n = parseFloat(String(g).replace(/,/g, ''));
    return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
  };
  if (regex) {
    // 逐个匹配检查标签是否被排除，取第一个未被排除的金额
    for (const m of src.matchAll(new RegExp(regex, 'g'))) {
      if (isExcluded(m.index, m[0].length)) continue;
      const v = pick(m);
      if (v !== null) return v;
    }
  }
  // 关键字兜底：关键字组（keywords）优先于单个 keyword
  const keyList = (Array.isArray(keywords) && keywords.length
    ? keywords
    : (Array.isArray(keyword) ? keyword : [keyword])
  ).filter(Boolean);
  if (keyList.length) {
    // 分隔符：不含 '-'，负号留给数字本身（欠费）
    const SEP = '[\\s:：()（）¥￥元]*';
    const NUM = '(-?\\d[\\d,]*(?:\\.[0-9]{1,2})?)';
    const candidates = [];
    for (const k of keyList) {
      let idx = src.indexOf(k);
      while (idx >= 0) {
        if (!isExcluded(idx, k.length)) candidates.push({ idx, k });
        idx = src.indexOf(k, idx + k.length);
      }
    }
    if (!candidates.length) return null; // 关键字都没出现，视为页面结构不符
    candidates.sort((a, b) => a.idx - b.idx);
    if (valueBeforeLabel) {
      // 数值在上、标签在下（实测 189.cn 首页："54.61元" 出现在 "账户余额" 之前）：
      // 先从标签位置往前找紧邻的金额，中间只允许分隔符，不允许夹其他中文标签。
      // 找不到再走下面的「标签后跟金额」路径——其他省份版本的网厅布局相反。
      for (const c of candidates) {
        const before = src.slice(Math.max(0, c.idx - 40), c.idx);
        const m = before.match(new RegExp(NUM + '[\\s¥￥元]{0,8}$'));
        if (!m) continue;
        const v = pick(m);
        if (v !== null) return v;
      }
    }
    // 优先带货币符号的标签位置（更可能是真正的余额展示位）
    const withSymbol = candidates.filter((c) => /[¥￥]/.test(src.slice(c.idx, c.idx + 40)));
    const ordered = [...withSymbol, ...candidates.filter((c) => !withSymbol.includes(c))];
    for (const c of ordered) {
      const after = src.slice(c.idx + c.k.length);
      const m = after.match(new RegExp('^' + SEP + NUM));
      if (!m) continue; // 关键字与数字之间夹了别的文字，不是余额展示位
      const v = pick(m);
      if (v !== null) return v;
    }
    return null;
  }
  // 没有任何关键字：整页取第一个在上限内的数字
  const numRe = /-?[0-9][0-9,]*(?:\.[0-9]+)?/g;
  const matches = [...src.matchAll(numRe)].map((m) => parseFloat(m[0].replace(/,/g, '')));
  const valid = matches.filter((n) => Number.isFinite(n) && Math.abs(n) <= limit);
  return valid.length ? valid[0] : null;
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
// LLM_MANAGER_WALLET_STATE_DIR 可覆盖目录（测试隔离用，避免依赖开发机上的真实登录态）。
export const STORAGE_DIR = process.env.LLM_MANAGER_WALLET_STATE_DIR
  || path.join(__dirname, '..', 'wallet-states');

// 平台名 → 规则 key 的映射（与 wallet-login.mjs / setup-wallet-platforms.mjs 一致）
// 兼容新简称（腾讯云/MIMO/Kimi/阿里云）与旧全称
// 注意：这张表映射的是「网站/运营商」维度的知识（网厅页面结构），不是登录态文件——
// 登录态文件按「账号」维度唯一，见 storageKeyFor。
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

// 平台 → 规则 key（按「网站/运营商」维度，不是按账号）
// 用于 CARRIER_RULES / SAFE_KEYWORD_BY_KEY / PRECISE_REGEX_BY_KEY——
// 这些是「网厅页面结构」的知识，同运营商的所有号码完全一致，可以共享。
export function ruleKeyFor(name, provider = null) {
  return STORAGE_KEY_BY_NAME[name] || provider || name;
}

// 平台 → 登录态文件 key（按「账号」维度，必须唯一）
// 背景：同一运营商可能登录多个号码（主卡 + 副卡 / 家庭共享号）。运营商服务端按账号
// 独立维护会话，不同号码的 cookie 互不影响、互不顶号；但我们本地的登录态文件如果只按
// 运营商命名，第二个号码登录时就会覆盖第一个的登录态文件——两个平台于是共用一份 cookie，
// 抓到的余额可能是另一个号码的。
// 因此：只有「内置规范名」沿用固定 key（向后兼容既有登录态文件）；
// 其余平台（自定义名，如「移动副卡」）按 provider + 平台 id 派生唯一 key。
export function storageKeyFor(name, provider = null, id = null) {
  const canonical = STORAGE_KEY_BY_NAME[name];
  if (canonical) return canonical;
  if (id !== null && id !== undefined && provider) return `${provider}_${id}`;
  return provider || name;
}

// 按平台名找登录态文件；找不到返回 null
// fallbackKey：非预设平台（新添加的平台）用 provider 字段兜底匹配
// id：平台 id，用于把同运营商的多个账号拆成不同登录态文件
export function storageFileFor(name, fallbackKey = null, id = null) {
  const key = storageKeyFor(name, fallbackKey, id);
  if (!key) return null;
  const f = path.join(STORAGE_DIR, `storage_${key}.json`);
  return fs.existsSync(f) ? f : null;
}

// 统一浏览器启动参数：
//  - 禁用 Device Bound Sessions：腾讯云/小米/阿里云等平台使用 Chrome 设备绑定会话时，
//    cookie 绑定在启动它的 Chrome 实例上，关闭浏览器后重新启动即失效；
//    禁用后这些平台回退到普通 cookie，登录态才能跨实例持久保存。
//  - 关闭 AutomationControlled：Playwright 默认会把 navigator.webdriver 置为 true，
//    189.cn（电信网厅）据此判定为自动化客户端，直接返回空页面（正文 0 字，html 仅 39 字符）。
//    实测对照（2026-11-20）：不加该参数正文 0 字；加上后正常渲染并跳到 /web/，
//    页面出现「账户余额」等业务文案。因此该参数是电信网厅能打开的前提。
// 注意：登录脚本（wallet-login.mjs）也必须用同一组参数，否则登录态与抓取环境不一致。
export const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-features=DeviceBoundSessions,DeviceBoundSessionsV2',
  '--disable-blink-features=AutomationControlled',
];

// 定位可用的浏览器可执行文件。
// 为什么不能直接用 chromium.executablePath()：它返回的路径取决于 PLAYWRIGHT_BROWSERS_PATH
// 环境变量，而服务进程（由启动项.bat 拉起）不一定继承到该变量，会指向默认的
// ms-playwright 目录——那里往往没有安装，报 "Executable doesn't exist"。
// 登录脚本与巡检服务是两个进程，环境不同，必须按「实际存在的文件」来挑。
const SYSTEM_CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

let cachedExecutable = null;

// 返回可用的浏览器可执行文件路径；找不到返回 null
export function resolveBrowserExecutable() {
  if (cachedExecutable) return cachedExecutable;
  const candidates = [];
  // 1) Playwright 自带的 chromium（若环境变量指向已安装位置）
  try {
    const p = chromium.executablePath();
    if (p) candidates.push(p);
  } catch { /* 未安装时抛错，忽略 */ }
  // 2) PLAYWRIGHT_BROWSERS_PATH 下的 chromium-*/chrome-win64/chrome.exe
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersPath) {
    for (const dir of fs.existsSync(browsersPath) ? fs.readdirSync(browsersPath) : []) {
      if (!dir.startsWith('chromium')) continue;
      candidates.push(path.join(browsersPath, dir, 'chrome-win64', 'chrome.exe'));
    }
  }
  // 3) 系统安装的 Chrome / Edge
  candidates.push(...SYSTEM_CHROME_PATHS);
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) {
        cachedExecutable = c;
        return c;
      }
    } catch { /* 忽略探测异常 */ }
  }
  return null;
}

// 统一的启动选项：能定位到可执行文件就用绝对路径（不依赖环境变量），
// 定位不到则退回 channel（playwright 自带下载的浏览器）
function launchOptions(extra = {}) {
  const exe = resolveBrowserExecutable();
  return {
    ...(exe ? { executablePath: exe } : { channel: 'chromium' }),
    // BROWSER_ARGS 默认带上（可被 extra.args 覆盖）：
    // 189.cn 等网厅会按 navigator.webdriver 判定自动化客户端并返回空页面，
    // 少了 --disable-blink-features=AutomationControlled 就会「登录能开、抓取打不开」。
    // 统一放在这里，避免各启动路径各写一份而漏传。
    args: BROWSER_ARGS,
    ...extra,
  };
}

// 按可见文字点击页面元素（网厅菜单入口），成功返回 true
// 先按精确文字找（避免点到同义栏目），找不到再退回模糊匹配
// 登录脚本也要用它：登录成功后点进余额模块，网厅才会下发网关会话 cookie（见 wallet-login.mjs）
export async function clickByText(page, text, timeoutMs = 6000) {
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
    // 提取不到余额时，先分清「会话已失效」与「页面结构变了」——
    // 实测（2026-11-20）：电信会话作废后，首页仍带「账户余额」标签但值是 "--"，
    // 关键字会命中、余额提不出来，于是报成「页面中未找到余额」，把掉线伪装成页面异常。
    // 规则要求用正文判定会话时（电信），检查正文里还有没有登录标识。
    if (rule?.sessionCheck === 'text') {
      const alive = detectCarrierLoggedIn(text, rule.keywords);
      if (!alive) {
        throw new Error(`${debugLabel} 未登录（页面已无登录标识，余额显示为占位符）`);
      }
    }
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

// 把浏览器上下文当前的 cookie 写回登录态文件。
// 为什么必须写回（实测 2026-11-20）：
// 网厅会话是「滑动续期」的——每次访问，服务端都会把关键 cookie 的过期时间往后推。
//   移动：chargeresource 每次访问续期到「访问时刻 + 30 分钟」（实测 15:29 → 15:36）
//   电信：yiUIIlbdQT3fS 续期到「访问时刻 + 1 年」，yiUIIlbdQT3fT 续期到「+7 天」
// 如果抓完就把浏览器关掉、丢弃刷新后的 cookie，等于每次巡检都在用「登录那一刻」
// 的过期时间重新算起，登录态必然在第一个滑动窗口（移动 30 分钟）内失效。
// 写回后，登录态的有效期从「登录后固定 N 分钟」变成「只要定期访问就能一直续」。
//
// requiredCookies：登录态必须包含的关键 cookie 声明（见 CARRIER_RULES.*.sessionRequiredCookies）。
// 写回前会做「退化检查」：新状态若丢了旧状态已有的关键 cookie，就拒绝写入。
// 为什么：189.cn 的网关会话 cookie 只在会话有效时才下发，一旦服务端作废会话，
// 抓到的 cookie 集就会少掉它。此时若无条件覆盖，等于用一份残缺登录态
// 换掉原本完整的登录态——实测 2026-11-20 就这样把电信登录态写坏了。
export async function persistStorageState(context, storageFile, { requiredCookies = null } = {}) {
  try {
    const state = await context.storageState();
    if (!state || !Array.isArray(state.cookies) || !state.cookies.length) return false;

    // 退化检查：不让一次不完整的抓取把完整的登录态覆盖掉
    if (Array.isArray(requiredCookies) && requiredCookies.length) {
      let old = null;
      try { old = JSON.parse(fs.readFileSync(storageFile, 'utf-8')); } catch { /* 没有旧文件 */ }
      const degraded = findDegradedCookies(state.cookies, old && old.cookies, requiredCookies);
      if (degraded.length) {
        console.warn(
          `[scrape] 登录态写回被拒绝（${storageFile}）：新状态缺少关键 cookie ${degraded.join(', ')}，` +
          '保留原登录态不动（否则会把完整登录态覆盖成残缺态）'
        );
        return false;
      }
    }

    // 原子写：先写临时文件再 rename，避免中途崩溃留下半个损坏的登录态文件
    const tmp = `${storageFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    // 留一份备份：写回的是服务端刚续期的 cookie，万一站点行为异常还能退回旧文件
    try { fs.copyFileSync(storageFile, `${storageFile}.bak`); } catch { /* 首次写入无旧文件 */ }
    fs.renameSync(tmp, storageFile);
    return true;
  } catch (e) {
    console.warn(`[scrape] 登录态写回失败（${storageFile}）: ${e.message}`);
    return false;
  }
}

// 用登录态文件（storageState）抓取单平台
// headless 参数：某些网厅（如 189.cn）做站点级无头拦截，只能用有头窗口抓。
async function scrapeWithStorage(storageFile, { url, rule, debugLabel, waitMs, headless = true }) {
  const browser = await chromium.launch(launchOptions({ headless }));
  try {
    const context = await browser.newContext({ storageState: storageFile, ...HEADLESS_CONTEXT_OPTIONS });
    const page = await context.newPage();
    try {
      const balance = await scrapeOnePage(page, { url, rule, debugLabel, waitMs, blockAssets: true });
      // 写回服务端续期后的 cookie，保住滑动续期窗口（见 persistStorageState 注释）
      await persistStorageState(context, storageFile, { requiredCookies: rule?.sessionRequiredCookies || null });
      // 抓取成功 = 会话有效 = 一次有效的续命机会（记录给倒计时用）
      markSessionAlive(storageFile);
      return balance;
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
    // 站点级拦截无头浏览器的网厅（如实测 189.cn）：直接用有头窗口抓，
    // 否则先无头失败再回退，会白等一轮超时。
    const needHeaded = rule?.headlessBlocked === true;
    try {
      return await scrapeWithStorage(storageFile, { url, rule, debugLabel, waitMs, headless: needHeaded ? false : headless });
    } catch (err) {
      if (!allowCdpFallback) throw err;
      const cdpUp = await isDesktopChromeRunning();
      if (cdpUp) {
        console.warn(`[scrape] ${debugLabel} 抓取失败（${err.message}），改用桌面 Chrome 重试`);
        return await scrapeViaDesktopChrome({ url, rule, debugLabel, waitMs });
      }
      // 桌面 Chrome 不可用时，再试一次有头窗口（部分站点只拦无头）
      if (!needHeaded && headless) {
        console.warn(`[scrape] ${debugLabel} 无头抓取失败（${err.message}），改用有头浏览器重试`);
        return await scrapeWithStorage(storageFile, { url, rule, debugLabel, waitMs, headless: false });
      }
      throw err;
    }
  }

  const cdpUp = await isDesktopChromeRunning();
  if (cdpUp) {
    return await scrapeViaDesktopChrome({ url, rule, debugLabel, waitMs });
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions({
    headless,
    // 用完整版 Chrome（Chrome for Testing）的无头模式，与登录脚本同一二进制，
    // 避免 headless shell 与完整版之间登录态读取不一致的问题
    viewport: { width: 1920, height: 1080 },
    args: BROWSER_ARGS,
  }));
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

// 判定一次访问后网厅会话是否还有效（纯函数，便于单测）
// 返回 { loggedIn, reason }：
//   - 跳登录页 → 失效
//   - 服务端下发失效标记 cookie（移动 ssoFail）→ 失效（URL 仍停在首页）
//   - 规则要求用正文判定（电信）且正文已无登录标识 → 失效（URL 仍停在 /web/）
export function classifySessionState({ url = '', text = '', cookies = [], rule = {}, keywords = null }) {
  if (/login|passport|signin/i.test(url)) {
    return { loggedIn: false, reason: '跳转登录页' };
  }
  const markers = (rule?.sessionFailMarkers || []).filter((m) => (cookies || []).some((c) => c.name === m));
  if (markers.length) {
    return { loggedIn: false, reason: `服务端下发会话失效标记 ${markers.join(',')}` };
  }
  if (rule?.sessionCheck === 'text' && !detectCarrierLoggedIn(text, keywords)) {
    return { loggedIn: false, reason: '页面已无登录标识' };
  }
  return { loggedIn: true, reason: '' };
}

// 从运营商规则里拼出「余额提取规则」
// 为什么需要：extractBalance 认的是 { keyword, keywords, regex, ... }，
// 而 CARRIER_RULES 里关键词存放在 balanceKeywords、值前布局存在 valueBeforeLabel，
// 直接把整个规则丢进去，兜底的关键词路径会因为拿不到 keywords 而静默返回 null。
export function balanceExtractionRule(rule) {
  if (!rule) return {};
  const kws = Array.isArray(rule.balanceKeywords) ? rule.balanceKeywords : null;
  return {
    keyword: kws ? kws[0] : rule.keyword,
    keywords: kws,
    regex: rule.regex || null,
    exclude: rule.exclude || null,
    valueBeforeLabel: rule.valueBeforeLabel === true,
    max: rule.max,
  };
}

// 运营商会话续期（保活）：只访问网厅首页触发服务端滑动续期，并把续期后的 cookie 写回。
// 与抓取余额的区别：
//   - 不写 balance_history、不触发充值单（保活每 10 分钟跑一次，
//     若每次都写历史会污染数据并让阈值判断频繁触发）；
//   - 但**顺带把余额读出来**返回（见下方 balance）：保活本来就在访问网厅，
//     顺手取到的余额几乎不花额外代价，却能让余额不再依赖巡检恰好落在会话存活窗口内。
// 返回 { ok, loggedIn, balance }：loggedIn=false 表示会话已失效（需要用户重新登录）。
export async function renewCarrierSession({ url, storageFile, rule, keywords, debugLabel = '运营商' }) {
  const headless = rule?.headlessBlocked !== true;
  const browser = await chromium.launch(launchOptions({ headless }));
  try {
    const context = await browser.newContext({ storageState: storageFile, ...HEADLESS_CONTEXT_OPTIONS });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(6000);
      const readText = async () => await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      let text = await readText();
      // 「可续命」的运营商（如电信）：只访问入口页未必能触发票据换发。
      // 实测能换发的是**完整抓取**那条路径（进余额模块），保活必须走同一条路。
      // 注意（2026-11-21 复核）：走完整路径也**没能**延长会话寿命，
      // 它的价值只是「多一次刷新票据的机会」，不代表续命成功。
      // 所以这里的开关改用独立的 keepaliveFullScrape，不再挂在 sessionRenewable 上
      // （sessionRenewable 现在两家都是 false，否则保活会退化成只访问入口页）。
      const entries = Array.isArray(rule?.entries) ? rule.entries : [];
      if (rule?.keepaliveFullScrape === true && entries.length) {
        for (const entry of entries.slice(0, 4)) {
          if (!(await clickByText(page, entry, 5000))) continue;
          await page.waitForTimeout(2500);
        }
        text = await readText();
      }
      // 顺带取余额：能取到就返回，取不到不算失败（会话判定才是保活的本职）。
      // 移动的首页不一定直接带余额，取不到时再点一次菜单入口试试
      // （无头窗口，不弹窗，不增加打扰）。
      const exRule = balanceExtractionRule(rule);
      let balance = extractBalance(text, exRule);
      if (balance === null && entries.length && rule?.keepaliveFullScrape !== true) {
        for (const entry of entries.slice(0, 4)) {
          if (!(await clickByText(page, entry, 5000))) continue;
          await page.waitForTimeout(2500);
          text = await readText();
          balance = extractBalance(text, exRule);
          if (balance !== null) break;
        }
      }
      const currentUrl = page.url();
      // 会话是否还有效：跳登录页 / 服务端失效标记 / 正文已无登录标识
      // 三种情况都不能只看 URL——实测移动与电信失效后 URL 都不变
      const cookies = await context.cookies().catch(() => []);
      const state = classifySessionState({ url: currentUrl, text, cookies, rule, keywords });
      if (!state.loggedIn) {
        // 会话已失效：清掉「上次有效访问时刻」，倒计时不再给乐观估计
        markSessionDead(storageFile, state.reason);
        return { ok: false, loggedIn: false, url: currentUrl, reason: state.reason };
      }
      const persisted = await persistStorageState(context, storageFile, { requiredCookies: rule?.sessionRequiredCookies || null });
      // 访问成功且会话有效 = 一次有效的「访问机会」。
      // 实测（2026-11-21 复核）：两家的会话寿命都从「登录时刻」起算，访问**不**延长它。
      // 但仍要记录这次有效访问：它是「会话目前还活着」的地面真相，
      // 也是「用户重新登录了但没走我们的脚本」时倒计时锚点的来源。
      markSessionAlive(storageFile);
      return { ok: persisted, loggedIn: true, url: currentUrl, textLength: text.length, balance };
    } finally {
      try { await page.close(); } catch {}
      try { await context.close(); } catch {}
    }
  } finally {
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
    // 按是否被站点拦截无头浏览器分组：被拦的用有头窗口，其余用无头
    const groups = [
      { headless: true, list: withStorage.filter((t) => t.rule?.headlessBlocked !== true) },
      { headless: false, list: withStorage.filter((t) => t.rule?.headlessBlocked === true) },
    ];
    for (const g of groups) {
      if (!g.list.length) continue;
      const browser = await chromium.launch(launchOptions({ headless: g.headless }));
      try {
        for (const t of g.list) {
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
            // 同样写回续期后的 cookie（批量路径与单平台路径行为一致）
            await persistStorageState(context, t.storageFile, { requiredCookies: t.rule?.sessionRequiredCookies || null });
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
  }
  for (const t of tasks) {
    if (!t.storageFile) {
      results.push({ label: t.debugLabel, ok: false, error: '无登录态文件（请运行 node scripts/wallet-login.mjs 登录）' });
    }
  }
  return results;
}
