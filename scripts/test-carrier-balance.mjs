#!/usr/bin/env node
// 三大运营商个人卡余额：解析逻辑单元测试（不联网、不依赖真实网厅）
// 覆盖：规则解析、内置规则套用、余额提取（多文案变体 / 负数 / 千分位 / 误命中防护）
import { parseScrapeRule, enrichRuleWithBuiltin, extractBalance, CARRIER_RULES, CARRIER_ENTRY_URLS, SAFE_KEYWORD_BY_KEY, STORAGE_KEY_BY_NAME } from '../src/services/scraper_wallets.mjs';

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

// 用户显式配置的规则不被内置覆盖
const custom = enrichRuleWithBuiltin(parseScrapeRule('{"keyword":"我的余额","regex":"我的余额(\\\\d+)","entries":["我的入口"]}'), '中国移动话费', 'carrier_cmcc');
check('用户自定义关键字优先', custom.keyword === '我的余额');
check('用户自定义正则优先', custom.regex.includes('我的余额'));
check('用户自定义入口优先', custom.entries[0] === '我的入口');

// ===== 3. 余额提取：三家真实文案变体 =====
const cmccRule = enrichRuleWithBuiltin(parseScrapeRule(''), '中国移动话费', 'carrier_cmcc');
const ctRule = enrichRuleWithBuiltin(parseScrapeRule(''), '中国电信话费', 'carrier_ct');
const cuRule = enrichRuleWithBuiltin(parseScrapeRule(''), '中国联通话费', 'carrier_cu');

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

const fail = results.filter((r) => !r.pass);
console.log(`\n结果：共 ${results.length} 项，通过 ${results.length - fail.length}，失败 ${fail.length}`);
if (fail.length) {
  console.log('失败项：');
  for (const f of fail) console.log('  - ' + f.name);
}
process.exit(fail.length ? 1 : 0);
