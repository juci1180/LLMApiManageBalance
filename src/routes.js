// API 路由
import db from './db/index.js';
import { refreshPlatformBalance, markQueried } from './services/balance.js';
import {
  maybeCreateRechargeOrder, notifyOrder, markPaid, creditOrder, tryCreditOrder,
  depositFundPool, getFundPool,
} from './services/recharge.js';
import { runMonitorCycle } from './services/monitor.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { storageKeyFor, storageFileFor, CARRIER_RULES, ruleKeyFor } from './services/scraper_wallets.mjs';
import { buildSessionStatus, planStaggeredRelogin } from './services/session_status.mjs';
import { hasPhoneNotify } from './services/push.js';
import { readSessionMeta } from './services/session_meta.mjs';
import { computeQueryStatus } from './services/query_status.mjs';
import { keepAliveIntervalMs, keepAliveEnabledFor } from './services/keepalive_policy.mjs';
import { autoHeadedAllowed } from './services/scrape_policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const LOGIN_LOG = join(PROJECT_ROOT, 'src', 'wallet-states', 'login-run.log');

// 余额巡检周期（毫秒）。续命倒计时需要它：巡检本身也是一次访问网厅。
function monitorIntervalMs() {
  try {
    const cfg = JSON.parse(fs.readFileSync(join(PROJECT_ROOT, 'config.json'), 'utf-8'));
    return cfg.monitor?.intervalMs ?? 3600000;
  } catch {
    return 3600000;
  }
}

let loginRunning = false;

// 校验数值型字段（阈值/充值金额/补足目标）：
// 这些值会直接插入前端 HTML，必须保证是有限数字，否则可被写入非数值字符串
function validateNumericFields(b) {
  for (const k of ['threshold', 'recharge_amount', 'target_amount']) {
    if (b[k] === undefined || b[k] === null || b[k] === '') continue;
    if (!Number.isFinite(Number(b[k]))) return `${k} 必须是有效数值`;
  }
  if (b.threshold !== undefined && Number(b.threshold) < 0) return 'threshold 不能为负数';
  if (b.recharge_amount !== undefined && Number(b.recharge_amount) < 0) return 'recharge_amount 不能为负数';
  return null;
}

// 平台 → 登录态文件 key（与 wallet-login.mjs 的转换一致）
// 登录态文件按「账号」唯一：同运营商的多个号码各存各的文件（带平台 id）
function storageKeyForPlatform(platform) {
  return storageKeyFor(platform.name, platform.provider, platform.id);
}

export async function registerRoutes(fastify) {
  // ===== 一键登录 =====
  fastify.get('/api/login/status', async () => ({ running: loginRunning }));

  // 拉起登录脚本（弹浏览器窗口；不阻塞等待，用户完成登录后脚本自行退出）
  //
  // 登录完成后自动抓一次余额（实测 2026-11-21）：
  //   此前登录脚本存好登录态就结束了，界面上的余额还是上一次巡检留下的旧数。
  //   而巡检周期正好是 1 小时、跟会话寿命（约 60 分钟）一样长，
  //   很容易整个撞在会话刚失效的窗口里——用户看到的是「抓取失败」而不是新余额。
  //   把「登录」与「余额更新」合成一个动作，用户就不用再点一次「刷新余额」。
  fastify.post('/api/login/run', async (req) => {
    if (loginRunning) {
      return { running: true, message: '已有登录流程正在运行，请先在弹出的窗口完成登录' };
    }
    const b = req.body || {};
    let platform = null;
    if (b.platform) {
      const row = db.prepare('SELECT * FROM platforms WHERE id = ? OR name = ?').get(b.platform, b.platform);
      platform = row || null;
    }
    // 错峰重登：body.platforms 指定本次要登的平台与顺序（按建议重登时刻排好）
    const args = ['scripts/wallet-login.mjs'];
    let loginTargets = [];
    if (Array.isArray(b.platforms) && b.platforms.length) {
      for (const id of b.platforms) {
        const row = db.prepare('SELECT * FROM platforms WHERE id = ?').get(id);
        if (row) loginTargets.push(row);
      }
      // 登录脚本按参数顺序逐个弹窗口，所以参数顺序 = 用户应重登的顺序
      for (const row of loginTargets) args.push(storageKeyForPlatform(row));
    } else if (platform) {
      loginTargets = [platform];
      args.push(storageKeyForPlatform(platform));
    }
    loginRunning = true;
    try {
      // 脚本输出记录到日志文件，前端可查询登录结果
      fs.mkdirSync(dirname(LOGIN_LOG), { recursive: true });
      const scopeName = loginTargets.length
        ? loginTargets.map((r) => r.name).join('、')
        : '全部浏览器抓取型平台';
      fs.writeFileSync(LOGIN_LOG, `[${new Date().toLocaleString()}] 开始登录：${scopeName}\n`);
      const out = fs.openSync(LOGIN_LOG, 'a');
      const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', out, out] });
      const finish = async () => {
        try { fs.closeSync(out); } catch {}
        // 登录脚本退出 = 用户扫完码了 → 立刻抓一次余额，把界面上的旧数换成新数
        // trigger='manual'：用户在等这个结果（登录窗口本就是可见的），
        // 按手动来源处理，允许开有头窗口把余额拿回来。
        try {
          for (const row of loginTargets) {
            const r = await refreshPlatformBalance(row.id, { trigger: 'manual' });
            console.log(
              `[login] ${row.name} 登录后自动抓余额：` +
              (r.ok ? `成功 ${r.balance}` : `失败 ${r.error}`)
            );
          }
        } catch (err) {
          console.warn(`[login] 登录后自动抓余额失败: ${err.message}`);
        }
        // 抓完才把「登录中」标记清掉：前端轮询到结束后刷新，看到的就是新余额
        loginRunning = false;
      };
      child.on('exit', () => { finish(); });
      child.on('error', () => { loginRunning = false; try { fs.closeSync(out); } catch {} });
      child.unref();
      return {
        running: true,
        message: loginTargets.length === 1
          ? `已打开「${loginTargets[0].name}」的登录窗口，请在弹出的浏览器里完成登录；登录成功会自动保存并关闭`
          : (loginTargets.length
            ? `已按重登顺序打开 ${loginTargets.length} 个登录窗口，请逐个完成登录`
            : '已打开登录窗口，请按顺序完成各平台登录'),
      };
    } catch (err) {
      loginRunning = false;
      return { running: false, message: '启动登录失败：' + err.message };
    }
  });

  // 最近一次登录流程的完整输出（每个平台成功/失败一目了然）
  fastify.get('/api/login/result', async () => {
    try {
      return { log: fs.readFileSync(LOGIN_LOG, 'utf8') || '' };
    } catch {
      return { log: '' };
    }
  });

  // 查询某平台是否已有登录态文件（没有则抓取前必须登录一次）
  fastify.get('/api/platforms/:id/login-state', async (req) => {
    const p = db.prepare('SELECT * FROM platforms WHERE id = ?').get(req.params.id);
    if (!p) return { exists: false, key: null };
    return { exists: Boolean(storageFileFor(p.name, p.provider, p.id)), key: storageKeyForPlatform(p) };
  });

  // 运营商登录态的两个倒计时：预计存活（关键会话 cookie 过期）与续命（下次访问网厅）
  // 前端每 10 秒拉一次，按返回的绝对时间戳本地走秒，避免整表重渲染。
  fastify.get('/api/carriers/session', async () => {
    const rows = db.prepare(
      "SELECT * FROM platforms WHERE active = 1 AND provider LIKE 'carrier_%' ORDER BY id"
    ).all();
    const sessions = [];
    for (const p of rows) {
      const providerKey = ruleKeyFor(p.name, p.provider);
      const rule = CARRIER_RULES[providerKey] || {};
      const file = storageFileFor(p.name, p.provider, p.id);
      let cookies = null;
      if (file) {
        try {
          cookies = JSON.parse(fs.readFileSync(file, 'utf8')).cookies || null;
        } catch {
          cookies = null;
        }
      }
      const num = (key) => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return Number(row?.value || 0);
      };
      // 会话元信息（登录时刻 / 上次有效访问时刻）——sidecar 文件，与登录脚本共享
      const meta = file ? readSessionMeta(file) : null;
      const status = buildSessionStatus({
        cookies,
        spec: rule.sessionCookie ?? null,
        observedAlive: num(`session_alive_${p.id}`) === 0 ? false : (num(`session_alive_${p.id}`) > 0 ? true : null),
        sessionStartedAt: meta?.loggedInAt || null,
        lastRenewedAt: meta?.lastAliveAt || null,
        // 「会话从失效恢复为有效」的时刻——用户可能在别处自行扫码登录，
        // 我们的登录脚本没参与、拿不到登录时刻时，用它兜底作为倒计时锚点。
        revivedAt: meta?.aliveSince || null,
        maxAgeMs: rule.sessionMaxAgeMs ?? null,
        renewable: rule.sessionRenewable ?? null,
        timing: {
          keepAliveIntervalMs: keepAliveIntervalMs(p.provider),
          monitorIntervalMs: monitorIntervalMs(),
          lastKeepAliveAt: num(`keepalive_at_${p.id}`),
          lastMonitorAt: num(`monitor_at_${p.id}`),
        },
      });
      // 服务端已明确判定未登录（上次抓取报「未登录」）时，覆盖 cookie 过期时间的乐观估计：
      // cookie 文件里可能还留着未过期的票据，但服务端已不认这个会话了。
      if (p.latest_error && /未登录|跳转登录页/.test(p.latest_error)) {
        status.state = 'not_logged_in';
        status.ttlMs = null;
        status.expiresAt = null;
      }
      sessions.push({
        platform_id: p.id,
        name: p.name,
        provider: p.provider,
        // 绑定号码：登录时网厅认定的号码（副卡被登成主卡号时能看出来）
        account: meta?.account || null,
        // 倒计时锚点来源：'login' = 登录脚本记录的登录时刻；
        // 'revived' = 会话恢复有效的时刻（用户自行扫码登录，脚本没记录）
        anchorSource: status.anchorSource || null,
        // 首次确认失效的时刻（不被后续观测覆盖）——「多久掉的」直接看这个
        deadAt: meta?.deadAt || null,
        // 最近一次确认失效的时刻
        lastDeadAt: meta?.lastDeadAt || null,
        // 失效原因（跳登录页 / 服务端失效标记 / 页面已无登录标识）
        deadReason: meta?.deadReason || null,
        // 保活是否已关闭（config.json 的 keepalive 段）。
        // 界面据此显示「自动续命已关闭」，而不是拿一个不会到来的倒计时糊弄用户。
        keepAliveEnabled: keepAliveEnabledFor(p.provider),
        // 自动巡检是否抓这个平台。站点级拦无头的网厅（电信 189.cn）在自动巡检里不抓，
        // 界面必须如实说明「需手动刷新」——否则用户只看到余额不更新，会以为程序坏了。
        autoScrapeDisabled: rule.headlessBlocked === true && !autoHeadedAllowed(),
        // 保活最近一次运行的结果：'alive' / 'dead' / 'error'
        // 与「保活根本没跑」的区别：keepaliveAt 为空就说明保活从没成功跑过
        keepaliveState: meta?.keepaliveState || null,
        keepaliveAt: meta?.keepaliveAt || null,
        keepaliveReason: meta?.keepaliveReason || null,
        ...status,
      });
    }
    // 错峰重登计划：按失效先后排出「下一个该重登谁」，并把相邻两家的
    // 建议重登时刻拉开 20 分钟——三家是先后扫码的，不拉开就会连着掉。
    const plan = planStaggeredRelogin(
      sessions.map((s) => ({
        platformId: s.platform_id,
        name: s.name,
        // 锚点：登录时刻优先；缺失时用「会话恢复有效的时刻」兜底
        anchorAt: s.sessionStartedAt || null,
        maxAgeMs: CARRIER_RULES[ruleKeyFor(s.name, s.provider)]?.sessionMaxAgeMs ?? null,
      })),
      { now: Date.now() }
    );
    const planById = new Map(plan.map((x) => [x.platformId, x]));
    for (const s of sessions) {
      const item = planById.get(s.platform_id);
      s.reloginOrder = item ? item.order : null;
      s.suggestedReloginAt = item ? item.suggestedReloginAt : null;
    }
    return {
      sessions,
      now: Date.now(),
      // 手机推送通道是否已配置。
      // 为什么要在接口里说（实测 2026-11-21）：预警逻辑一直是对的，
      // 但 config.json 里两个通道都是空的，提醒只落在服务日志里，
      // 手机上一条也没收到——用户只能盯着界面。界面必须明确告知这件事。
      pushConfigured: hasPhoneNotify(),
    };
  });

  // ===== 平台面板 =====
  // 列表附带最新余额与「最后查询」信息
  fastify.get('/api/platforms', async () => {
    const list = db.prepare('SELECT * FROM platforms ORDER BY id').all();
    // 「最后查询」陈旧阈值：巡检周期 2 倍（默认 1 小时 → 2 小时）
    const staleAfterMs = monitorIntervalMs() * 2;
    const now = Date.now();
    return list.map((p) => {
      const latest = db.prepare(
        'SELECT balance, checked_at FROM balance_history WHERE platform_id = ? ORDER BY id DESC LIMIT 1'
      ).get(p.id);
      // 手动录入型平台没有「自动查询」：它的「最后查询」是用户最后一次录入余额的时刻
      const autoQueried = (p.balance_type || 'api') !== 'manual';
      const qs = computeQueryStatus({
        lastQueryAt: p.last_query_at,
        lastQueryStatus: p.last_query_status,
        lastSuccessAt: p.last_success_at,
        // 停用平台本就不再被巡检，不算「陈旧」（否则会造成假警报）
        staleEligible: p.active !== 0,
        now,
        staleAfterMs,
      });
      return {
        ...p,
        api_key: p.api_key ? '••••••••' : '',
        api_key_secret: p.api_key_secret ? '••••••••' : '',
        latest_balance: latest?.balance ?? null,
        latest_checked_at: latest?.checked_at ?? null,
        last_query_at: p.last_query_at || null,
        last_query_status: p.last_query_status || null,
        last_success_at: p.last_success_at || null,
        // 上一次查询是否失败（标红）
        query_failed: qs.failed,
        // 超过巡检周期 2 倍没有成功查询（标黄）
        query_stale: qs.stale,
        // 手动录入型平台不是自动查询
        query_auto: autoQueried,
      };
    });
  });

  // 单个平台详情：密钥掩码返回（与列表接口一致），另给出是否已配置标记供前端提示
  fastify.get('/api/platforms/:id', async (req, reply) => {
    const p = db.prepare('SELECT * FROM platforms WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send({ error: '平台不存在' });
    return {
      ...p,
      api_key: p.api_key ? '••••••••' : '',
      api_key_secret: p.api_key_secret ? '••••••••' : '',
      has_api_key: Boolean(p.api_key),
      has_api_key_secret: Boolean(p.api_key_secret),
    };
  });

  fastify.post('/api/platforms', async (req, reply) => {
    const b = req.body || {};
    if (!b.name) return reply.code(400).send({ error: 'name 必填' });
    const bad = validateNumericFields(b);
    if (bad) return reply.code(400).send({ error: bad });
    try {
      const info = db.prepare(`
        INSERT INTO platforms (name, provider, base_url, api_key, api_key_secret, balance_type, balance_api_url,
          balance_json_path, currency, threshold, recharge_amount, target_amount, active, same_account_note, api_url, api_json_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        b.name, b.provider || 'generic', b.base_url || null, b.api_key || null, b.api_key_secret || null,
        b.balance_type || 'api', b.balance_api_url || null, b.balance_json_path || null,
        b.currency || 'USD', b.threshold ?? 200, b.recharge_amount ?? 500,
        b.target_amount ?? null, b.active ?? 1,
        b.same_account_note || null, b.api_url || null, b.api_json_path || null
      );
      return { id: info.lastInsertRowid };
    } catch (err) {
      // 同名平台：平台名有唯一约束。快速添加已存在同名模板时会走到这里，
      // 原始 SQLite 报错（UNIQUE constraint failed: platforms.name）对用户无意义，
      // 改成可读提示并告诉用户去编辑已有实例。
      if (String(err.message || '').includes('UNIQUE constraint failed')) {
        return reply.code(409).send({
          error: `已存在同名平台「${b.name}」。请在列表里找到它点「编辑」修改，而不是新建。`,
        });
      }
      return reply.code(400).send({ error: err.message });
    }
  });

  fastify.put('/api/platforms/:id', async (req, reply) => {
    const id = req.params.id;
    const b = req.body || {};
    const existing = db.prepare('SELECT * FROM platforms WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: '平台不存在' });
    const bad = validateNumericFields(b);
    if (bad) return reply.code(400).send({ error: bad });
    const apiKey = b.api_key === undefined ? existing.api_key : b.api_key;
    const apiKeySecret = b.api_key_secret === undefined ? existing.api_key_secret : b.api_key_secret;
    db.prepare(`
      UPDATE platforms SET name=?, provider=?, base_url=?, api_key=?, api_key_secret=?, balance_type=?,
        balance_api_url=?, balance_json_path=?, currency=?, threshold=?, recharge_amount=?,
        target_amount=?, active=?, same_account_note=?, api_url=?, api_json_path=?,
        updated_at=datetime('now','localtime')
      WHERE id=?
    `).run(
      b.name ?? existing.name, b.provider ?? existing.provider, b.base_url ?? existing.base_url,
      apiKey, apiKeySecret, b.balance_type ?? existing.balance_type, b.balance_api_url ?? existing.balance_api_url,
      b.balance_json_path ?? existing.balance_json_path, b.currency ?? existing.currency,
      b.threshold ?? existing.threshold, b.recharge_amount ?? existing.recharge_amount,
      b.target_amount ?? existing.target_amount, b.active ?? existing.active,
      b.same_account_note ?? existing.same_account_note,
      b.api_url ?? existing.api_url, b.api_json_path ?? existing.api_json_path, id
    );
    return { ok: true };
  });

  // 删除平台：连带清理其余额历史与充值单
  // （sqlite 未开启 foreign_keys，ON DELETE CASCADE 不生效，必须显式清理）
  fastify.delete('/api/platforms/:id', async (req) => {
    const id = req.params.id;
    db.prepare('DELETE FROM balance_history WHERE platform_id = ?').run(id);
    db.prepare('DELETE FROM recharge_orders WHERE platform_id = ?').run(id);
    db.prepare('DELETE FROM platforms WHERE id = ?').run(id);
    return { ok: true };
  });

  // 手动刷新单个平台余额
  // trigger='manual'：用户在点按钮，允许开有头窗口
  // （电信这类站点级拦无头的网厅，靠手动刷新才能拿到余额）
  fastify.post('/api/platforms/:id/refresh', async (req, reply) => {
    let r;
    try {
      r = await refreshPlatformBalance(req.params.id, { trigger: 'manual' });
    } catch (err) {
      return reply.code(404).send({ error: err.message });
    }
    if (!r || !r.ok) return reply.code(500).send(r || { error: '刷新失败' });
    return r;
  });

  // 手动录入余额
  fastify.post('/api/platforms/:id/balance', async (req, reply) => {
    const { balance } = req.body || {};
    const num = Number(balance);
    if (balance == null || !Number.isFinite(num)) {
      return reply.code(400).send({ error: 'balance 必须是有效数值' });
    }
    const p = db.prepare('SELECT * FROM platforms WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send({ error: '平台不存在' });
    db.prepare('INSERT INTO balance_history (platform_id, balance, currency) VALUES (?, ?, ?)')
      .run(p.id, num, p.currency);
    // 手动录入型平台：用户录入余额就是它唯一的数据来源，
    // 记为一次「查询」（界面上该列显示最后录入时刻）
    if ((p.balance_type || 'api') === 'manual') markQueried(p.id, true);
    return { ok: true };
  });

  // 余额历史
  fastify.get('/api/platforms/:id/history', async (req) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    return db.prepare(
      'SELECT balance, currency, checked_at FROM balance_history WHERE platform_id = ? ORDER BY id DESC LIMIT ?'
    ).all(req.params.id, limit);
  });

  // ===== 充值单 =====
  fastify.get('/api/orders', async () => {
    return db.prepare(`
      SELECT o.*, p.name AS platform_name FROM recharge_orders o
      JOIN platforms p ON p.id = o.platform_id ORDER BY o.id DESC
    `).all();
  });

  fastify.post('/api/orders/:id/notify', async (req) => {
    return notifyOrder(req.params.id);
  });

  fastify.post('/api/orders/:id/paid', async (req, reply) => {
    const o = markPaid(req.params.id);
    if (!o) return reply.code(400).send({ error: '订单不存在或状态不允许' });
    return o;
  });

  // 撤销打款：误标记后改回已通知
  fastify.post('/api/orders/:id/unmark-paid', async (req, reply) => {
    const o = db.prepare("SELECT * FROM recharge_orders WHERE id = ? AND status = 'paid'").get(req.params.id);
    if (!o) return reply.code(400).send({ error: '订单不存在或未处于已打款状态' });
    db.prepare("UPDATE recharge_orders SET status = 'notified', paid_at = NULL WHERE id = ?").run(req.params.id);
    return db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(req.params.id);
  });

  // 充值日记：填写/修改用途备注
  fastify.post('/api/orders/:id/note', async (req, reply) => {
    const { note } = req.body || {};
    const o = db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(req.params.id);
    if (!o) return reply.code(404).send({ error: '订单不存在' });
    db.prepare('UPDATE recharge_orders SET note = ? WHERE id = ?').run(note || null, req.params.id);
    return db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(req.params.id);
  });

  fastify.post('/api/orders/:id/credit', async (req, reply) => {
    const r = await tryCreditOrder(req.params.id);
    if (!r.ok) return reply.code(400).send({ error: r.reason || r.error || '尚未检测到到账' });
    return r;
  });

  // 手动直接确认到账
  fastify.post('/api/orders/:id/credit-force', async (req, reply) => {
    const r = creditOrder(req.params.id);
    if (!r.ok) return reply.code(400).send({ error: r.reason || r.error || '无法确认到账' });
    return r;
  });

  // ===== 资金池 =====
  fastify.get('/api/fund', async () => {
    const pool = getFundPool();
    const txs = db.prepare('SELECT * FROM fund_transactions ORDER BY id DESC LIMIT 100').all();
    // 累计充值总额：以到账流水为准（资金池余额是公司台账口径，充值时是扣减，不能直接当累计额展示）
    const agg = db.prepare(`
      SELECT COALESCE(SUM(ABS(amount)), 0) AS total FROM fund_transactions
      WHERE type IN ('recharge', 'recharge_deduct')
    `).get();
    return { pool, total_recharged: agg?.total ?? 0, transactions: txs };
  });

  // 月度充值统计：某月各平台到账明细（status=credited 的记录）
  fastify.get('/api/fund/monthly', async (req) => {
    const now = new Date();
    const defMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : defMonth;
    const rows = db.prepare(`
      SELECT o.id, p.name AS platform_name, o.amount, o.currency, o.note, o.credited_at
      FROM recharge_orders o JOIN platforms p ON p.id = o.platform_id
      WHERE o.status = 'credited' AND o.credited_at LIKE ?
      ORDER BY o.credited_at DESC
    `).all(month + '%');
    const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
    return { month, rows, total };
  });

  fastify.post('/api/fund/deposit', async (req, reply) => {
    const { amount, note } = req.body || {};
    if (!amount || amount <= 0) return reply.code(400).send({ error: 'amount 需为正数' });
    return depositFundPool(amount, note);
  });

  // ===== 手动触发巡检 =====
  // trigger='manual'：用户在场，允许开有头窗口（与定时巡检的静默行为不同）
  fastify.post('/api/monitor/run', async () => {
    return runMonitorCycle({ trigger: 'manual' });
  });
}
