#!/usr/bin/env node
// 三大运营商个人卡余额：解析逻辑单元测试（不联网、不依赖真实网厅）
// 覆盖：规则解析、内置规则套用、余额提取（多文案变体 / 负数 / 千分位 / 误命中防护）
import { parseScrapeRule, enrichRuleWithBuiltin, extractBalance, CARRIER_RULES, CARRIER_ENTRY_URLS, SAFE_KEYWORD_BY_KEY, STORAGE_KEY_BY_NAME, detectCarrierLoggedIn, classifySessionState, BROWSER_ARGS, CARRIER_KEEPALIVE_MS, storageKeyFor, ruleKeyFor } from '../src/services/scraper_wallets.mjs';
import { pickKeySessionCookie, buildSessionStatus, missingRequiredCookies, findDegradedCookies } from '../src/services/session_status.mjs';
import { readSessionMeta, writeSessionMeta, markSessionLoggedIn, markSessionDead, parseMaskedAccount } from '../src/services/session_meta.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? `   [${detail}]` : ''}`);
}

// ===== 1. 规则解析 =====
const r1 = parseScrapeRule('{"keyword":"可用额度","max":10000000}');
check('解析关键字与 max', r1.keyword === '可用额度' && r1.max === 10000000);

const r2 = parseScrapeRule('{"keywords":["账户余额","可用余额"],"entries":["费用查询"],"max":100}');
check('解析候选关键字组', Array.isArray(r2.keywords) && r2.keywords.length === 2 && r2.keywords[0] === '账户余额');
check('解析菜单入口', Array.isArray(r2.entries) && r2.entries[0] === '费用查询');

const r3 = parseScrapeRule('纯关键字文本');
check('非 JSON 整串当关键字', r3.keyword === '纯关键字文本');

const r4 = parseScrapeRule(null);
check('空规则不抛错', r4.keyword === null && r4.keywords === null);

// ===== 2. 内置规则套用 =====
for (const [key, name] of [['carrier_cmcc', '中国移动话费'], ['carrier_ct', '中国电信话费'], ['carrier_cu', '中国联通话费']]) {
  const enriched = enrichRuleWithBuiltin(parseScrapeRule(''), name, key);
  check(`${name} 套用内置标签组`, Array.isArray(enriched.keywords) && enriched.keywords.length > 0);
  check(`${name} 套用内置精确正则`, typeof enriched.regex === 'string' && enriched.regex.includes('余额'));
  check(`${name} 套用内置菜单入口`, Array.isArray(enriched.entries) && enriched.entries.length > 0);
}

// 平台名映射到登录态 key
check('平台名映射 carrier_cmcc', STORAGE_KEY_BY_NAME['中国移动话费'] === 'carrier_cmcc');
check('平台名映射 carrier_ct', STORAGE_KEY_BY_NAME['中国电信话费'] === 'carrier_ct');
check('平台名映射 carrier_cu', STORAGE_KEY_BY_NAME['中国联通话费'] === 'carrier_cu');

// 登录检测关键字是数组（网厅"退出登录"）
for (const key of ['carrier_cmcc', 'carrier_ct', 'carrier_cu']) {
  check(`${key} 登录检测关键字为数组`, Array.isArray(SAFE_KEYWORD_BY_KEY[key]) && SAFE_KEYWORD_BY_KEY[key].includes('退出登录'));
}

// 网厅入口齐全
for (const key of ['carrier_cmcc', 'carrier_ct', 'carrier_cu']) {
  check(`${key} 有网厅入口`, typeof CARRIER_ENTRY_URLS[key] === 'string' && CARRIER_ENTRY_URLS[key].startsWith('http'));
}

// ===== 1b. 登录态文件按「账号」唯一（同运营商多号码不互相覆盖）=====
// 规范名沿用固定 key（向后兼容既有登录态文件）
check('规范名登录态 key 固定（移动）', storageKeyFor('中国移动话费', 'carrier_cmcc', 5) === 'carrier_cmcc');
check('规范名登录态 key 固定（电信）', storageKeyFor('中国电信话费', 'carrier_ct', 6) === 'carrier_ct');
// 同运营商的第二个号码必须拿到不同 key，否则会覆盖主号的登录态
check('同运营商第二号码 key 不同（移动）',
  storageKeyFor('移动副卡', 'carrier_cmcc', 7) !== storageKeyFor('移动副卡2', 'carrier_cmcc', 8));
check('同运营商第二号码 key 不与主号相同（电信）',
  storageKeyFor('电信副卡', 'carrier_ct', 9) !== storageKeyFor('中国电信话费', 'carrier_ct', 6));
// 规则 key 按「网站」维度共享：同运营商所有号码共用一套网厅规则
check('同运营商规则 key 共享（移动）',
  ruleKeyFor('移动副卡', 'carrier_cmcc') === ruleKeyFor('中国移动话费', 'carrier_cmcc'));
check('同运营商规则 key 共享（电信）',
  ruleKeyFor('电信副卡', 'carrier_ct') === ruleKeyFor('中国电信话费', 'carrier_ct'));

// 2026-11-20 实测：内置浏览器登录后 shop.10086.cn/i/?f=home 的正文（节选，含真实金额）
const REAL_CMCC = '中午好， 178****6402 星级：无星级 当前套餐：全家享套餐（全国版）29档 ' +
  '我的账户 70.90元交费> 可用余额： 70.90元账单> 账户总余额 ： 0.00元详单> 当月消费 ： 获取失败 ' +
  '我的AI豆： 交话费 充流量 交费号码： 揭阳 交费金额： 50元 100元 300元 500元 交费 立即交费 ' +
  '套餐余量 语音 剩余49分钟 98% 共50分钟 流量 剩余2.44GB 81% 共3GB ' +
  '近六个月消费趋势上月消费：29.10元平均每月消费：29.1元';

// ===== 3. 余额提取：三家真实文案变体 =====
const cmccRule = enrichRuleWithBuiltin(parseScrapeRule(''), '中国移动话费', 'carrier_cmcc');
const ctRule = enrichRuleWithBuiltin(parseScrapeRule(''), '中国电信话费', 'carrier_ct');
const cuRule = enrichRuleWithBuiltin(parseScrapeRule(''), '中国联通话费', 'carrier_cu');

// 实测页面同时有「可用余额 70.90元」与「账户总余额 0.00元」，必须取前者
check('移动实测页面：提取可用余额 70.9', extractBalance(REAL_CMCC, cmccRule) === 70.9);
check('移动实测页面：不误取账户总余额 0', extractBalance(REAL_CMCC, cmccRule) !== 0);

// 版本差异模拟：总余额标签排到可用余额前面，仍不能取到 0
const SWAPPED = '账户总余额 ： 0.00元详单> 我的账户 70.90元交费> 可用余额： 70.90元账单>';
check('总余额在前也不误取（排除词生效）', extractBalance(SWAPPED, cmccRule) === 70.9);

// 排除词机制直接生效：总余额是唯一命中时返回 null（而不是 0，避免误报欠费）
const ONLY_TOTAL = '账户总余额 ： 0.00元详单>';
check('只有总余额时返回 null 而非 0', extractBalance(ONLY_TOTAL, cmccRule) === null);

// 用户显式配置的规则不被内置覆盖
const custom = enrichRuleWithBuiltin(parseScrapeRule('{"keyword":"我的余额","regex":"我的余额(\\\\d+)","entries":["我的入口"]}'), '中国移动话费', 'carrier_cmcc');
check('用户自定义关键字优先', custom.keyword === '我的余额');
check('用户自定义正则优先', custom.regex.includes('我的余额'));
check('用户自定义入口优先', custom.entries[0] === '我的入口');

// 中国移动：账户余额 \n ¥86.50
check('移动：账户余额+￥', extractBalance('我的移动\n账户余额\n¥ 86.50\n套餐余量', cmccRule) === 86.5);
// 中国移动：账户余额 86.50元（无货币符号）
check('移动：账户余额+元', extractBalance('账户余额 86.50元', cmccRule) === 86.5);
// 中国电信：本月可用余额
check('电信：本月可用余额', extractBalance('本月可用余额 ¥12.34', ctRule) === 12.34);
check('电信：账户余额带括号单位', extractBalance('账户余额（元）28.60', ctRule) === 28.6);
// 中国联通：账户当前可用余额
check('联通：账户当前可用余额', extractBalance('账户当前可用余额 50.00', cuRule) === 50);
// 负数（欠费）
check('欠费负余额', extractBalance('账户余额 -5.20元', cmccRule) === -5.2);
// 千分位
check('千分位金额', extractBalance('账户余额 ¥1,234.56', cmccRule) === 1234.56);

// 误命中防护：栏目名"可用余额预警"后面没有金额，不应误取后面的无关数字
check('栏目名不误命中', extractBalance('可用余额预警\n设置阈值 100\n剩余话费 20.00', cmccRule) === null);

// 关键字组：任一命中即可
check('候选组二选一命中', extractBalance('账户当前可用余额 33.10', cmccRule) === 33.1);

// 页面结构完全不符时返回 null（不静默返回 0，避免误触发充值单）
check('结构不符返回 null', extractBalance('欢迎光临中国移动通信', cmccRule) === null);

// max 上限：超出上限的金额不采信
const cappedRule = enrichRuleWithBuiltin(parseScrapeRule('{"max":50}'), '中国移动话费', 'carrier_cmcc');
check('超出 max 上限不采信', extractBalance('账户余额 ¥999.00', cappedRule) === null);

// ===== 4. 运营商登录判定（防未登录误判） =====
// 2026-11-20 实测：189.cn 未登录首页文本。关键点——「账户余额」等标签未登录时也在页面上，
// 只是值为 "--"。若只按标签出现判定登录，会导出无效登录态，后续巡检永远抓不到余额。
const CT_ANON = '公告：关于规范互联网渠道售卡管理的公告 中国电信携号转网服务实施细则 ' +
  '收藏电信网网站无障碍关爱版专区 个人 政企 北京 服务大厅 查询服务 充值交费 亲友服务 ' +
  '号卡服务 宽带服务 客服咨询 业务办理 生活服务 中国电信欢迎你 登录 手机 宽带 固话 -- ' +
  '账户余额 -- 已用通用流量 -- 已用通用语音 -- 剩余积分 充值 更多充值 10 元 30 元 50 元';
check('电信未登录首页不算已登录', detectCarrierLoggedIn(CT_ANON, SAFE_KEYWORD_BY_KEY.carrier_ct) === false);
check('电信未登录首页不被标签误命中', detectCarrierLoggedIn(CT_ANON, ['账户余额']) === false);

// 登录后：右上角出现「退出登录」
check('出现「退出登录」即已登录', detectCarrierLoggedIn('中国电信欢迎您 已登录 退出登录 账户余额 55.30元', SAFE_KEYWORD_BY_KEY.carrier_ct) === true);
// 登录后：没有退出文案，但余额标签后跟真实数字
check('余额标签后跟数字即已登录', detectCarrierLoggedIn('中国电信欢迎您 账户余额 55.30元 已用通用流量 12.00', SAFE_KEYWORD_BY_KEY.carrier_ct) === true);
// 占位符 "--" 不算数字
check('占位符不算已登录', detectCarrierLoggedIn('账户余额 -- 已用通用流量 --', SAFE_KEYWORD_BY_KEY.carrier_ct) === false);
// 标签与数字之间夹了别的中文标签，不算余额位
check('标签与数字间夹中文不算已登录', detectCarrierLoggedIn('账户余额 详见详情 55.30元', SAFE_KEYWORD_BY_KEY.carrier_ct) === false);

// ===== 5. 浏览器启动参数：189.cn 反自动化拦截 =====
// 2026-11-20 实测对照：不加 AutomationControlled 时 189.cn 返回空页面（正文 0 字、html 39 字符），
// 加上后正常渲染并跳到 /web/。少了这个参数，电信登录与巡检都拿不到任何内容。
check('启动参数含关闭 AutomationControlled', BROWSER_ARGS.includes('--disable-blink-features=AutomationControlled'));
check('启动参数仍保留 DeviceBoundSessions 禁用', BROWSER_ARGS.some(a => a.includes('DeviceBoundSessions')));

// ===== 6. 电信网厅：反向布局 + 站点级无头拦截 =====
// 实测（189.cn 登录后首页）：「数值在上、标签在下」，且金额被拆成 "54" + "\n" + ".61" 两段渲染。
// 片段："…手机 宽带 固话 54\n.61\n元\n账户余额\n0\n.00\nKB\n已用专用流量…"
const CT_LOGGED_IN = '公告： 关于规范互联网渠道售卡管理的公告 中国电信携号转网服务实施细则 ' +
  '个人 政企 广东 服务大厅 查询服务 充值交费 亲友服务 号卡服务 宽带服务 客服咨询 业务办理 生活服务 ' +
  '黄** 190****3361 普通用户 我的订单 修改密码 退出登录 手机 宽带 固话 ' +
  '54\n.61\n元\n\n账户余额\n\n0\n.00\nKB\n\n已用专用流量\n\n0\n\n分钟\n\n已用通用语音\n\n0\n';
check('电信反向布局：数值在标签前也能取到 54.61', extractBalance(CT_LOGGED_IN, ctRule) === 54.61);
check('电信反向布局：拆分渲染的数字被接回（不是 54）', extractBalance(CT_LOGGED_IN, ctRule) !== 54);
check('电信规则标记为数值在前', ctRule.valueBeforeLabel === true);
check('电信规则标记为站点级拦无头', ctRule.headlessBlocked === true);
check('移动规则未标记数值在前', cmccRule.valueBeforeLabel === false);
check('移动规则未标记拦无头', cmccRule.headlessBlocked === false);

// 拆分数字归一化单独验证
check('拆分行的小数被接回', extractBalance('余额\n12\n.34\n元', { keyword: '余额' }) === 12.34);

// ===== 7. 登录态保活：滑动续期窗口与保活间隔 =====
// 实测（2026-11-20）：运营商网厅会话是滑动续期的——每次访问，服务端把关键 cookie
// 的过期时间推到「访问时刻 + 窗口」。
//   移动 chargeresource：窗口 30 分钟（实测 15:29 → 15:36）
//   电信 yiUIIlbdQT3fT ：窗口 7 天；yiUIIlbdQT3fS：窗口 1 年
// 保活间隔必须小于窗口，否则窗口一过，浏览器下次就不再带上该 cookie → 跳登录页。
check('三家运营商都定义了保活间隔', ['carrier_cmcc', 'carrier_ct', 'carrier_cu'].every(k => typeof CARRIER_KEEPALIVE_MS[k] === 'number'));
check('移动保活间隔 < 30 分钟窗口', CARRIER_KEEPALIVE_MS.carrier_cmcc < 30 * 60 * 1000);
check('电信保活间隔 < 7 天窗口', CARRIER_KEEPALIVE_MS.carrier_ct < 7 * 24 * 3600 * 1000);
check('保活间隔不短于 1 分钟（避免过于频繁）', Object.values(CARRIER_KEEPALIVE_MS).every(v => v >= 60 * 1000));

// ===== 8. 会话失效判定（实测 2026-11-20）=====
// 移动：服务端在会话作废时下发 ssoFail cookie，URL 仍停在首页——只看 URL 会漏判，
// 保活会误报「续期成功」，用户只能等下次巡检才发现掉线。
check('移动规则标记了会话失效标记 ssoFail', Array.isArray(cmccRule.sessionFailMarkers) && cmccRule.sessionFailMarkers.includes('ssoFail'));
// 电信：会话作废后 URL 仍是 /web/，首页带余额与「退出登录」，可用正文判定
check('电信规则标记为正文判定会话', ctRule.sessionCheck === 'text');
check('移动规则未标记正文判定会话', cmccRule.sessionCheck !== 'text');
// 电信只能有头窗口抓（会弹窗），保活频率要权衡弹窗与掉线。
// 旧断言「不短于 1 小时」的前提是「电信会话窗口有 7 天」——那是从 cookie 票据寿命
// （yiUIIlbdQT3fT 写 7 天）推出的假值。实测（2026-11-20 晚）会话窗口只有约 60 分钟：
// 18:53 抓到余额 → 19:54 已失效（距上次成功访问 61 分钟）。
// 保活间隔必须小于窗口，否则 100% 掉线；现在的 25 分钟留了 2 倍余量。
check('电信保活间隔 < 会话窗口（实测窗口约 60 分钟）',
  CARRIER_KEEPALIVE_MS.carrier_ct < CARRIER_RULES.carrier_ct.sessionMaxAgeMs);
check('电信保活间隔不短于 10 分钟（避免过于频繁地弹窗）',
  CARRIER_KEEPALIVE_MS.carrier_ct >= 10 * 60 * 1000);
check('电信保活间隔留有 2 倍以上余量',
  CARRIER_KEEPALIVE_MS.carrier_ct * 2 <= CARRIER_RULES.carrier_ct.sessionMaxAgeMs);

// ===== 9. 会话有效性判定（classifySessionState）=====
// 实测：移动与电信会话失效后 URL 都不变（移动停在首页、电信停在 /web/），
// 只查 URL 会把失效误判成「续期成功」，用户只能等下次巡检才发现掉线。
const CT_TEXT_IN = '黄** 190****3361 普通用户 我的订单 修改密码 退出登录 手机 宽带 固话 54 .61 元 账户余额';
const CT_TEXT_OUT = '中国电信欢迎你 登录 手机 宽带 固话 -- 账户余额 -- 已用通用流量 -- 剩余积分';
check('跳登录页 → 判定失效', classifySessionState({ url: 'https://login.10086.cn/login.html', text: CT_TEXT_IN, rule: cmccRule }).loggedIn === false);
check('跳登录页 → 给出原因', /跳转登录页/.test(classifySessionState({ url: 'https://login.189.cn/x', text: '', rule: ctRule }).reason));
check('移动：带 ssoFail 标记 → 判定失效（URL 未变）', classifySessionState({ url: 'https://shop.10086.cn/i/?f=home', text: '', cookies: [{ name: 'ssoFail' }], rule: cmccRule }).loggedIn === false);
check('移动：带 ssoFail 标记 → 原因写明标记名', /ssoFail/.test(classifySessionState({ url: 'https://shop.10086.cn/i/?f=home', text: '', cookies: [{ name: 'ssoFail' }], rule: cmccRule }).reason));
check('移动：无标记 → 判定有效', classifySessionState({ url: 'https://shop.10086.cn/i/?f=home', text: '', cookies: [{ name: 'lgToken' }], rule: cmccRule }).loggedIn === true);
check('电信：正文已回未登录 → 判定失效（URL 仍是 /web/）', classifySessionState({ url: 'https://www.189.cn/web/', text: CT_TEXT_OUT, cookies: [], rule: ctRule, keywords: SAFE_KEYWORD_BY_KEY.carrier_ct }).loggedIn === false);
check('电信：正文含余额与退出登录 → 判定有效', classifySessionState({ url: 'https://www.189.cn/web/', text: CT_TEXT_IN, cookies: [], rule: ctRule, keywords: SAFE_KEYWORD_BY_KEY.carrier_ct }).loggedIn === true);

// ===== 10. 登录态两个倒计时（预计存活 / 续命） =====
// 关键会话 cookie 不能取「最早过期的那个」：登录态里混着当天就过期的 SDK cookie
// 与 1 年期的长期 cookie，取最早的会得到假值（电信会显示 7 小时而不是 7 天）。
const NOW = 1_700_000_000_000; // 固定基准时间，避免测试随真实时间漂移
const HOUR = 3600_000;

check('移动规则声明了关键会话 cookie', cmccRule.sessionCookie?.exact === 'chargeresource');
check('电信规则声明了关键会话 cookie', ctRule.sessionCookie?.suffix === 'T' && ctRule.sessionCookie?.siblingSuffix === 'S');
check('联通未标定关键会话 cookie', CARRIER_RULES.carrier_cu.sessionCookie === null);

// 移动登录态（实测结构）：chargeresource 30 分钟滑动窗口，其余是会话 cookie / 长期 cookie
const CMCC_COOKIES = [
  { name: 'lgToken', expires: -1 },
  { name: 'CmLocation', expires: NOW / 1000 + 129600 * 60 },
  { name: 'chargeresource', expires: NOW / 1000 + 30 * 60 },
];
// 电信登录态（实测结构）：当天就过期的 SDK cookie + 7 天票据 + 1 年票据
// 注意：cookie 的 expires 单位是「秒」，下面用 HOUR / 1000 换算
const CT_COOKIES = [
  { name: 'sajssdk_2015_cross_new_user', expires: NOW / 1000 + 7 * HOUR / 1000 },
  { name: 'yiUIIlbdQT3fS', expires: NOW / 1000 + 365 * 24 * HOUR / 1000 },
  { name: 'yiUIIlbdQT3fT', expires: NOW / 1000 + 7 * 24 * HOUR / 1000 },
];

const cmccKey = pickKeySessionCookie(CMCC_COOKIES, cmccRule.sessionCookie);
check('移动：选中 chargeresource', cmccKey?.name === 'chargeresource');
check('移动：不受长期 cookie 干扰', cmccKey && Math.round((cmccKey.expires * 1000 - NOW) / 60000) === 30);

const ctKey = pickKeySessionCookie(CT_COOKIES, ctRule.sessionCookie);
check('电信：选中 7 天那枚（xxxT）', ctKey?.name === 'yiUIIlbdQT3fT');
check('电信：不受当天过期的 SDK cookie 干扰', ctKey && Math.round((ctKey.expires * 1000 - NOW) / HOUR) === 7 * 24);
check('电信：随机前缀也能识别（换前缀仍选中 T）',
  pickKeySessionCookie([
    { name: 'zzQQxx0001S', expires: NOW / 1000 + 365 * 24 * HOUR / 1000 },
    { name: 'zzQQxx0001T', expires: NOW / 1000 + 7 * 24 * HOUR / 1000 },
  ], ctRule.sessionCookie)?.name === 'zzQQxx0001T');
check('电信：没有 S 兄弟时不误选', pickKeySessionCookie([{ name: 'yyyT', expires: NOW / 1000 + 7 * 24 * HOUR / 1000 }], ctRule.sessionCookie) === null);

// 会话状态：有效 / 过期 / 未登录 / 未标定
const stOk = buildSessionStatus({ cookies: CMCC_COOKIES, spec: cmccRule.sessionCookie, now: NOW });
check('会话有效 → state=ok', stOk.state === 'ok');
check('会话有效 → 剩余时间约 30 分钟', Math.round(stOk.ttlMs / 60000) === 30);
check('会话有效 → 认出关键 cookie', stOk.keyCookie === 'chargeresource');

const stExpired = buildSessionStatus({
  cookies: [{ name: 'chargeresource', expires: NOW / 1000 - 60 }],
  spec: cmccRule.sessionCookie, now: NOW,
});
check('关键 cookie 已过期 → state=expired', stExpired.state === 'expired');
check('已过期 → 剩余时间为负', stExpired.ttlMs < 0);

check('无登录态 → state=not_logged_in', buildSessionStatus({ cookies: null, spec: cmccRule.sessionCookie, now: NOW }).state === 'not_logged_in');
check('空 cookie 列表 → state=not_logged_in', buildSessionStatus({ cookies: [], spec: cmccRule.sessionCookie, now: NOW }).state === 'not_logged_in');
check('未标定 → state=uncalibrated', buildSessionStatus({ cookies: CMCC_COOKIES, spec: null, now: NOW }).state === 'uncalibrated');
check('有登录态但认不出关键 cookie → state=key_unknown',
  buildSessionStatus({ cookies: [{ name: 'xxx', expires: NOW / 1000 + 600 }], spec: cmccRule.sessionCookie, now: NOW }).state === 'key_unknown');

// 续命倒计时 = 下一次访问网厅 = 保活与余额巡检中较早的那个
const stRenew = buildSessionStatus({
  cookies: CMCC_COOKIES, spec: cmccRule.sessionCookie, now: NOW,
  timing: {
    keepAliveIntervalMs: 10 * 60 * 1000,
    monitorIntervalMs: HOUR,
    lastKeepAliveAt: NOW - 5 * 60 * 1000,  // 保活 10 分钟节奏 → 5 分钟后到期
    lastMonitorAt: NOW - 30 * 60 * 1000,   // 巡检 1 小时节奏 → 30 分钟后到期
  },
});
check('续命取较早的那个（保活 5 分钟 < 巡检 30 分钟）', stRenew.nextRenewAt === NOW + 5 * 60 * 1000);
check('续命来源标记为 keepalive', stRenew.renewSource === 'keepalive');

const stRenewMonitor = buildSessionStatus({
  cookies: CMCC_COOKIES, spec: cmccRule.sessionCookie, now: NOW,
  timing: {
    keepAliveIntervalMs: 12 * HOUR,
    monitorIntervalMs: HOUR,
    lastKeepAliveAt: NOW - 11 * HOUR,
    lastMonitorAt: NOW - 10 * 60 * 1000,   // 巡检 50 分钟后到期，比保活早
  },
});
check('续命取巡检时（电信：巡检 1 小时 < 保活 12 小时）', stRenewMonitor.nextRenewAt === NOW + 50 * 60 * 1000);
check('续命来源标记为 monitor', stRenewMonitor.renewSource === 'monitor');

check('从未保活/巡检 → 无续命时刻', buildSessionStatus({
  cookies: CMCC_COOKIES, spec: cmccRule.sessionCookie, now: NOW,
  timing: { keepAliveIntervalMs: 10 * 60 * 1000, monitorIntervalMs: HOUR, lastKeepAliveAt: 0, lastMonitorAt: 0 },
}).nextRenewAt === null);

// 观测到的会话状态优先于 cookie 过期时间的乐观估计：
// 实测（2026-11-20）电信的 7 天票据尚未过期，服务端已作废会话、页面已回未登录态。
check('观测到已掉线 → state=not_logged_in（尽管票据未过期）',
  buildSessionStatus({ cookies: CT_COOKIES, spec: ctRule.sessionCookie, observedAlive: false, now: NOW }).state === 'not_logged_in');
check('观测到已掉线 → 不再给剩余时间',
  buildSessionStatus({ cookies: CT_COOKIES, spec: ctRule.sessionCookie, observedAlive: false, now: NOW }).ttlMs === null);
check('观测到存活 → 仍按 cookie 过期时间算',
  buildSessionStatus({ cookies: CMCC_COOKIES, spec: cmccRule.sessionCookie, observedAlive: true, now: NOW }).state === 'ok');
check('未观测过（null）→ 不覆盖 cookie 判定',
  buildSessionStatus({ cookies: CMCC_COOKIES, spec: cmccRule.sessionCookie, observedAlive: null, now: NOW }).state === 'ok');

// ===== 5. 登录态完整性校验（残缺登录态保护）=====
// 背景（实测 2026-11-20）：登录判定刚成立时，189.cn 还没下发网关会话 cookie
// 与用户档案 cookie；此时保存会得到一份残缺登录态，抓取必然报未登录。
const CT_REQUIRED = CARRIER_RULES.carrier_ct.sessionRequiredCookies;
check('电信声明了必须存在的关键 cookie', Array.isArray(CT_REQUIRED) && CT_REQUIRED.length === 2);

// 完整登录态（16:04 那份，含网关 token 与档案 cookie）
const CT_FULL_COOKIES = [
  { name: '_secure_gateway_v2_token_jxAeo079E' },
  { name: '_user_location_auth_v2_profile' },
  { name: 'yiUIIlbdQT3fT' },
];
// 残缺登录态（17:14 那份：登录判定刚成立就保存，网关 cookie 尚未下发）
const CT_PARTIAL_COOKIES = [
  { name: 'EcsLoginToken' },
  { name: 'yiUIIlbdQT3fT' },
  { name: 'yiUIIlbdQT3fS' },
];

check('完整登录态不缺关键 cookie', missingRequiredCookies(CT_FULL_COOKIES, CT_REQUIRED).length === 0);
check('残缺登录态被识别出缺失网关 token',
  missingRequiredCookies(CT_PARTIAL_COOKIES, CT_REQUIRED).includes('_secure_gateway_v2_token'));
check('残缺登录态被识别出缺失档案 cookie',
  missingRequiredCookies(CT_PARTIAL_COOKIES, CT_REQUIRED).includes('_user_location_auth_v2_profile'));
check('无规则时不误报缺失', missingRequiredCookies(CT_PARTIAL_COOKIES, null).length === 0);
check('空 cookie 列表全算缺失', missingRequiredCookies([], CT_REQUIRED).length === 2);

// 退化检测：新状态比旧状态差 → 必须拦住这次写回
check('完整→残缺 被判定为退化',
  findDegradedCookies(CT_PARTIAL_COOKIES, CT_FULL_COOKIES, CT_REQUIRED).length === 2);
check('完整→完整 不算退化',
  findDegradedCookies(CT_FULL_COOKIES, CT_FULL_COOKIES, CT_REQUIRED).length === 0);
check('旧状态本来就残缺 → 不算退化（首次登录场景）',
  findDegradedCookies(CT_PARTIAL_COOKIES, CT_PARTIAL_COOKIES, CT_REQUIRED).length === 0);
check('旧状态没有该文件 → 不算退化',
  findDegradedCookies(CT_PARTIAL_COOKIES, null, CT_REQUIRED).length === 0);

// ===== 6. 会话寿命与「续命」机制（实测 2026-11-20 晚）=====
// 实测结论（两家的机制不同，是本次掉线的根因）：
//   移动：会话是「登录后固定 ~60 分钟」的服务端硬上限。访问只把 chargeresource 的
//         *过期时间*推后（值不变），服务端不换发会话 → 保活续不回来。
//   电信：每次访问服务端会换发票据（值变）→ 访问能续命，窗口约 60 分钟。
//   所以「预计存活」必须按会话寿命算，而不是按 cookie 票据寿命算
//   （电信票据写着 7 天，实际 1 小时就死——那是假值）。
check('移动规则标定了会话寿命', typeof CARRIER_RULES.carrier_cmcc.sessionMaxAgeMs === 'number');
check('电信规则标定了会话寿命', typeof CARRIER_RULES.carrier_ct.sessionMaxAgeMs === 'number');
check('移动标记为「访问续不了命」', CARRIER_RULES.carrier_cmcc.sessionRenewable === false);
check('电信标记为「访问能续命」', CARRIER_RULES.carrier_ct.sessionRenewable === true);
check('移动会话寿命约 50~60 分钟',
  CARRIER_RULES.carrier_cmcc.sessionMaxAgeMs >= 40 * 60 * 1000 &&
  CARRIER_RULES.carrier_cmcc.sessionMaxAgeMs <= 70 * 60 * 1000);
check('电信会话寿命约 60 分钟',
  CARRIER_RULES.carrier_ct.sessionMaxAgeMs >= 50 * 60 * 1000 &&
  CARRIER_RULES.carrier_ct.sessionMaxAgeMs <= 90 * 60 * 1000);
// 电信保活间隔必须小于会话窗口，否则必然掉线（原先设成 12 小时 = 100% 掉线）
check('电信保活间隔 < 会话窗口',
  CARRIER_KEEPALIVE_MS.carrier_ct < CARRIER_RULES.carrier_ct.sessionMaxAgeMs);
check('移动保活间隔仍远小于 1 小时（用于尽早发现失效）',
  CARRIER_KEEPALIVE_MS.carrier_cmcc <= 15 * 60 * 1000);

// 「预计存活」取会话寿命与票据寿命里更短的那个
const CMCC_MAX = CARRIER_RULES.carrier_cmcc.sessionMaxAgeMs;
const CT_MAX = CARRIER_RULES.carrier_ct.sessionMaxAgeMs;
{
  // 移动：登录 40 分钟前，cookie 票据还有 30 天，但会话只剩 20 分钟
  const st = buildSessionStatus({
    cookies: CMCC_COOKIES, spec: cmccRule.sessionCookie, now: NOW,
    sessionStartedAt: NOW - 40 * 60 * 1000,
    lastRenewedAt: NOW - 2 * 60 * 1000,
    maxAgeMs: CMCC_MAX, renewable: false,
  });
  check('移动：预计存活按会话寿命算（不是票据寿命）',
    st.ttlMs <= CMCC_MAX && st.ttlMs > 0, `ttl=${Math.round((st.ttlMs || 0) / 60000)} 分钟`);
  check('移动：即使刚访问过也不刷新窗口（访问续不了命）',
    st.ttlMs <= (CMCC_MAX - 40 * 60 * 1000) + 1000);
}
{
  // 电信：上次成功访问 10 分钟前 → 窗口从上次访问起算，还剩 ~50 分钟
  const st = buildSessionStatus({
    cookies: CT_COOKIES, spec: ctRule.sessionCookie, now: NOW,
    sessionStartedAt: NOW - 3 * 3600 * 1000,
    lastRenewedAt: NOW - 10 * 60 * 1000,
    maxAgeMs: CT_MAX, renewable: true,
  });
  check('电信：窗口从上次成功访问起算',
    st.ttlMs <= (CT_MAX - 10 * 60 * 1000) + 1000 && st.ttlMs > 0,
    `ttl=${Math.round((st.ttlMs || 0) / 60000)} 分钟`);
}
{
  // 即将失效：剩余不足 15 分钟 → expiring（提前预警）
  const st = buildSessionStatus({
    cookies: CMCC_COOKIES, spec: cmccRule.sessionCookie, now: NOW,
    sessionStartedAt: NOW - (CMCC_MAX - 5 * 60 * 1000),
    maxAgeMs: CMCC_MAX, renewable: false,
  });
  check('移动：剩余不足 15 分钟 → state=expiring', st.state === 'expiring');
  check('移动：expiring 时仍给出剩余时间', st.ttlMs !== null && st.ttlMs > 0);
}
{
  // 已确认掉线仍然优先（地面真相）
  const st = buildSessionStatus({
    cookies: CT_COOKIES, spec: ctRule.sessionCookie, now: NOW, observedAlive: false,
    sessionStartedAt: NOW - 10 * 60 * 1000, maxAgeMs: CT_MAX, renewable: true,
  });
  check('观测到掉线仍优先于寿命估算', st.state === 'not_logged_in' && st.ttlMs === null);
}
check('会话状态里带上 renewable（供前端区分「续命」是否真的有用）',
  buildSessionStatus({ cookies: CMCC_COOKIES, spec: cmccRule.sessionCookie, now: NOW }).renewable === false);
check('可续命的运营商 renewable=true',
  buildSessionStatus({ cookies: CT_COOKIES, spec: ctRule.sessionCookie, now: NOW, renewable: true }).renewable === true);

// ===== 7. 会话元信息（登录时刻 / 上次有效访问 / 绑定号码）=====
{
  const tmp = path.join(os.tmpdir(), `sessmeta-${process.pid}.json`);
  const f = `${tmp}`;
  try { fs.unlinkSync(f); } catch {}
  check('元信息文件初始不存在 → 读出 null', readSessionMeta(f) === null);
  markSessionLoggedIn(f, '178****6402');
  const m1 = readSessionMeta(f);
  check('登录后记录了登录时刻', typeof m1.loggedInAt === 'number' && m1.loggedInAt > 0);
  check('登录后记录了绑定号码', m1.account === '178****6402');
  const before = m1.lastAliveAt;
  // 模拟过了一段时间后的有效访问
  writeSessionMeta(f, { lastAliveAt: before + 60000 });
  const m2 = readSessionMeta(f);
  check('有效访问更新了 lastAliveAt', m2.lastAliveAt === before + 60000);
  check('有效访问不会清掉登录时刻', m2.loggedInAt === m1.loggedInAt);
  markSessionDead(f);
  const m3 = readSessionMeta(f);
  check('会话失效后清掉 lastAliveAt', m3.lastAliveAt === null);
  check('会话失效后保留登录时刻（供追溯）', m3.loggedInAt === m1.loggedInAt);
  try { fs.unlinkSync(f); } catch {}
}
check('能从页面正文解析脱敏号码', parseMaskedAccount('欢迎回来 178****6402 当前套餐') === '178****6402');
check('正文里没有号码时返回 null', parseMaskedAccount('普通页面文本') === null);

const fail = results.filter((r) => !r.pass);
console.log(`\n结果：共 ${results.length} 项，通过 ${results.length - fail.length}，失败 ${fail.length}`);
if (fail.length) {
  console.log('失败项：');
  for (const f of fail) console.log('  - ' + f.name);
}
process.exit(fail.length ? 1 : 0);
