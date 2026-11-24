// 充值自动化：阈值判断 → 生成充值单 → 邮件通知 → 桌面弹窗 → 跟踪到账 → 资金池记账

import db from '../db/index.js';
import { sendRechargeEmail } from './mailer.js';
import { sendPhoneNotify } from './push.js';
import { spawn } from 'node:child_process';

// Windows 桌面弹窗提醒（独立进程，不阻塞监控）
function desktopAlert(title, msg) {
  if (process.env.LLM_MANAGER_NO_DESKTOP_ALERT) return; // 测试环境跳过桌面弹窗
  try {
    const safeTitle = String(title).replace(/'/g, "''");
    const safeMsg = String(msg).replace(/'/g, "''");
    const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${safeMsg}', '${safeTitle}', 'OK', 'Warning', 'Button1')`;
    const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    console.error('[recharge] 桌面弹窗失败:', err.message);
  }
}

// 检查某个平台是否低于阈值，若是则生成充值单（幂等：同一平台未完成的单子不重复生成）
export function maybeCreateRechargeOrder(platformId) {
  const platform = db.prepare('SELECT * FROM platforms WHERE id = ?').get(platformId);
  if (!platform || !platform.active) return null;

  // 最新余额
  const latest = db.prepare(
    'SELECT balance FROM balance_history WHERE platform_id = ? ORDER BY id DESC LIMIT 1'
  ).get(platformId);
  if (!latest || latest.balance == null) return null;

  const balance = latest.balance;
  const threshold = platform.threshold ?? 200;
  if (balance >= threshold) return null; // 未到阈值

  // 已有进行中的充值单则不重复
  const ongoing = db.prepare(
    "SELECT id FROM recharge_orders WHERE platform_id = ? AND status IN ('pending','notified','paid')"
  ).get(platformId);
  if (ongoing) return null;

  // 计算充值金额
  let amount = platform.recharge_amount ?? 500;
  if (platform.target_amount != null) {
    amount = Math.max(platform.target_amount - balance, 0);
  }
  if (amount <= 0) return null;

  const info = db.prepare(
    `INSERT INTO recharge_orders (platform_id, amount, currency, reason, status)
     VALUES (?, ?, ?, ?, 'pending')`
  ).run(platformId, amount, platform.currency, `余额 ${balance} ${platform.currency} 低于阈值 ${threshold}`);

  return { orderId: info.lastInsertRowid, platform, balance, amount };
}

// 发送充值通知（幂等：notified 后不再发）
export async function notifyOrder(orderId) {
  const order = db.prepare(
    `SELECT o.*, p.name AS platform_name, p.currency
     FROM recharge_orders o JOIN platforms p ON p.id = o.platform_id WHERE o.id = ?`
  ).get(orderId);
  if (!order || order.status !== 'pending') return { ok: false, reason: '订单状态不允许通知' };

  const sent = await sendRechargeEmail({
    platformName: order.platform_name,
    amount: order.amount,
    currency: order.currency,
    reason: order.reason,
    orderId: order.id,
  });

  // 桌面弹窗提醒（余额低于阈值时明显提示）
  desktopAlert(
    '【余额预警】' + order.platform_name,
    `平台「${order.platform_name}」余额低于阈值，已生成充值单 #${order.id}：需充值 ${order.amount} ${order.currency}\n原因：${order.reason}\n请及时登录平台充值。`
  );

  // 手机推送提醒（Server酱微信 + Bark，config.json 里配了哪个就发哪个）
  const phone = await sendPhoneNotify(
    '【余额预警】' + order.platform_name,
    `平台「${order.platform_name}」余额低于阈值，已生成充值单 #${order.id}：需充值 ${order.amount} ${order.currency}。\n原因：${order.reason}`
  );
  if (Object.keys(phone).length) console.log('[recharge] 手机推送:', JSON.stringify(phone));

  db.prepare(
    "UPDATE recharge_orders SET status = 'notified', notified_at = datetime('now','localtime') WHERE id = ?"
  ).run(orderId);

  return { ok: sent, orderId };
}

// 财务确认已打款：记录登记时的余额快照，作为后续到账检测的基准线
export function markPaid(orderId) {
  const order = db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'notified') return null;
  // 打款时的最新余额（可能为空，检测时会回退到上一次巡检余额）
  const latest = db.prepare(
    'SELECT balance FROM balance_history WHERE platform_id = ? ORDER BY id DESC LIMIT 1'
  ).get(order.platform_id);
  const info = db.prepare(`
    UPDATE recharge_orders
    SET status = 'paid', paid_at = datetime('now','localtime'), balance_at_paid = ?
    WHERE id = ? AND status = 'notified'
  `).run(latest?.balance ?? null, orderId);
  if (!info.changes) return null; // 状态已变（并发重复点击）
  return db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(orderId);
}

// 到账跟踪：打款后余额上涨，自动确认到账并扣减资金池
// trigger：'auto'（定时巡检触发的到账复查）/ 'manual'（用户点「检测到账」）。
// 自动来源不开有头窗口——到账复查是后台行为，不该打扰用户（实测 2026-11-24）。
export async function tryCreditOrder(orderId, { trigger = 'manual' } = {}) {
  const order = db.prepare(
    'SELECT o.*, p.id AS pid FROM recharge_orders o JOIN platforms p ON p.id = o.platform_id WHERE o.id = ?'
  ).get(orderId);
  if (!order || order.status !== 'paid') return { ok: false };

  // 重新拉取余额
  const { refreshPlatformBalance } = await import('./balance.js');
  const r = await refreshPlatformBalance(order.pid, { trigger });
  if (!r.ok || r.balance == null) return { ok: false, error: r.error };

  // 打款时的余额基准：优先用登记打款时记录的快照（balance_at_paid）；
  // 旧单据无快照时回退到上一次巡检的余额（排除本次刷新插入的最新一行）
  let before = order.balance_at_paid;
  if (before == null) {
    const prev = db.prepare(
      'SELECT balance FROM balance_history WHERE platform_id = ? AND id < (SELECT MAX(id) FROM balance_history WHERE platform_id = ?) ORDER BY id DESC LIMIT 1'
    ).get(order.pid, order.pid);
    before = prev?.balance ?? null;
  }

  // 若余额相较打款时上升（粗略判断到账）
  if (before != null && r.balance > before + order.amount * 0.5) {
    return creditOrder(orderId);
  }
  return { ok: false, reason: '尚未检测到到账' };
}

// 确认到账：标记 credited + 扣减资金池 + 记账
export function creditOrder(orderId) {
  const order = db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(orderId);
  if (!order) return { ok: false, reason: '订单不存在' };

  db.prepare(
    "UPDATE recharge_orders SET status = 'credited', credited_at = datetime('now','localtime') WHERE id = ? AND status = 'paid'"
  ).run(orderId);

  const updated = db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(orderId);
  if (updated.status !== 'credited') return { ok: false, reason: '订单未处于已打款状态' };

  deductFundPool(order.amount, orderId, `充值 ${order.platform_id} 平台`);
  return { ok: true, order: updated };
}

// 资金池扣减 + 记账（单进程同步执行，无需显式事务）
export function deductFundPool(amount, refId, note) {
  const pool = db.prepare('SELECT * FROM fund_pool LIMIT 1').get();
  const newBalance = pool.balance - amount;
  db.prepare('UPDATE fund_pool SET balance = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
    .run(newBalance, pool.id);
  db.prepare(
    'INSERT INTO fund_transactions (type, amount, balance_after, ref_id, note) VALUES (?, ?, ?, ?, ?)'
  ).run('recharge_deduct', -amount, newBalance, refId, note);
}

// 资金池充值（公司预存）
export function depositFundPool(amount, note = '公司预存') {
  const pool = db.prepare('SELECT * FROM fund_pool LIMIT 1').get();
  const newBalance = pool.balance + amount;
  db.prepare('UPDATE fund_pool SET balance = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
    .run(newBalance, pool.id);
  db.prepare(
    'INSERT INTO fund_transactions (type, amount, balance_after, note) VALUES (?, ?, ?, ?)'
  ).run('deposit', amount, newBalance, note);
  return db.prepare('SELECT * FROM fund_pool LIMIT 1').get();
}

export function getFundPool() {
  return db.prepare('SELECT * FROM fund_pool LIMIT 1').get();
}
