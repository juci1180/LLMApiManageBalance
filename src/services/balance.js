// 余额查询模块：支持不同平台的余额获取方式
// balance_type: 'api'（官方接口）/ 'scrape'（抓取）/ 'manual'（手动录入）

import db from '../db/index.js';
import { createHash, createHmac } from 'node:crypto';
import { scrapeMiniMaxBalance } from './scraper_minimax.mjs';
import { scrapeWalletBalance, parseScrapeRule, storageFileFor, storageKeyFor, enrichRuleWithBuiltin, CARRIER_ENTRY_URLS } from './scraper_wallets.mjs';
import { classifySessionObservation, describeDeadReason } from './session_status.mjs';
import { markSessionAlive, markSessionDead } from './session_meta.mjs';

// 火山引擎 OpenAPI 签名（HMAC-SHA256，类似 AWS SigV4）
function sha256hex(s) { return createHash('sha256').update(s).digest('hex'); }
function hmac(key, data) { return createHmac('sha256', key).update(data).digest(); }
function volcSign({ method, host, path, query, payload, ak, sk, date }) {
  // 规范 URI：多数接口为 '/'
  const canonicalUri = path || '/';
  // 规范化 query：按 key 字典序排序
  const sortedKeys = Object.keys(query).sort();
  const canonicalQuery = sortedKeys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
  // 头部（参与签名的只有 host 和 x-date）
  const headers = {
    'host': host,
    'x-date': date,
  };
  const canonicalHeaders = Object.keys(headers).sort()
    .map((k) => `${k}:${headers[k].trim()}\n`).join('');
  const signedHeaders = Object.keys(headers).sort().join(';');
  const payloadHash = sha256hex(payload || '');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const dateStr = date.slice(0, 8); // YYYYMMDD
  const region = 'cn-beijing';
  const service = 'billing';
  const credentialScope = `${dateStr}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', date, credentialScope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(sk, dateStr);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    canonicalQuery,
    authHeader: `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// 腾讯云 TC3 签名（HMAC-SHA256）
function tencentSign({ host, service, action, payload, secretId, secretKey, timestamp, date }) {
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedPayload = sha256hex(payload);
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, credentialScope, sha256hex(canonicalRequest)].join('\n');
  const kDate = createHmac('sha256', `TC3${secretKey}`).update(date).digest();
  const kService = createHmac('sha256', kDate).update(service).digest();
  const kSigning = createHmac('sha256', kService).update('tc3_request').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// 阿里云 RPC 签名（HMAC-SHA1，BssOpenAPI QueryAccountBalance）
function aliyunSign(params, sk) {
  const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const qs = Object.keys(params).sort().map((k) => `${pct(k)}=${pct(params[k])}`).join('&');
  const strToSign = 'GET&' + pct('/') + '&' + pct(qs);
  return { canonicalQuery: qs, signature: createHmac('sha1', sk + '&').update(strToSign).digest('base64') };
}

// 通过 JSON path 从返回体里取值，如 "total_available"、"result.balance"、"balance_infos[0].total_balance"
function getByPath(obj, path) {
  if (!path) return null;
  // 支持点号分隔和数组下标，如 a.b[0].c
  const tokens = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  return tokens.reduce((acc, key) => {
    if (acc == null) return null;
    return acc[key];
  }, obj);
}

// 平台 → 实际生效的抓取规则（含内置运营商规则）。
// 调度层要用它判断「这个平台能不能无头抓」——不能的话自动巡检就不该去试。
// 为什么必须与抓取路径用同一份规则（实测 2026-11-24）：
//   电信 189.cn 标记了 headlessBlocked（站点级拦无头）。如果调度层不知道这一点，
//   自动巡检就会用无头去抓 189.cn——拿不到内容（正文 0 字），
//   于是「页面为空」被误判成「未登录」，把用户刚扫码登上的会话又标成失效。
export function effectiveScrapeRule(platform) {
  if (!platform) return null;
  return enrichRuleWithBuiltin(parseScrapeRule(platform.balance_json_path), platform.name, platform.provider);
}

// 三大运营商个人卡抓取：与 scrape 模式同一套浏览器逻辑，
// 差别在于运营商的余额页需要从网厅首页点菜单进入，且没有统一的货币符号。
// trigger：'auto'（定时巡检）/ 'manual'（用户点按钮）。自动来源不开有头窗口——
// 那是弹窗的根源（实测 2026-11-24）；手动来源保持原有能力。
async function scrapeCarrier(platform, providerKey, trigger = 'manual') {
  const url = platform.balance_api_url || CARRIER_ENTRY_URLS[providerKey];
  if (!url) {
    throw new Error('运营商平台未配置网厅地址（balance_api_url）');
  }
  const rule = enrichRuleWithBuiltin(parseScrapeRule(platform.balance_json_path), platform.name, providerKey);
  // 登录态文件按「账号」唯一：同运营商的多个号码各用各的文件（传入 platform.id）
  const storageFile = storageFileFor(platform.name, providerKey, platform.id);
  if (!storageFile) {
    throw new Error(`尚未登录 ${platform.name}：请先运行 node scripts/wallet-login.mjs ${storageKeyFor(platform.name, providerKey, platform.id)} 完成一次网厅登录`);
  }
  const balance = await scrapeWalletBalance({
    url,
    rule,
    debugLabel: platform.name,
    storageFile,
    trigger,
    // 运营商网厅对无头浏览器反爬明显（实测电信 189.cn 无头下页面为空），
    // 无头失败时允许退回桌面 Chrome（真实浏览器指纹与登录态）
    allowCdpFallback: true,
  });
  return { balance, raw: {}, unit: platform.currency || '元', scraped: true };
}

// 内置平台余额查询器
const providers = {
  // OpenAI：admin key + /v1/organization/costs 算本月消耗，余额 = 预付额(platform.balance_json_path 存预付总额，默认 100) - 本月消耗
  // 需要出境代理时，设置环境变量 HTTPS_PROXY 即可（Node 原生 fetch 在 Node24 走 EnvHttpProxyAgent 需显式开启；这里用 undici-free 方案：仅在 HTTPS_PROXY 存在时提示）
  openai: async (platform) => {
    const key = platform.api_key;
    if (!key) throw new Error('OpenAI 需要配置 Admin Key');
    const prepayRaw = parseFloat(platform.balance_json_path);
    const prepay = Number.isFinite(prepayRaw) ? prepayRaw : 0; // 预付总额，可在 balance_json_path 字段填数字；未填按 0
    // OpenAI 需出境代理：启动服务时设置 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY 环境变量即可（Node 24 原生支持）
    const now = new Date();
    const start = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
    let url = `https://api.openai.com/v1/organization/costs?start_time=${start}&limit=180`;
    let used = 0;
    let pages = 0;
    while (url && pages < 10) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      const text = await res.text();
      if (!res.ok) throw new Error(`OpenAI costs 查询失败: HTTP ${res.status} ${text.slice(0, 150)}`);
      const data = JSON.parse(text);
      for (const bucket of data.data) for (const r of bucket.results) used += r.amount.amount ?? 0;
      url = data.has_more && data.next_page ? `https://api.openai.com/v1/organization/costs?start_time=${start}&limit=180&next_page=${encodeURIComponent(data.next_page)}` : null;
      pages++;
    }
    const balance = Math.max(0, prepay - used);
    return { balance: parseFloat(balance.toFixed(2)), raw: { prepay, used } };
  },

  // 通用：GET + JSON path
  generic: async (platform) => {
    if (!platform.balance_api_url) {
      throw new Error('该平台未配置余额查询地址');
    }
    const headers = {};
    if (platform.api_key) headers.Authorization = `Bearer ${platform.api_key}`;
    const res = await fetch(platform.balance_api_url, { headers });
    if (!res.ok) throw new Error(`余额查询失败: HTTP ${res.status}`);
    const data = await res.json();
    const balance = getByPath(data, platform.balance_json_path);
    if (balance == null) throw new Error('未在返回中找到余额字段，请检查 balance_json_path');
    return { balance, raw: data };
  },

  // 月之暗面（Kimi / Moonshot）：GET /v1/users/me/balance
  moonshot: async (platform) => {
    if (!platform.api_key) throw new Error('月之暗面需要配置 API Key');
    const url = platform.balance_api_url || 'https://api.moonshot.cn/v1/users/me/balance';
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${platform.api_key}` },
    });
    if (!res.ok) throw new Error(`月之暗面余额查询失败: HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== 0 && data.code !== undefined) {
      throw new Error(`月之暗面余额查询失败: ${data?.error?.message || data?.scode || JSON.stringify(data).slice(0, 200)}`);
    }
    const balance = getByPath(data, 'data.available_balance');
    if (balance == null) throw new Error('未在返回中找到余额字段');
    return { balance, raw: data };
  },

  // AnyAIGC（New API 架构中转站）：GET /api/user/self
  // api_key 存 System Access Token（控制台 Profile → Profile Settings → Account & Security →
  // API Call Tokens 生成，重新生成会使旧 token 立即作废）；api_key_secret 存数字用户 ID。
  // 实测 2026-11-24 两个关键事实：
  //   1. New-Api-User 头必须是数字 ID（Profile Settings 页顶部 ID:），填用户名字符串
  //      会报 "Unauthorized, New-Api-User format error"。
  //   2. billing/subscription 与 usage 端点（sk- Key 可查）返回的是单把令牌自己的
  //      额度/用量，不是账户余额，不采用。
  //   换算系数 500000 quota = $1 已用两个数据点校准：quota=2425115 → $4.850230、
  //   used_quota=72574885 → $145.149770，均与控制台「当前余额/历史消耗」精确一致。
  anyaigc: async (platform) => {
    const token = platform.api_key;
    const userId = String(platform.api_key_secret || '').trim();
    if (!token) throw new Error('AnyAIGC 需要配置 System Access Token（控制台 Profile → Account & Security → API Call Tokens 生成）');
    if (!userId) throw new Error('AnyAIGC 需要配置数字用户 ID（Profile Settings 页顶部 ID:，仅数字）');
    if (!/^\d+$/.test(userId)) throw new Error(`AnyAIGC 用户 ID 必须是数字（Profile Settings 页顶部 ID:），当前值不是数字`);
    const url = platform.balance_api_url || 'https://anyaigc.ai/api/user/self';
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'New-Api-User': userId,
      },
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    if (!res.ok) {
      const msg = data?.message || `HTTP ${res.status}`;
      throw new Error(`AnyAIGC 余额查询失败: ${msg}`);
    }
    const d = data?.data || {};
    const quota = Number(d.quota);
    if (!Number.isFinite(quota)) throw new Error(`AnyAIGC 未返回 quota 字段: ${text.slice(0, 200)}`);
    // New API 惯例换算：500000 quota = $1（2026-11-24 已用控制台显示校准，见上方注释）
    return { balance: quota / 500000, raw: { quota, used_quota: d.used_quota, request_count: d.request_count } };
  },

  // RunningHub 国内站：POST /uc/openapi/accountStatus（官方账户余额接口）
  // 鉴权双传：Header Authorization: Bearer <key> + body {"apikey": key}（实测空 body 报 1601，缺一不可）。
  // 实测 2026-11-24 两个关键事实：
  //   1. 返回信封 {code,msg,errorMessages,data}：成功 code=0，余额在 data.remainMoney
  //      （字符串法币余额，币种 data.currency=CNY），积分（另一种货币）在 data.remainPoint
  //      （官方资料写的 remainCoins 实测是另一个字段，值为 0）。
  //   2. 报错也返回 HTTP 200（1601=参数缺失、806=APIKEY_USER_NOT_FOUND），
  //      必须校验业务码 code!==0，不能只看 HTTP 状态。
  runninghub: async (platform) => {
    const key = platform.api_key;
    if (!key) throw new Error('RunningHub 需要配置 API Key（控制台个人中心/API 设置页获取）');
    const url = platform.balance_api_url || 'https://www.runninghub.cn/uc/openapi/accountStatus';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ apikey: key }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    if (!res.ok) throw new Error(`RunningHub 余额查询失败: HTTP ${res.status} ${text.slice(0, 150)}`);
    if (data?.code !== 0) {
      throw new Error(`RunningHub 余额查询失败: ${data?.msg || `code=${data?.code}`}`);
    }
    const d = data?.data || {};
    const balance = Number(d.remainMoney);
    if (!Number.isFinite(balance)) throw new Error(`RunningHub 未返回可解析的 remainMoney: ${text.slice(0, 200)}`);
    return {
      balance,
      raw: { remainMoney: d.remainMoney, currency: d.currency, remainPoint: d.remainPoint,
        remainCoins: d.remainCoins, currentTaskCounts: d.currentTaskCounts, apiType: d.apiType },
    };
  },

  // 火山引擎：费用中心 QueryBalanceAcct，HMAC-SHA256 签名
  volcengine: async (platform) => {
    const ak = platform.api_key;
    const sk = platform.api_key_secret;
    if (!ak || !sk) throw new Error('火山引擎需要同时配置 AK（Access Key ID）和 SK（Secret Access Key）');
    const host = 'billing.volcengineapi.com';
    const method = 'GET';
    const query = { Action: 'QueryBalanceAcct', Version: '2022-01-01' };
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const xDate = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    const { canonicalQuery, authHeader } = volcSign({
      method, host, path: '/', query, payload: '', ak, sk, date: xDate,
    });
    const url = `https://${host}/?${canonicalQuery}`;
    const res = await fetch(url, {
      headers: {
        'Host': host,
        'X-Date': xDate,
        'Authorization': authHeader,
      },
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    if (!res.ok) {
      const msg = data?.ResponseMetadata?.Error?.Message || data?.error || `HTTP ${res.status}`;
      throw new Error(`火山引擎余额查询失败: ${msg}`);
    }
    // 返回结构：Result.AvailableBalance 为可用余额
    const result = data?.Result || data?.result || {};
    const balance = result.AvailableBalance ?? result.AvailableBalance;
    if (balance == null) throw new Error(`火山引擎未返回可用余额: ${text.slice(0, 200)}`);
    return { balance: parseFloat(balance), raw: data };
  },

  // 阿里云（百炼/DashScope）：BssOpenAPI QueryAccountBalance，HMAC-SHA1 签名
  // api_key 存 AccessKey ID，api_key_secret 存 AccessKey Secret
  dashscope: async (platform) => {
    const ak = platform.api_key;
    const sk = platform.api_key_secret;
    if (!ak || !sk) throw new Error('阿里云需要同时配置 AccessKey ID 和 AccessKey Secret');
    const params = {
      Action: 'QueryAccountBalance',
      AccessKeyId: ak,
      Format: 'JSON',
      RegionId: 'cn-hangzhou',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: crypto.randomUUID(),
      SignatureVersion: '1.0',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: '2017-12-14',
    };
    const { canonicalQuery, signature } = aliyunSign(params, sk);
    const url = `https://business.aliyuncs.com/?${canonicalQuery}&Signature=${encodeURIComponent(signature)}`;
    const res = await fetch(url);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    if (!res.ok || data?.Code !== '200') {
      throw new Error(`阿里云余额查询失败: ${data?.Message || `HTTP ${res.status}`}`);
    }
    const balance = data?.Data?.AvailableAmount;
    if (balance == null) throw new Error(`阿里云未返回可用余额: ${text.slice(0, 200)}`);
    return { balance: parseFloat(balance), raw: data };
  },

  // 腾讯云（混元）：费用中心 DescribeAccountBalance，TC3 签名
  // api_key 存 SecretId，api_key_secret 存 SecretKey；余额单位为分，转成元
  tencent: async (platform) => {
    const secretId = platform.api_key;
    const secretKey = platform.api_key_secret;
    if (!secretId || !secretKey) throw new Error('腾讯云需要同时配置 SecretId 和 SecretKey');
    const host = 'billing.tencentcloudapi.com';
    const service = 'billing';
    const action = 'DescribeAccountBalance';
    const payload = '{}';
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}`;
    const auth = tencentSign({ host, service, action, payload, secretId, secretKey, timestamp, date });
    const res = await fetch(`https://${host}/`, {
      method: 'POST',
      headers: {
        'Host': host,
        'Content-Type': 'application/json; charset=utf-8',
        'X-TC-Action': action,
        'X-TC-Version': '2018-07-09',
        'X-TC-Timestamp': String(timestamp),
        'Authorization': auth,
      },
      body: payload,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    if (data?.Response?.Error) {
      throw new Error(`腾讯云余额查询失败: ${data.Response.Error.Code} ${data.Response.Error.Message}`);
    }
    const cents = data?.Response?.Balance ?? data?.Response?.RealBalance;
    if (cents == null) throw new Error(`腾讯云未返回余额: ${text.slice(0, 200)}`);
    return { balance: cents / 100, raw: data };
  },

  // 智谱（BigModel）：控制台内部接口（非官方公开 API，随时可能失效）
  // api_key 存模型 API Key；api_key_secret 存控制台登录 Token（JWT，过期后需重新从浏览器复制）
  // 余额接口：GET /api/biz/account/query-customer-account-report，取 data.balance
  zhipu: async (platform) => {
    const token = platform.api_key_secret;
    if (!token) throw new Error('智谱需要配置控制台 Token（登录后从浏览器 DevTools 的 Authorization 头复制）');
    const url = platform.balance_api_url || 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report';
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    if (res.status === 401 || data?.code === 1001 || data?.code === 401) {
      throw new Error('智谱控制台 Token 已失效，请重新登录 open.bigmodel.cn 并更新 Token（编辑该平台的 Secret Key 字段，或运行 node scripts/zhipu-token-refresh.mjs --token "新token"）');
    }
    if (!res.ok || data?.code !== 200) {
      throw new Error(`智谱余额查询失败: ${data?.msg || data?.code || `HTTP ${res.status}`}（若为过期/无效提示，请更新控制台 Token）`);
    }
    const balance = data?.data?.balance ?? data?.data?.availableBalance;
    if (balance == null) throw new Error(`智谱未返回余额: ${text.slice(0, 200)}`);
    return { balance: parseFloat(balance), raw: data };
  },

  // MiniMax：余额查询接口
  minimax: async (platform) => {
    if (!platform.api_key) throw new Error('MiniMax需要配置API Key');
    // 区分Token Plan Key和普通开放平台API Key
    if (platform.api_key.startsWith('sk-cp-')) {
      // Token Plan Key：使用官方API接口查询
      const url = platform.balance_api_url || 'https://www.minimaxi.com/v1/token_plan/remains';
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${platform.api_key}` },
      });
      if (!res.ok) throw new Error(`MiniMax余额查询失败: HTTP ${res.status}`);
      const data = await res.json();
      const balance = getByPath(data, platform.balance_json_path || 'current_interval_usage_count');
      if (balance == null) throw new Error('未在返回中找到余额字段');
      return { balance, raw: data, unit: '次请求（5小时滚动）' };
    } else {
      // 普通开放平台API Key：使用浏览器自动抓取余额
      console.log('[MiniMax] 正在使用浏览器自动抓取余额...');
      const balance = await scrapeMiniMaxBalance();
      return { balance, raw: {}, unit: '元' };
    }
  },

  // 小米MiMo：余额查询接口，支持api-key header和Authorization Bearer两种方式
  mimo: async (platform) => {
    if (!platform.api_key) throw new Error('小米MiMo需要配置API Key');
    // 尝试几个可能的余额查询URL
    const urls = [
      platform.balance_api_url || 'https://api.xiaomimimo.com/v1/balance',
      'https://api.xiaomimimo.com/v1/quota',
      'https://api.xiaomimimo.com/v1/user/balance',
      'https://mimo.mi.com/api/v1/balance',
    ];
    // 先试api-key header，再试Authorization Bearer
    const headersOptions = [
      { 'api-key': platform.api_key, 'Content-Type': 'application/json' },
      { 'Authorization': `Bearer ${platform.api_key}`, 'Content-Type': 'application/json' },
    ];
    // 遍历所有组合
    for (const url of urls) {
      for (const headers of headersOptions) {
        try {
          const res = await fetch(url, { headers });
          if (!res.ok) continue; // 这个组合不行，继续试下一个
          const data = await res.json();
          console.log('小米MiMo API返回:', JSON.stringify(data, null, 2));
          // 先尝试用户指定的路径，再尝试常见路径
          const balance = getByPath(data, platform.balance_json_path || 'data.balance')
            ?? getByPath(data, 'balance')
            ?? getByPath(data, 'remaining')
            ?? getByPath(data, 'quota')
            ?? getByPath(data, 'data.remaining')
            ?? getByPath(data, 'data.quota');
          if (balance != null) {
            return { balance, raw: data, unit: '元' };
          }
        } catch (e) {
          // 继续试下一个组合
        }
      }
    }
    throw new Error('小米MiMo余额查询失败，所有URL和认证方式都尝试过了');
  },

  // 三大运营商个人卡（手机 SIM 卡）：运营商没有面向个人开放的查余额 API，
  // 官方能力开放平台的余额接口需企业资质审核 + 用户授权，个人拿不到。
  // 因此走网上营业厅页面抓取：登录一次拿登录态，之后定时读网厅余额页。
  // 抓取逻辑完全复用 scrape 模式，仅 provider 键不同（便于前端与登录脚本识别）。
  carrier_cmcc: async (platform, trigger) => {
    return await scrapeCarrier(platform, 'carrier_cmcc', trigger);
  },
  carrier_ct: async (platform, trigger) => {
    return await scrapeCarrier(platform, 'carrier_ct', trigger);
  },
  carrier_cu: async (platform, trigger) => {
    return await scrapeCarrier(platform, 'carrier_cu', trigger);
  },

  scrape: async (platform, trigger) => {
    // 浏览器抓取：打开钱包页面（balance_api_url），按 balance_json_path 规则提取余额
    // 配置示例：balance_api_url=https://platform.minimax.cn/console/account-wallet
    //          balance_json_path={"keyword":"可用额度","max":10000000}
    if (!platform.balance_api_url) {
      throw new Error('scrape 模式需要配置钱包页面地址（balance_api_url）');
    }
    // 先套用内置精确正则（未显式配置 regex 时自动补全，抓取更稳定）
    const rule = enrichRuleWithBuiltin(parseScrapeRule(platform.balance_json_path), platform.name, platform.provider);
    const balance = await scrapeWalletBalance({
      url: platform.balance_api_url,
      rule,
      debugLabel: platform.name,
      storageFile: storageFileFor(platform.name, platform.provider, platform.id),
      trigger,
    });
    return { balance, raw: {}, unit: platform.currency || '元', scraped: true };
  },

  manual: async (platform) => {
    // 手动模式：取最近一次手动录入的余额
    const row = db.prepare(
      'SELECT balance, currency FROM balance_history WHERE platform_id = ? ORDER BY id DESC LIMIT 1'
    ).get(platform.id);
    return { balance: row ? row.balance : null, raw: null, manual: true };
  },
};

export async function fetchBalance(platform, trigger = 'manual') {
  // balance_type=scrape/manual 时以查询方式为准（浏览器抓取/手动录入），
  // 其余情况优先按 provider 匹配专用查询器，再兑底到 generic
  const type = platform.balance_type || 'api';
  const provider = platform.provider;
  const fetcher =
    (type === 'scrape' || type === 'manual')
      ? providers[type]
      : (provider && providers[provider]) ||
        providers[type] ||
        providers.generic;
  const result = await fetcher(platform, trigger);
  return result;
}

// 写入一个设置项
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

// 记录本次访问观测到的会话状态（地面真相）。
//
// 为什么放在这里（实测 2026-11-21）：会话状态此前只有巡检（monitor.js）在写，
// 手动刷新走的路径不写。于是用户重新扫码登录后手动刷新能抓到余额，
// 界面却仍显示「未登录」——查询成功与状态显示自相矛盾。
// 三个入口（手动刷新 / 巡检 / 到账后重查）都经过 refreshPlatformBalance，
// 所以这是唯一的共同所有者：在这里记录，三条路径自动一致。
//
// 三态判定（classifySessionObservation）：
//   alive   → 写入 1
//   dead    → 写入 0
//   unknown → 保留上一次观测值（网络抖动等与登录态无关的失败不能用来判断生死）
export function recordSessionObservation(platform, result) {
  if (!platform || !String(platform.provider || '').startsWith('carrier_')) return;
  const observation = classifySessionObservation(result);
  if (observation === 'unknown') return;
  const key = `session_alive_${platform.id}`;
  const storageFile = storageFileFor(platform.name, platform.provider, platform.id);
  if (observation === 'alive') {
    setSetting(key, 1);
    // 抓取路径内部通常已经记过；桌面 Chrome 回退路径没有，这里补上，
    // 保证「用户在自己浏览器里登录、我们通过 CDP 抓到」时也能建立倒计时锚点。
    if (storageFile) markSessionAlive(storageFile);
  } else {
    setSetting(key, 0);
    // 抓取失败时抓取器不会标失效，这里补记——否则 meta 里会留着旧的
    // 「上次有效访问时刻」，倒计时继续给乐观估计。
    // 原因一并记上：界面上要能回答「为什么掉的」，
    // 不用再翻服务日志（实测 2026-11-21：日志不落盘，什么都查不到）。
    if (storageFile) markSessionDead(storageFile, describeDeadReason(result?.error));
  }
}

// 记录一次余额查询尝试（成功与失败都记）
// last_query_at    = 本次尝试的时刻（界面「最后查询」列显示这个）
// last_query_status= 'ok' / 'fail'（用于标红）
// last_success_at  = 最后一次成功的时刻（用于判断「多久没查成」→ 标黄）
export function markQueried(platformId, ok) {
  const now = new Date().toISOString();
  if (ok) {
    db.prepare(
      "UPDATE platforms SET last_query_at = ?, last_query_status = 'ok', last_success_at = ? WHERE id = ?"
    ).run(now, now, platformId);
  } else {
    db.prepare(
      "UPDATE platforms SET last_query_at = ?, last_query_status = 'fail' WHERE id = ?"
    ).run(now, platformId);
  }
}

// 记录一次「保活顺带取到的余额」。
//
// 为什么金额没变就不写历史（实测 2026-11-21）：
//   保活每 10 分钟跑一次（移动）/ 20 分钟（电信）。若每次都写一条 balance_history，
//   历史表会被同金额的重复记录刷满，余额变化曲线被噪声淹没，
//   「这笔钱什么时候花的」也就看不出来。
//   所以：金额变了才写历史；金额没变只更新「最后查询」时刻。
//
// 为什么保活取到的余额也算「查询成功」：
//   保活确实访问了网厅、确实读到了余额，这就是一次真实的余额查询。
//   之前余额只能靠巡检（周期 1 小时）更新，而会话寿命也只有约 60 分钟——
//   巡检很容易整个落在会话失效之后，于是「多久没查成」的标黄/标红会误报。
//   让保活也参与计数，余额的新鲜度就不再取决于巡检是否恰好赶上会话还活着。
export function recordBalanceIfChanged(platformId, balance, currency) {
  if (balance == null || !Number.isFinite(Number(balance))) return { changed: false };
  const value = Number(balance);
  const latest = db.prepare(
    'SELECT balance FROM balance_history WHERE platform_id = ? ORDER BY id DESC LIMIT 1'
  ).get(platformId);
  const changed = !latest || latest.balance === null || Math.abs(Number(latest.balance) - value) > 1e-9;
  if (changed) {
    db.prepare(
      'INSERT INTO balance_history (platform_id, balance, currency) VALUES (?, ?, ?)'
    ).run(platformId, value, currency);
    // 余额历史保留上限（与 refreshPlatformBalance 一致）
    db.prepare(`
      DELETE FROM balance_history WHERE platform_id = ? AND id NOT IN (
        SELECT id FROM balance_history WHERE platform_id = ? ORDER BY id DESC LIMIT 500
      )
    `).run(platformId, platformId);
  }
  // 无论金额变没变，这次都是一次成功查询：更新「最后查询」与错误标记
  db.prepare('UPDATE platforms SET latest_error = NULL WHERE id = ?').run(platformId);
  markQueried(platformId, true);
  return { changed, balance: value };
}

// trigger：'auto'（定时巡检等自动来源）/ 'manual'（用户点按钮）
// 自动来源下绝不开有头窗口（实测 2026-11-24：定时弹窗的根源），
// 手动来源保留原有能力（电信这类只认可见窗口的网厅靠它抓）。
export async function refreshPlatformBalance(platformId, { trigger = 'manual' } = {}) {
  console.log(`[refresh] 开始刷新平台 id=${platformId}...`);
  const platform = db.prepare('SELECT * FROM platforms WHERE id = ?').get(platformId);
  if (!platform) throw new Error('平台不存在');
  console.log(`[refresh] 平台信息: name=${platform.name}, provider=${platform.provider}, balance_type=${platform.balance_type}`);
  // 停用平台：不刷新，但返回结构化失败（避免调用方拿到 null 后读 .ok 崩溃）
  if (!platform.active) return { ok: false, error: '平台已停用', platformId };
  // 手动录入型平台没有「自动查询」：余额来自用户录入，
  // 它的「最后查询」在录入余额时记（见 routes.js），刷新只是读回已录的值，不算查询。
  const isManual = (platform.balance_type || 'api') === 'manual';

  try {
    const { balance, raw } = await fetchBalance(platform, trigger);
    console.log(`[refresh] 获取余额成功: balance=${balance}`);
    if (balance != null) {
      db.prepare(
        'INSERT INTO balance_history (platform_id, balance, currency) VALUES (?, ?, ?)'
      ).run(platformId, balance, platform.currency);
      console.log(`[refresh] 余额已保存到历史记录`);
      // 附加货币（如 RunningHub 积分 remainPoint）：随查询落库仅展示，不参与预警/充值
      if (raw && raw.remainPoint != null) {
        const pt = Number(raw.remainPoint);
        if (Number.isFinite(pt)) {
          db.prepare('UPDATE platforms SET extra_json = ? WHERE id = ?')
            .run(JSON.stringify({ remainPoint: pt, updatedAt: new Date().toISOString() }), platformId);
        }
      }
      // 余额历史保留上限：每小时巡检持续写入，不清理则表无限膨胀
      // （只保留最近 500 条，与 /history 接口的 max limit 一致）
      db.prepare(`
        DELETE FROM balance_history WHERE platform_id = ? AND id NOT IN (
          SELECT id FROM balance_history WHERE platform_id = ? ORDER BY id DESC LIMIT 500
        )
      `).run(platformId, platformId);
    }
    // 刷新成功，清空上次错误标记
    db.prepare('UPDATE platforms SET latest_error = NULL WHERE id = ?').run(platformId);
    // 记录本次查询（成功与失败都记，界面「最后查询」列用）
    if (!isManual) markQueried(platformId, true);
    // 记录会话观测结果（手动刷新也会更新会话状态）
    recordSessionObservation(platform, { ok: true });
    return { ok: true, balance, platformId };
  } catch (err) {
    console.error(`[refresh] 刷新失败:`, err);
    // 记录错误，前端标"抓取失败"，连续失败会触发登录态过期提醒
    db.prepare('UPDATE platforms SET latest_error = ? WHERE id = ?').run(String(err.message).slice(0, 300), platformId);
    // 失败同样算一次查询尝试：时间要更新（否则看不出「刚刚查过但失败」）
    if (!isManual) markQueried(platformId, false);
    // 记录会话观测结果：跳登录页 = 会话已失效；其他失败与登录态无关，不改状态
    recordSessionObservation(platform, { ok: false, error: String(err.message) });
    return { ok: false, error: err.message, platformId };
  }
}
