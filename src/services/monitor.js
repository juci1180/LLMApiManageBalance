// 监控调度器：周期刷新余额 → 阈值判断 → 生成单据 → 通知 → 到账跟踪
import db from '../db/index.js';
import { refreshPlatformBalance } from './balance.js';
import { maybeCreateRechargeOrder, notifyOrder, tryCreditOrder } from './recharge.js';
import { sendPhoneNotify } from './push.js';
import { CARRIER_KEEPALIVE_MS, CARRIER_RULES, CARRIER_ENTRY_URLS, SAFE_KEYWORD_BY_KEY, renewCarrierSession, storageFileFor, storageKeyFor, enrichRuleWithBuiltin, parseScrapeRule } from './scraper_wallets.mjs';
import { readSessionMeta } from './session_meta.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let config = {};
try {
  config = JSON.parse(readFileSync(join(__dirname, '..', '..', 'config.json'), 'utf-8'));
} catch {}

const intervalMs = config.monitor?.intervalMs ?? 3600000; // 默认 1 小时（与 README 一致）

// 巡检并发保护：定时巡检与手动"立即巡检"同时触发时，后者直接跳过（避免重复抓取/重复建单）
let cycleRunning = false;

// 读取/写入 settings 键值
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

// 登录态过期提醒：连续 N 次巡检失败才推，且同一平台至少间隔 6 小时
async function maybeNotifyFailures(platforms, errors) {
  const failedIds = new Set(errors.map((e) => e.platformId));
  for (const p of platforms) {
    const countKey = `fail_count_${p.id}`;
    const pushKey = `fail_push_${p.id}`;
    if (failedIds.has(p.id)) {
      const count = (parseInt(getSetting(countKey) || '0', 10) || 0) + 1;
      setSetting(countKey, count);
      if (count >= 3) {
        const lastPush = parseInt(getSetting(pushKey) || '0', 10) || 0;
        if (Date.now() - lastPush >= 6 * 3600 * 1000) {
          setSetting(pushKey, Date.now());
          const err = errors.find((e) => e.platformId === p.id);
          await sendPhoneNotify(
            `⚠️ ${p.name} 余额抓取失败`,
            `已连续 ${count} 次巡检失败，可能登录态过期或平台风控。\n错误：${err?.error || ''}\n请尽快重新登录：node scripts/wallet-login.mjs`
          );
          console.log(`[monitor] 已推送登录态过期提醒: ${p.name}`);
        }
      }
    } else {
      setSetting(countKey, 0);
    }
  }
}

// 单次巡检（平台按批并行刷新，最多 3 个同时抓，整体提速）
export async function runMonitorCycle() {
  if (cycleRunning) return { skipped: true, message: '已有巡检正在运行，请稍候' };
  cycleRunning = true;
  try {
    const platforms = db.prepare('SELECT * FROM platforms WHERE active = 1').all();
    const results = { refreshed: [], orders: [], credited: [], errors: [] };

    const BATCH = 3;
    for (let i = 0; i < platforms.length; i += BATCH) {
      const slice = platforms.slice(i, i + BATCH);
      await Promise.all(slice.map(async (p) => {
        // 1. 刷新余额
        const r = await refreshPlatformBalance(p.id);
        // 巡检本身就访问了网厅（无论是否抓到余额），因此这是本平台的一次「续命时机」。
        // 续命倒计时 = 下一次访问网厅 = 巡检与保活中较早的那个，所以失败也要记时刻。
        if (String(p.provider || '').startsWith('carrier_')) {
          setSetting(`monitor_at_${p.id}`, Date.now());
          // 记录本次观测到的会话状态（地面真相）：抓成功 = 会话有效；
          // 报错且指向登录页 = 会话已失效。倒计时不能只靠 cookie 过期时间乐观估计——
          // 电信的 7 天票据还在时，会话也可能已被服务端作废（实测：票据未过期但页面已回未登录态）。
          const dead = r.ok === false && /未登录|跳转登录页/.test(String(r.error || ''));
          setSetting(`session_alive_${p.id}`, r.ok ? 1 : (dead ? 0 : 1));
        }
        if (!r.ok) {
          results.errors.push({ platformId: p.id, error: r.error });
          return;
        }
        results.refreshed.push({ platformId: p.id, balance: r.balance });

        // 2. 阈值判断，生成充值单
        const order = maybeCreateRechargeOrder(p.id);
        if (order) {
          results.orders.push(order);
          // 3. 通知
          await notifyOrder(order.orderId);
        }
      }));
    }

    // 4. 到账跟踪：已打款的单子尝试确认到账
    const paidOrders = db.prepare("SELECT id FROM recharge_orders WHERE status = 'paid'").all();
    for (const o of paidOrders) {
      const cr = await tryCreditOrder(o.id);
      if (cr.ok) results.credited.push(o.id);
    }

    // 5. 登录态过期自动提醒（连续失败 → 手机推送）
    await maybeNotifyFailures(platforms, results.errors);

    return results;
  } finally {
    cycleRunning = false;
  }
}

export function startMonitor() {
  const run = async () => {
    try {
      const r = await runMonitorCycle();
      const ts = new Date().toLocaleTimeString();
      console.log(`[monitor ${ts}] 刷新 ${r.refreshed.length} 平台, 生成 ${r.orders.length} 充值单, 到账 ${r.credited.length}, 错误 ${r.errors.length}`);
    } catch (err) {
      console.error('[monitor] 巡检异常:', err.message);
    }
  };
  run(); // 启动即跑一次
  const timer = setInterval(run, intervalMs);
  return timer;
}

// 运营商登录态保活（滑动续期会话专用）
//
// 背景（实测 2026-11-20）：运营商网厅的会话是「滑动续期」的——每次访问，服务端把关键
// cookie 的过期时间推到「访问时刻 + 窗口」。移动 chargeresource 的窗口只有 30 分钟，
// 而巡检周期是 1 小时，光靠定时巡检保不住会话：窗口一过，浏览器下次就不再带上该
// cookie，服务端认不出会话 → 跳登录页。
//
// 措施：给运营商单独加一条更快的保活节奏（CARRIER_KEEPALIVE_MS），且抓取成功后
// 把服务端续期后的 cookie 写回登录态文件（persistStorageState）。
// 保活只做「访问 + 续期」，不写余额历史、不触发充值单——避免高频巡检污染数据。
let keepAliveTimer = null;

// 会话即将失效时的提前提醒。
// 为什么必须有这个（实测 2026-11-20 晚 + 11-21 复核）：
//   两家的会话都是「登录后固定时长」的限制（约 60 分钟），保活救不回来，
//   一旦过了这个点就只能重新扫码登录。如果等到「已经变成未登录」才提醒，
//   用户是事后才知道的（这正是本次问题的由来）。
//   所以在窗口耗尽前 20 分钟就提醒，让用户有时间扫码。
// 频率控制：同一个登录周期只提醒一次（用登录时刻做键）。
async function notifySessionExpiring(platform, meta, leftMs, storageKey) {
  const pushKey = `session_expiring_push_${platform.id}`;
  // 用登录时刻做键：同一次登录只提醒一次，重新登录后自动可以再提醒
  // （loggedInAt 可能为空——用户常在别处自行扫码登录，此时用 aliveSince 兜底）
  const anchor = meta.loggedInAt || meta.aliveSince || 0;
  const token = `${platform.id}:${anchor}`;
  if (getSetting(pushKey) === token) return;
  const minutes = Math.max(1, Math.round(leftMs / 60000));
  const body =
    `${platform.name} 的登录态将在约 ${minutes} 分钟后失效。\n` +
    `该网厅的会话是「登录后固定时长」的限制，定期访问续不回来。\n` +
    `请重新登录：node scripts/wallet-login.mjs ${storageKey}` +
    (meta.account ? `\n当前绑定号码：${meta.account}` : '');
  const res = await sendPhoneNotify(`⏰ ${platform.name} 登录态即将失效`, body);
  setSetting(pushKey, token);
  if (res.delivered) {
    console.log(`[keepalive] 已推送即将失效提醒: ${platform.name}（约 ${minutes} 分钟后）`);
  } else {
    console.warn(
      `[keepalive] ${platform.name} 登录态将在约 ${minutes} 分钟后失效，` +
      '但**推送未送达**（config.json 的 notify.serverchan / notify.bark 都没配置）。' +
      '请在界面上看到提醒后及时重新登录。'
    );
  }
}

export function startCarrierKeepAlive() {
  const tick = async () => {
    const rows = db.prepare(
      "SELECT * FROM platforms WHERE active = 1 AND provider LIKE 'carrier_%'"
    ).all();
    for (const p of rows) {
      const interval = CARRIER_KEEPALIVE_MS[p.provider];
      if (!interval) continue;
      // 登录态文件按「账号」唯一：同运营商的多个号码各用各的文件（传入 p.id）
      const storageFile = storageFileFor(p.name, p.provider, p.id);
      if (!storageFile) continue; // 未登录，等巡检报错提示用户登录
      const lastKey = `keepalive_at_${p.id}`;
      const last = Number(db.prepare('SELECT value FROM settings WHERE key = ?').get(lastKey)?.value || 0);
      if (Date.now() - last < interval) continue;
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(lastKey, String(Date.now()));
      try {
        // 只访问 + 写回续期后的 cookie，不提取余额、不写历史、不触发充值单
        const url = p.balance_api_url || CARRIER_ENTRY_URLS[p.provider];
        const rule = CARRIER_RULES[p.provider] || {};
        const r = await renewCarrierSession({
          url,
          storageFile,
          rule,
          keywords: SAFE_KEYWORD_BY_KEY[p.provider],
          debugLabel: p.name,
        });
        if (r.ok) {
          console.log(`[keepalive] ${p.name} 访问成功（会话仍有效；注意：访问不会延长该网厅的会话寿命）`);
          setSetting(`session_alive_${p.id}`, 1);
          // 「可续命」与「不可续命」的差别（实测 2026-11-20 晚 + 11-21 复核）：
          //   两家都是「登录后固定时长」（约 60 分钟），访问只是让 cookie 看起来新鲜，
          //   不会延长服务端会话。所以必须在窗口耗尽前就提醒用户重新扫码登录，
          //   否则用户只能等到界面上出现「未登录」才知道。
          const meta = readSessionMeta(storageFile);
          const rule = CARRIER_RULES[p.provider] || {};
          const maxAge = rule.sessionMaxAgeMs;
          // 锚点：登录时刻优先；用户可能在别处自行扫码（我们的脚本没记录），
          // 此时用「会话从失效恢复为有效的那一刻」兜底（偏保守，安全方向）。
          const anchor = meta?.loggedInAt || meta?.aliveSince || null;
          if (maxAge && anchor && rule.sessionRenewable !== true) {
            const leftMs = anchor + maxAge - Date.now();
            if (leftMs > 0 && leftMs <= 20 * 60 * 1000) {
              await notifySessionExpiring(p, meta, leftMs, storageKeyFor(p.name, p.provider, p.id));
            }
          }
        } else if (r.loggedIn === false) {
          console.warn(`[keepalive] ${p.name} 会话已失效（${r.reason || '跳转 ' + r.url}），需重新运行 node scripts/wallet-login.mjs ${storageKeyFor(p.name, p.provider, p.id)}`);
          // 保活直接访问了网厅，它对会话是否有效的判断比 cookie 过期时间更可信
          setSetting(`session_alive_${p.id}`, 0);
          // 主动推送：保活比巡检更早发现会话失效（巡检要等 1 小时），
          // 同一平台 6 小时内只推一次，避免反复打扰
          const pushKey = `keepalive_push_${p.id}`;
          const lastPush = Number(db.prepare('SELECT value FROM settings WHERE key = ?').get(pushKey)?.value || 0);
          if (Date.now() - lastPush >= 6 * 3600 * 1000) {
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(pushKey, String(Date.now()));
            const res = await sendPhoneNotify(
              `⚠️ ${p.name} 登录态已失效`,
              `保活检测到网厅会话已失效（${r.reason || '跳转 ' + r.url}）。\n请重新登录：node scripts/wallet-login.mjs ${storageKeyFor(p.name, p.provider, p.id)}`
            );
            // 如实上报：没配推送通道时 res.delivered=false，不能再谎报「已推送」
            // （实测 2026-11-20 晚：config.json 里两个通道都是空的，
            //   日志却一直打印「已推送登录态失效提醒」，用户一条也没收到）。
            if (res.delivered) {
              console.log(`[keepalive] 已推送登录态失效提醒: ${p.name}`);
            } else {
              console.warn(
                `[keepalive] ${p.name} 登录态已失效，但**没有推送出去**：` +
                'config.json 的 notify.serverchan / notify.bark 都没配置，手机收不到提醒。' +
                '请改用界面上的「登录」按钮，或配置推送通道。'
              );
            }
          }
        } else {
          console.warn(`[keepalive] ${p.name} 会话续期失败`);
        }
      } catch (err) {
        console.warn(`[keepalive] ${p.name} 保活异常: ${err.message}`);
      }
    }
  };
  // 启动后先等一轮，避免与服务启动即跑的巡检并发抢浏览器
  setTimeout(() => {
    tick();
    keepAliveTimer = setInterval(tick, 60 * 1000); // 每分钟检查一次，到期才访问
  }, 60 * 1000);
  return keepAliveTimer;
}
