// 监控调度器：周期刷新余额 → 阈值判断 → 生成单据 → 通知 → 到账跟踪
import db from '../db/index.js';
import { refreshPlatformBalance, recordBalanceIfChanged } from './balance.js';
import { maybeCreateRechargeOrder, notifyOrder, tryCreditOrder } from './recharge.js';
import { sendPhoneNotify } from './push.js';
import { CARRIER_RULES, CARRIER_ENTRY_URLS, SAFE_KEYWORD_BY_KEY, renewCarrierSession, storageFileFor, storageKeyFor, enrichRuleWithBuiltin, parseScrapeRule } from './scraper_wallets.mjs';
import { readSessionMeta, markSessionKeepalive } from './session_meta.mjs';
import { keepAliveIntervalMs, keepAliveEnabledFor } from './keepalive_policy.mjs';
import { autoSkipLoggedOut, sessionConfirmedLoggedOut } from './scrape_policy.mjs';
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
          const res = await sendPhoneNotify(
            `⚠️ ${p.name} 余额抓取失败`,
            `已连续 ${count} 次巡检失败，可能登录态过期或平台风控。\n错误：${err?.error || ''}\n请尽快重新登录：node scripts/wallet-login.mjs`
          );
          // 如实上报送达结果（实测 2026-11-21 16:37）：
          // 此前这里无条件打印「已推送登录态过期提醒」，而 config.json 里两个通道
          // 都是空的，sendPhoneNotify 什么都没发——日志说发了，用户一条也没收到。
          if (res.delivered) {
            console.log(`[monitor] 已推送登录态过期提醒: ${p.name}`);
          } else {
            console.warn(
              `[monitor] ${p.name} 已连续 ${count} 次巡检失败，但**没有推送出去**：` +
              'config.json 的 notify.serverchan / notify.bark 都没配置，手机收不到提醒。' +
              '请改用界面上的「登录」按钮，或配置推送通道。'
            );
          }
        }
      }
    } else {
      setSetting(countKey, 0);
    }
  }
}

// 自动巡检：该不该跳过这个平台
//
// 为什么需要（实测 2026-11-24）：用户反馈定时弹浏览器窗口。排查确认弹窗来自巡检：
//   移动两家未登录 → 无头抓必然失败 → 回退有头窗口重试 → 弹窗；
//   电信 189.cn 站点级拦无头 → 本身就用有头窗口抓 → 弹窗。
// 会话已确认失效时，再去访问网厅既拿不到余额、也只会重复弹窗。
// 所以自动巡检直接跳过已确认掉线的平台，等用户重新登录后自动恢复。
//
// 判据（session_meta 的 sidecar）：
//   deadAt 有值 = 服务端已作废过这个会话；
//   lastAliveAt 为空 = 之后没有再成功访问过。
//   重新登录会写新的 loggedInAt 并清掉 deadAt，因此不会误跳过。
function shouldSkipInAuto(platform) {
  if (!autoSkipLoggedOut()) return null;
  if (!String(platform.provider || '').startsWith('carrier_')) return null;
  const storageFile = storageFileFor(platform.name, platform.provider, platform.id);
  if (!storageFile) return null; // 没登录态文件：交给抓取路径报错，提示用户登录
  const meta = readSessionMeta(storageFile);
  if (!sessionConfirmedLoggedOut(meta)) return null;
  return meta.deadReason || '会话已失效';
}

// 单次巡检（平台按批并行刷新，最多 3 个同时抓，整体提速）
// trigger：'auto'（定时巡检）/ 'manual'（用户点「立即巡检」）。
// 手动来源保留原有能力（允许开有头窗口），用户在场时弹窗是可以接受的。
export async function runMonitorCycle({ trigger = 'auto' } = {}) {
  if (cycleRunning) return { skipped: true, message: '已有巡检正在运行，请稍候' };
  cycleRunning = true;
  try {
    const platforms = db.prepare('SELECT * FROM platforms WHERE active = 1').all();
    const results = { refreshed: [], orders: [], credited: [], errors: [], skipped: [] };

    const BATCH = 3;
    for (let i = 0; i < platforms.length; i += BATCH) {
      const slice = platforms.slice(i, i + BATCH);
      await Promise.all(slice.map(async (p) => {
        // 0. 自动巡检跳过已确认掉线的平台：不访问网厅、不弹窗、不刷失败次数
        //    （手动点「立即巡检」/「刷新余额」不走这里，用户想试随时能试）
        const skipReason = trigger === 'auto' ? shouldSkipInAuto(p) : null;
        if (skipReason) {
          // 跳过的原因只记一次，避免每小时刷屏
          const flag = `auto_skip_logged_${p.id}`;
          if (!getSetting(flag)) {
            setSetting(flag, Date.now());
            console.log(
              `[monitor] ${p.name} 会话已失效（${skipReason}），自动巡检已跳过、不再访问网厅；` +
              '重新登录后自动恢复抓取'
            );
          }
          results.skipped.push({ platformId: p.id, reason: skipReason });
          return;
        }
        // 1. 刷新余额
        //    trigger='auto'：自动来源不开有头窗口（实测 2026-11-24，弹窗的根治点）
        const r = await refreshPlatformBalance(p.id, { trigger });
        // 巡检本身就访问了网厅（无论是否抓到余额），因此这是本平台的一次「续命时机」。
        // 续命倒计时 = 下一次访问网厅 = 巡检与保活中较早的那个，所以失败也要记时刻。
        if (String(p.provider || '').startsWith('carrier_')) {
          setSetting(`monitor_at_${p.id}`, Date.now());
          // 会话状态（session_alive_*）由 refreshPlatformBalance 统一记录——
          // 手动刷新、巡检、到账后重查三条路径都经过那里，判定口径只有一份。
          // 这里不再重复写，避免出现两套判定（早先这里把「与登录态无关的失败」
          // 也记成会话有效，会掩盖真正的掉线）。
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
    //    自动来源不开有头窗口——到账复查是后台行为，不该弹窗打扰用户
    //    （实测 2026-11-24：定时弹窗的根源之一）
    const paidOrders = db.prepare("SELECT id FROM recharge_orders WHERE status = 'paid'").all();
    for (const o of paidOrders) {
      const cr = await tryCreditOrder(o.id, { trigger: trigger === 'auto' ? 'auto' : 'manual' });
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
      // 定时巡检：自动来源，绝不开有头窗口（实测 2026-11-24）
      const r = await runMonitorCycle({ trigger: 'auto' });
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
//
// 开关（2026-11-24）：保活会弹浏览器窗口（189.cn 站点级拦无头，只能有头抓），
// 用户嫌烦要求关掉移动和电信的自动续命。现在保活间隔由 config.json 的
// keepalive 段决定（见 keepalive_policy.mjs），关掉后这一层不再访问网厅。
// 注意：关掉保活**不影响**余额巡检（每小时一次，仍会访问网厅、仍会弹窗）。
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
      // 保活间隔取自配置开关（config.json 的 keepalive 段）。
      // 关掉后 interval=0 → 直接跳过这家，不再访问网厅、不再弹窗。
      const interval = keepAliveIntervalMs(p.provider);
      if (!interval) {
        if (keepAliveEnabledFor(p.provider)) continue; // 该运营商本来就没配保活间隔
        // 已关闭：只在第一次遇到时说明一次，避免每分钟刷屏。
        const flag = `keepalive_disabled_logged_${p.id}`;
        if (!getSetting(flag)) {
          setSetting(flag, Date.now());
          console.log(`[keepalive] ${p.name} 的自动续命已关闭（config.json 的 keepalive 配置），不再访问网厅`);
        }
        continue;
      }
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
          // 保活链路独占写这三个字段（抓取路径不碰）。
          // 为什么要显式写：renewCarrierSession 内部调的是 markSessionAlive，
          // 那个函数只管会话元信息，不写保活状态——否则「保活跑没跑」就分不清了。
          markSessionKeepalive(storageFile, 'alive', null);
          // 保活顺带取到的余额：金额变了才写历史，没变只更新「最后查询」时刻。
          // 这样余额的新鲜度不再取决于巡检是否恰好撞在会话存活窗口内
          // （实测 2026-11-21：会话活约 60 分钟，巡检周期也是 1 小时，
          //  巡检很容易整个落在会话失效之后，界面于是长期显示「抓取失败」）。
          if (r.balance != null) {
            const rec = recordBalanceIfChanged(p.id, r.balance, p.currency || 'CNY');
            console.log(
              `[keepalive] ${p.name} 顺带取到余额 ${rec.balance}` +
              (rec.changed ? '（金额有变化，已写入历史）' : '（金额未变，不重复写历史）')
            );
          }
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
          const reason = r.reason || '跳转 ' + r.url;
          console.warn(`[keepalive] ${p.name} 会话已失效（${reason}），需重新运行 node scripts/wallet-login.mjs ${storageKeyFor(p.name, p.provider, p.id)}`);
          // 保活直接访问了网厅，它对会话是否有效的判断比 cookie 过期时间更可信
          setSetting(`session_alive_${p.id}`, 0);
          // 保活链路独占写保活状态：这里明确记「保活判定失效」，
          // 与「巡检刷新先发现失效」区分开（两者对排查的意义不同）。
          markSessionKeepalive(storageFile, 'dead', reason);
          // 主动推送：保活比巡检更早发现会话失效（巡检要等 1 小时）。
          // 节流键改用「登录周期」而不是固定时长（实测 2026-11-21 16:37）：
          //   原来按 6 小时节流，但会话实际每 ~60 分钟就死一次、用户重新登录后再死，
          //   6 小时内的后续失效全被吞掉——用户只会看到界面上突然变「未登录」，
          //   手机却一直没响。改用「平台 id + 登录时刻」做键：
          //   同一次登录只提醒一次，重新登录后自动可以再提醒。
          const metaDead = readSessionMeta(storageFile);
          const anchorToken = metaDead?.loggedInAt || metaDead?.aliveSince || 0;
          const pushKey = `keepalive_push_${p.id}`;
          const token = `${p.id}:${anchorToken}`;
          if (getSetting(pushKey) !== token) {
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(pushKey, token);
            const res = await sendPhoneNotify(
              `⚠️ ${p.name} 登录态已失效`,
              `保活检测到网厅会话已失效（${reason}）。\n请重新登录：node scripts/wallet-login.mjs ${storageKeyFor(p.name, p.provider, p.id)}`
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
          markSessionKeepalive(storageFile, 'error', r.reason || '访问失败');
        }
      } catch (err) {
        // 保活抛异常（如浏览器起不来、网络不通）也要落状态：
        // 此前只打一行日志，界面上与「保活根本没跑」长得一模一样，无法区分。
        // 注意：异常**不等于**会话失效，所以不写 session_alive=0——
        // 那是猜测，界面不该拿猜测冒充地面真相。
        console.warn(`[keepalive] ${p.name} 保活异常: ${err.message}`);
        markSessionKeepalive(storageFile, 'error', err.message);
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
