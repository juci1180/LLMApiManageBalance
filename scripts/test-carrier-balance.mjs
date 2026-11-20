#!/usr/bin/env node
// 三大运营商个人卡余额：解析逻辑单元测试（不联网、不依赖真实网厅）
// 覆盖：规则解析、内置规则套用、余额提取（多文案变体 / 负数 / 千分位 / 误命中防护）
import { parseScrapeRule, enrichRuleWithBuiltin, extractBalance, CARRIER_RULES, CARRIER_ENTRY_URLS, SAFE_KEYWORD_BY_KEY, STORAGE_KEY_BY_NAME, detectCarrierLoggedIn, BROWSER_ARGS } from '../src/services/scraper_wallets.mjs';

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

const fail = results.filter((r) => !r.pass);
console.log(`\n结果：共 ${results.length} 项，通过 ${results.length - fail.length}，失败 ${fail.length}`);
if (fail.length) {
  console.log('失败项：');
  for (const f of fail) console.log('  - ' + f.name);
}
process.exit(fail.length ? 1 : 0);
