#!/usr/bin/env node
// 三大运营商个人卡余额：解析逻辑单元测试（不联网、不依赖真实网厅）
// 覆盖：规则解析、内置规则套用、余额提取（多文案变体 / 负数 / 千分位 / 误命中防护）
import { parseScrapeRule, enrichRuleWithBuiltin, extractBalance, CARRIER_RULES, CARRIER_ENTRY_URLS, SAFE_KEYWORD_BY_KEY, STORAGE_KEY_BY_NAME, detectCarrierLoggedIn, classifySessionState, BROWSER_ARGS, CARRIER_KEEPALIVE_MS, storageKeyFor, ruleKeyFor, balanceExtractionRule } from '../src/services/scraper_wallets.mjs';
import { pickKeySessionCookie, buildSessionStatus, missingRequiredCookies, findDegradedCookies, classifySessionObservation, planStaggeredRelogin, describeDeadReason } from '../src/services/session_status.mjs';
import { readSessionMeta, writeSessionMeta, markSessionLoggedIn, markSessionAlive, markSessionDead, markSessionKeepalive, parseMaskedAccount } from '../src/services/session_meta.mjs';
import { redact } from '../src/services/logger.js';
import { keepAliveMasterEnabled, keepAliveDisabledFor, keepAliveEnabledFor, keepAliveIntervalMs } from '../src/services/keepalive_policy.mjs';
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

// ===== 6. 会话寿命与「续命」机制（实测 2026-11-20 晚 + 11-21 复核）=====
// 实测结论（两家机制相同，是本次掉线的根因）：
//   两家的会话都是「登录后固定 ~60 分钟」的服务端硬上限。
//   移动：每次访问后 chargeresource 的*过期时间*被推后（值不变），服务端不换发会话。
//   电信：每次访问服务端**确实换发了票据**（值变），但会话照样在固定时长后失效
//         （11-21 复核：03:01 保活换发票据、03:26 巡检已判失效）。
//   所以「访问能续命」对两家都不成立——保活的价值只是「尽早发现失效」。
//   「预计存活」必须按会话寿命算，而不是按 cookie 票据寿命算
//   （电信票据写着 7 天，实际 1 小时就死——那是假值）。
check('移动规则标定了会话寿命', typeof CARRIER_RULES.carrier_cmcc.sessionMaxAgeMs === 'number');
check('电信规则标定了会话寿命', typeof CARRIER_RULES.carrier_ct.sessionMaxAgeMs === 'number');
check('移动标记为「访问续不了命」', CARRIER_RULES.carrier_cmcc.sessionRenewable === false);
// 11-21 复核推翻了原先「电信能靠访问续命」的结论（当时只看到票据换发，没等到死亡时刻）
check('电信同样标记为「访问续不了命」', CARRIER_RULES.carrier_ct.sessionRenewable === false);
check('移动会话寿命约 50~70 分钟',
  CARRIER_RULES.carrier_cmcc.sessionMaxAgeMs >= 50 * 60 * 1000 &&
  CARRIER_RULES.carrier_cmcc.sessionMaxAgeMs <= 70 * 60 * 1000);
check('电信会话寿命约 50~90 分钟',
  CARRIER_RULES.carrier_ct.sessionMaxAgeMs >= 50 * 60 * 1000 &&
  CARRIER_RULES.carrier_ct.sessionMaxAgeMs <= 90 * 60 * 1000);
// 保活间隔必须小于会话窗口，否则「尽早发现失效」都做不到（原先电信设成 12 小时 = 100% 掉线）
check('电信保活间隔 < 会话窗口',
  CARRIER_KEEPALIVE_MS.carrier_ct < CARRIER_RULES.carrier_ct.sessionMaxAgeMs);
check('移动保活间隔仍远小于 1 小时（用于尽早发现失效）',
  CARRIER_KEEPALIVE_MS.carrier_cmcc <= 15 * 60 * 1000);
// 电信保活改走完整抓取路径（keepaliveFullScrape）——独立于 sessionRenewable，
// 否则 sessionRenewable 变 false 后保活会退化成只访问入口页
check('电信保活走完整抓取路径', CARRIER_RULES.carrier_ct.keepaliveFullScrape === true);
check('移动保活不强制走完整抓取路径（首页足够）',
  CARRIER_RULES.carrier_cmcc.keepaliveFullScrape !== true);

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
  // 电信：访问**不**延长会话寿命（11-21 复核）——窗口从「登录时刻」起算，
  // 即使刚访问过也不刷新。登录 30 分钟前 → 还剩 ~30 分钟（窗口 60 分钟）
  const st = buildSessionStatus({
    cookies: CT_COOKIES, spec: ctRule.sessionCookie, now: NOW,
    sessionStartedAt: NOW - 30 * 60 * 1000,
    lastRenewedAt: NOW - 10 * 60 * 1000,
    maxAgeMs: CT_MAX, renewable: false,
  });
  check('电信：窗口从登录时刻起算（访问不刷新）',
    st.ttlMs <= (CT_MAX - 30 * 60 * 1000) + 1000 && st.ttlMs > 0,
    `ttl=${Math.round((st.ttlMs || 0) / 60000)} 分钟`);
  check('电信：刚访问过也不延长寿命（否则应更长）',
    st.ttlMs <= (CT_MAX - 10 * 60 * 1000) + 1000,
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
  check('会话失效后记录了失效时刻', typeof m3.deadAt === 'number' && m3.deadAt > 0);
  try { fs.unlinkSync(f); } catch {}
}

// ===== 7b. 用户自行扫码登录时（我们的脚本没参与）的锚点兜底 =====
// 场景（实测 2026-11-21）：用户在自己的浏览器里扫码登录，登录态文件被刷新了，
// 但我们的登录脚本没跑过 → meta 里 loggedInAt 为空。
// 此时倒计时必须能用「会话从失效恢复为有效的那一刻」当锚点，否则
// 「预计存活」永远算不出来、预警也不会触发。
{
  const f = path.join(os.tmpdir(), `sessmeta-revive-${process.pid}.json`);
  try { fs.unlinkSync(f); } catch {}
  // 先标记失效（模拟上一轮已经死了）
  markSessionDead(f);
  check('失效状态：没有登录时刻', readSessionMeta(f).loggedInAt === null);
  // 用户重新扫码后，第一次有效访问
  markSessionAlive(f);
  const m = readSessionMeta(f);
  check('恢复有效后记录了 aliveSince', typeof m.aliveSince === 'number' && m.aliveSince > 0);
  check('恢复有效后清掉 deadAt', m.deadAt === null);
  check('恢复有效后仍没有登录时刻（脚本没参与）', m.loggedInAt === null);
  // 用 aliveSince 当锚点，倒计时应该算得出来（且偏保守）
  const st = buildSessionStatus({
    cookies: CMCC_COOKIES, spec: cmccRule.sessionCookie, now: NOW,
    sessionStartedAt: m.loggedInAt, revivedAt: m.aliveSince,
    lastRenewedAt: m.lastAliveAt,
    maxAgeMs: CARRIER_RULES.carrier_cmcc.sessionMaxAgeMs, renewable: false,
  });
  check('无登录时刻时用 aliveSince 兜底算出剩余时间', st.ttlMs !== null && st.ttlMs > 0,
    `ttl=${Math.round((st.ttlMs || 0) / 60000)} 分钟`);
  check('锚点来源标记为 revived', st.anchorSource === 'revived', `anchorSource=${st.anchorSource}`);
  try { fs.unlinkSync(f); } catch {}
}
{
  // 登录时刻存在时，优先用它（比 aliveSince 准）
  const st = buildSessionStatus({
    cookies: CMCC_COOKIES, spec: cmccRule.sessionCookie, now: NOW,
    sessionStartedAt: NOW - 30 * 60 * 1000,
    revivedAt: NOW - 5 * 60 * 1000,
    maxAgeMs: CARRIER_RULES.carrier_cmcc.sessionMaxAgeMs, renewable: false,
  });
  check('有登录时刻时优先用它当锚点', st.anchorSource === 'login', `anchorSource=${st.anchorSource}`);
}
check('能从页面正文解析脱敏号码', parseMaskedAccount('欢迎回来 178****6402 当前套餐') === '178****6402');
check('正文里没有号码时返回 null', parseMaskedAccount('普通页面文本') === null);

// ===== 9. 会话观测三态判定 =====
// 背景（实测 2026-11-21）：会话状态此前只由巡检写入，手动刷新不写——
// 用户重新扫码后手动刷新能抓到余额，界面却仍显示「未登录」。
// 修复后由 refreshPlatformBalance 统一记录，判定必须区分三态。
check('抓取成功 → 观测为存活', classifySessionObservation({ ok: true, balance: 75.9 }) === 'alive');
check('跳登录页 → 观测为失效',
  classifySessionObservation({ ok: false, error: '中国移动话费 未登录（跳转至 https://login.10086.cn/login.html）' }) === 'dead');
check('跳登录页（另一种文案）→ 观测为失效',
  classifySessionObservation({ ok: false, error: '中国电信话费 未登录（页面已无登录标识，余额显示为占位符）' }) === 'dead');
check('与登录态无关的失败 → 观测未知（不改状态）',
  classifySessionObservation({ ok: false, error: '中国移动话费: 页面中未找到余额（关键字="账户余额"）' }) === 'unknown');
check('网络异常 → 观测未知', classifySessionObservation({ ok: false, error: 'net::ERR_CONNECTION_TIMED_OUT' }) === 'unknown');
check('空结果 → 观测未知', classifySessionObservation(null) === 'unknown');

// ===== 10. 首次失效时刻不被覆盖（2026-11-21 16:37） =====
// 背景：用户问「多久掉的」时，deadAt 每次观测到失效都被覆盖，
// 只能拿到最后一次确认时刻（差了两个多小时）。现在 deadAt 是首次失效时刻。
{
  const f = path.join(os.tmpdir(), `meta-dead-${process.pid}.json`);
  try { fs.unlinkSync(f); } catch {}
  markSessionLoggedIn(f);
  const t1 = Date.now();
  markSessionDead(f, '跳转登录页');
  const m1 = readSessionMeta(f);
  check('失效时记录了首次失效时刻', typeof m1.deadAt === 'number' && m1.deadAt >= t1);
  check('失效时记录了最近一次确认时刻', typeof m1.lastDeadAt === 'number');
  check('失效时记下了原因', m1.deadReason === '跳转登录页');
  // 隔一会儿再观测到失效：不覆盖首次时刻，但更新最近确认时刻
  const firstDead = m1.deadAt;
  writeSessionMeta(f, { lastDeadAt: firstDead + 60000 });
  const m2 = readSessionMeta(f);
  check('后续观测不覆盖首次失效时刻', m2.deadAt === firstDead);
  check('后续观测会更新最近确认时刻', m2.lastDeadAt === firstDead + 60000);
  // 重新登录 = 新会话周期，失效时刻应清空
  markSessionLoggedIn(f);
  const m3 = readSessionMeta(f);
  check('重新登录后清掉首次失效时刻', m3.deadAt === null && m3.lastDeadAt === null);
  check('重新登录后清掉失效原因', m3.deadReason === null);
  try { fs.unlinkSync(f); } catch {}
}

// ===== 11. 保活结果落到会话元信息 =====
// 为什么要记（实测 2026-11-21）：原先保活异常只打一行日志，
// 界面上与「保活根本没跑」长得一模一样，事后无法分辨。
{
  const f = path.join(os.tmpdir(), `meta-ka-${process.pid}.json`);
  try { fs.unlinkSync(f); } catch {}
  markSessionLoggedIn(f);
  markSessionKeepalive(f, 'error', 'net::ERR_CONNECTION_REFUSED');
  const m = readSessionMeta(f);
  check('保活异常被记录', m.keepaliveState === 'error');
  check('保活异常原因被记录', m.keepaliveReason === 'net::ERR_CONNECTION_REFUSED');
  check('保活运行时刻被记录', typeof m.keepaliveAt === 'number');
  markSessionKeepalive(f, 'dead', '服务端下发会话失效标记 ssoFail');
  const m2 = readSessionMeta(f);
  check('保活判定失效被记录', m2.keepaliveState === 'dead');
  check('保活判定失效覆盖上一次异常状态', m2.keepaliveReason.includes('ssoFail'));
  try { fs.unlinkSync(f); } catch {}
}

// ===== 11b. 保活状态与抓取状态必须分开（2026-11-21 实测发现的缺陷） =====
// 实测：markSessionDead 早先一并写 keepaliveState='dead'，
// 于是巡检刷新失败（也走 markSessionDead）会把 keepaliveAt 刷成刷新时刻——
// 界面于是显示「保活判定失效」，而实际上保活根本没判定过失效。
// 这两个链路必须互不干扰，否则「保活跑没跑」就分不清了。
{
  const f = path.join(os.tmpdir(), `meta-sep-${process.pid}.json`);
  try { fs.unlinkSync(f); } catch {}
  markSessionLoggedIn(f);
  markSessionKeepalive(f, 'alive', null);
  const before = readSessionMeta(f);
  check('保活成功状态已记录', before.keepaliveState === 'alive');
  // 抓取路径判定失效（巡检刷新失败）
  markSessionDead(f, '跳转登录页');
  const after = readSessionMeta(f);
  check('抓取判定失效不改动保活状态', after.keepaliveState === 'alive');
  check('抓取判定失效不改动保活时刻', after.keepaliveAt === before.keepaliveAt);
  check('抓取判定失效照样记录了会话失效', after.deadAt !== null && after.deadReason === '跳转登录页');
  // 反过来：保活判定失效也不应篡改会话失效原因
  markSessionKeepalive(f, 'dead', '页面已无登录标识');
  const after2 = readSessionMeta(f);
  check('保活判定失效不篡改会话失效原因', after2.deadReason === '跳转登录页');
  check('保活判定失效记录了自己的原因', after2.keepaliveReason === '页面已无登录标识');
  try { fs.unlinkSync(f); } catch {}
}

// ===== 12. 错峰重登计划 =====
// 背景（实测 2026-11-21）：三家先后扫码登录，寿命都从各自登录时刻起算，
// 失效时刻只差几分钟，会连着掉。错峰要把相邻两家的建议重登时刻拉开。
{
  const NOW = 1_700_000_000_000;
  const maxAge = 60 * 60 * 1000;
  const plan = planStaggeredRelogin([
    { platformId: 7, name: 'C', anchorAt: NOW - 50 * 60 * 1000, maxAgeMs: maxAge },
    { platformId: 5, name: 'A', anchorAt: NOW - 55 * 60 * 1000, maxAgeMs: maxAge },
    { platformId: 6, name: 'B', anchorAt: NOW - 52 * 60 * 1000, maxAgeMs: maxAge },
  ], { now: NOW, staggerMs: 20 * 60 * 1000 });
  check('错峰计划按失效先后排序', plan[0].platformId === 5 && plan[1].platformId === 6 && plan[2].platformId === 7,
    plan.map((p) => `${p.name}(${p.order})`).join(' '));
  check('错峰计划给出序号', plan.map((p) => p.order).join(',') === '1,2,3');
  const gap1 = plan[1].suggestedReloginAt - plan[0].suggestedReloginAt;
  const gap2 = plan[2].suggestedReloginAt - plan[1].suggestedReloginAt;
  check('相邻两家的建议重登时刻已拉开', gap1 >= 20 * 60 * 1000 && gap2 >= 20 * 60 * 1000,
    `间隔 ${Math.round(gap1 / 60000)}/${Math.round(gap2 / 60000)} 分钟`);
  check('建议重登时刻不早于自己的失效时刻',
    plan.every((p) => p.suggestedReloginAt >= p.expiryAt));
  // 已过期的（失效时刻在过去）→ 建议时刻不早于“现在”
  const pastPlan = planStaggeredRelogin([
    { platformId: 5, name: 'A', anchorAt: NOW - 120 * 60 * 1000, maxAgeMs: maxAge },
  ], { now: NOW, staggerMs: 20 * 60 * 1000 });
  check('已失效的建议重登时刻不早于现在', pastPlan[0].suggestedReloginAt >= NOW);
  // 未标定窗口的排在最后
  const mixed = planStaggeredRelogin([
    { platformId: 9, name: '未标定', anchorAt: NOW, maxAgeMs: null },
    { platformId: 5, name: 'A', anchorAt: NOW, maxAgeMs: maxAge },
  ], { now: NOW, staggerMs: 20 * 60 * 1000 });
  check('未标定会话窗口的排在最后', mixed[mixed.length - 1].platformId === 9);
}

// ===== 13. 日志落盘：长 token 打码 =====
// 为什么要打码：日志里可能出现 cookie 值、票据等长串凭据，
// 不能把原文写进日志文件。
check('长 token 被打码', redact('chargeresource=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ').includes('***('));
check('普通文案不受影响', redact('中国移动话费 会话已失效（跳转登录页）') === '中国移动话费 会话已失效（跳转登录页）');
check('短串不被误伤', redact('chargeresource=abc123') === 'chargeresource=abc123');

// ===== 14. 运营商余额提取规则 =====
// 为什么需要：extractBalance 认 keywords，而 CARRIER_RULES 里存的是 balanceKeywords，
// 直接丢进去会静默取不到余额（保活就白访问了一次网厅）。
{
  const cmccRule = balanceExtractionRule(CARRIER_RULES.carrier_cmcc);
  check('提取规则带上了关键字组', Array.isArray(cmccRule.keywords) && cmccRule.keywords.includes('可用余额'));
  check('提取规则带上了正则', typeof cmccRule.regex === 'string' && cmccRule.regex.length > 0);
  const ctRule = balanceExtractionRule(CARRIER_RULES.carrier_ct);
  check('电信提取规则标记了「数值在前」', ctRule.valueBeforeLabel === true);
  check('电信提取规则能取出余额', extractBalance('54.61元\n账户余额', ctRule) === 54.61);
  check('移动提取规则能取出余额', extractBalance('可用余额 70.90元', cmccRule) === 70.9);
}

// ===== 15. 失效原因提取 =====
// 为什么需要（实测 2026-11-21 16:37）：用户问「多久掉的」，
// 界面上只写「未登录」，答不了；要能说出「什么时候掉的」与「为什么掉的」。
check('跳登录页 → 跳转登录页',
  describeDeadReason('中国移动话费 未登录（跳转至 https://login.10086.cn/login.html）') === '跳转登录页');
check('正文无登录标识 → 页面已无登录标识',
  describeDeadReason('中国电信话费 未登录（页面已无登录标识，余额显示为占位符）') === '页面已无登录标识');
check('服务端失效标记 → 服务端下发会话失效标记',
  describeDeadReason('中国移动话费 会话已失效（服务端下发会话失效标记 ssoFail）') === '服务端下发会话失效标记');
check('其他文案 → 归为会话已失效', describeDeadReason('网络异常') === '会话已失效');
check('空文案 → 归为会话已失效', describeDeadReason('') === '会话已失效');

// ===== 16. 保活开关（config.json 的 keepalive 段）=====
// 为什么需要（2026-11-24）：保活会定期访问网厅，189.cn 站点级拦无头、
// 只能用有头窗口抓 → 每 10~20 分钟弹一次浏览器窗口。用户要求关掉移动和电信的自动续命。
// 开关做成配置，用户改一行 json + 重启即可，不用改代码。
const cfgNone = {};
check('未配置 keepalive 段时总开关默认开（向后兼容）', keepAliveMasterEnabled(cfgNone) === true);
check('未配置时三家都照旧保活',
  keepAliveEnabledFor('carrier_cmcc', cfgNone) && keepAliveEnabledFor('carrier_ct', cfgNone));
check('未配置时保活间隔取自常量',
  keepAliveIntervalMs('carrier_cmcc', cfgNone) === CARRIER_KEEPALIVE_MS.carrier_cmcc);

const cfgOff = { keepalive: { enabled: true, disabledProviders: ['carrier_cmcc', 'carrier_ct'] } };
check('disabledProviders 能关掉移动', keepAliveEnabledFor('carrier_cmcc', cfgOff) === false);
check('disabledProviders 能关掉电信', keepAliveEnabledFor('carrier_ct', cfgOff) === false);
check('关掉的运营商保活间隔归零（调度器据此跳过）',
  keepAliveIntervalMs('carrier_cmcc', cfgOff) === 0 && keepAliveIntervalMs('carrier_ct', cfgOff) === 0);
check('没被关掉的运营商（联通）不受影响', keepAliveEnabledFor('carrier_cu', cfgOff) === true);
check('没被关掉的运营商间隔保持常量值',
  keepAliveIntervalMs('carrier_cu', cfgOff) === CARRIER_KEEPALIVE_MS.carrier_cu);

const cfgAllOff = { keepalive: { enabled: false } };
check('总开关 false 能关掉全部运营商',
  !keepAliveEnabledFor('carrier_cmcc', cfgAllOff) && !keepAliveEnabledFor('carrier_ct', cfgAllOff)
  && !keepAliveEnabledFor('carrier_cu', cfgAllOff));
check('总开关关闭时所有间隔归零',
  keepAliveIntervalMs('carrier_cu', cfgAllOff) === 0);
check('disabledProviders 判定独立于总开关',
  keepAliveDisabledFor('carrier_cmcc', cfgOff) === true
  && keepAliveDisabledFor('carrier_cu', cfgOff) === false);

const fail = results.filter((r) => !r.pass);
console.log(`\n结果：共 ${results.length} 项，通过 ${results.length - fail.length}，失败 ${fail.length}`);
if (fail.length) {
  console.log('失败项：');
  for (const f of fail) console.log('  - ' + f.name);
}
process.exit(fail.length ? 1 : 0);
