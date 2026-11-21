// 运营商登录态的「预计存活」与「续命」状态计算（纯函数，便于单测）
//
// 两个倒计时：
//   预计存活 = 关键会话 cookie 的过期倒计时（登录态真正失效的时刻）
//   续命     = 下一次真正访问网厅的时刻（保活与余额巡检中较早的那个）
//
// 为什么必须指定「关键会话 cookie」而不是取最早过期的那个：
// 登录态里混着 SDK cookie（如 189.cn 的 sajssdk_2015_cross_new_user，当天就过期）
// 和长期 cookie（1 年），取最早的会得到假值——电信会显示 7 小时而不是 7 天。
// 实测结论见 docs/carrier-balance/README.md §3.6 / §3.7。

// 从登录态 cookie 列表里挑出「关键会话 cookie」。
// spec 由 CARRIER_RULES[provider].sessionCookie 声明：
//   { exact: 'chargeresource' }                     —— 固定名（移动）
//   { suffix: 'T', siblingSuffix: 'S' }             —— 同前缀成对票据，取 xxxT（电信，
//     前缀随机如 yiUIIlbdQT3f，故按「同前缀存在 S 兄弟」识别，不硬编码全名）
export function pickKeySessionCookie(cookies, spec) {
  if (!spec || !Array.isArray(cookies) || !cookies.length) return null;
  const withExpiry = cookies.filter((c) => c && typeof c.expires === 'number' && c.expires > 0);
  let candidates = [];
  if (spec.exact) {
    candidates = withExpiry.filter((c) => c.name === spec.exact);
  } else if (spec.suffix) {
    candidates = withExpiry.filter((c) => {
      if (!c.name.endsWith(spec.suffix)) return false;
      const prefix = c.name.slice(0, -spec.suffix.length);
      return cookies.some((o) => o && o.name === prefix + (spec.siblingSuffix || ''));
    });
  }
  if (!candidates.length) return null;
  // 同一枚 cookie 在多个域各存一份时取最早过期的（保守估计）
  return candidates.reduce((a, b) => (b.expires < a.expires ? b : a));
}

// 检查登录态里缺哪些「必须存在」的 cookie。
// spec 形如 [{ prefix: '_secure_gateway_v2_token' }, { exact: 'chargeresource' }]
// 为什么需要它（实测 2026-11-20）：
//   网厅登录成功的那一刻，浏览器里并不一定已经有全部关键 cookie。
//   189.cn 的网关会话 cookie（_secure_gateway_v2_token）与用户档案 cookie
//   （_user_location_auth_v2_profile）是在「用户中心/余额模块真正加载」之后才下发的。
//   如果登录脚本在登录判定刚成立时就保存登录态，存下的是一份残缺登录态：
//   抓取时服务端不认这个会话，页面回到未登录态（余额显示为 --）。
export function missingRequiredCookies(cookies, spec) {
  if (!Array.isArray(spec) || !spec.length) return [];
  const names = (Array.isArray(cookies) ? cookies : [])
    .map((c) => c && c.name)
    .filter(Boolean);
  const missing = [];
  for (const r of spec) {
    if (!r) continue;
    const present = r.exact
      ? names.includes(r.exact)
      : r.prefix
        ? names.some((n) => n.startsWith(r.prefix))
        : true; // 规则写错时不当成缺失，避免误报
    if (!present) missing.push(r.exact || r.prefix);
  }
  return missing;
}

// 找出「这次写回会让登录态退化」的关键 cookie。
// 退化 = 旧登录态里有、新的没有。出现退化就不能覆盖写入：
//   覆盖 = 用一份缺关键 cookie 的残缺登录态换掉原本完整的登录态，
//   之后既抓不到余额，也回不去了。
// 实测事故（2026-11-20）：登录脚本把完整登录态覆盖成了缺网关 cookie 的残缺态。
export function findDegradedCookies(newCookies, oldCookies, spec) {
  const oldMissing = missingRequiredCookies(oldCookies, spec);
  // 旧登录态本来就没有这些 cookie → 不存在退化，照常写回
  if (oldMissing.length) return [];
  const newMissing = missingRequiredCookies(newCookies, spec);
  return newMissing;
}

// 组装单个平台的会话状态。
// 输入：
//   cookies     登录态文件里的 cookie 数组（无文件时传 null）
//   spec        CARRIER_RULES[provider].sessionCookie
//   timing      { keepAliveIntervalMs, monitorIntervalMs, lastKeepAliveAt, lastMonitorAt }
//   sessionStartedAt  最近一次「成功登录」的时刻（毫秒）
//   lastRenewedAt    最近一次「访问网厅且会话仍有效」的时刻（毫秒）
//   maxAgeMs    该运营商实测的会话窗口长度（毫秒）；null 表示尚未标定
//   renewable   访问网厅能否真的给会话续命（true/false/null=未知）
// 输出 state：
//   'not_logged_in' 没有登录态文件
//   'key_unknown'  有登录态文件但认不出关键 cookie（需要重新登录确认）
//   'uncalibrated' 该运营商尚未标定关键 cookie（如联通未联调）
//   'expired'      预计存活已到零
//   'expiring'     预计存活不足 warnMs（即将失效，需尽快重新登录）
//   'ok'           有效
//
// 「预计存活」的两种口径（实测 2026-11-20 晚，机制两家不同）：
//   移动：会话是「登录后固定 ~60 分钟」的硬上限。访问网厅只会把 chargeresource 的
//         *过期时间*推到「访问时刻+30 分钟」（值不变），服务端并未换发会话，
//         所以访问不延长会话——保活再勤也救不回来。必须靠重新扫码登录。
//   电信：每次访问，服务端会把票据 yiUIIlbdQT3fT *换发成新值*（= 新会话），
//         所以只要在窗口内访问就能一直续下去。
// 因此：
//   renewable=true  → 窗口从「上次成功访问」起算
//   renewable=false → 窗口从「登录时刻」起算（访问不重置它）
export function buildSessionStatus({
  cookies,
  spec,
  timing = {},
  observedAlive = null,
  sessionStartedAt = null,
  lastRenewedAt = null,
  revivedAt = null,
  maxAgeMs = null,
  renewable = null,
  warnMs = 15 * 60 * 1000,
  now = Date.now(),
}) {
  const base = {
    state: 'not_logged_in',
    keyCookie: null,
    expiresAt: null,
    ttlMs: null,
    nextRenewAt: null,
    renewSource: null,
    sessionStartedAt: sessionStartedAt || null,
    lastRenewedAt: lastRenewedAt || null,
    // 倒计时的起算点来源：'login' = 登录脚本记录的登录时刻；
    // 'revived' = 「从失效恢复为有效」的时刻（用户可能在别处自助登录，脚本没记录到）
    anchorSource: null,
    renewable: renewable === true,
  };
  if (!spec) return { ...base, state: 'uncalibrated' };
  if (!Array.isArray(cookies) || !cookies.length) return base;

  const key = pickKeySessionCookie(cookies, spec);
  if (!key) return { ...base, state: 'key_unknown' };

  const cookieExpiresAt = key.expires * 1000;
  let expiresAt = cookieExpiresAt;
  let ttlMs = cookieExpiresAt - now;
  let anchorSource = null;

  // 「预计存活」不能只看 cookie 过期时间——实测（2026-11-20）这是假值：
  //   电信的 yiUIIlbdQT3fT 票据写着 7 天，但会话窗口只有约 60 分钟；
  //   移动 chargeresource 每次访问被推到「访问时刻+30 分钟」，
  //   保活看着一直在续，会话仍然照死不误。
  // 所以取两个口径里更短的那个：
  //   ① cookie 过期时间（票据寿命）
  //   ② 会话窗口（见上方两种起算口径）
  // maxAgeMs 尚未标定（如联通未联调）时，退回只用 cookie 口径。
  if (maxAgeMs) {
    // 起算点：
    //   不可续命的（移动）：会话寿命从「登录时刻」起算，访问不重置它。
    //   可续命的（电信）：从「上次成功访问」起算。
    // loggedInAt 缺失是常态——用户常常在别处（自己的浏览器）扫码登录，
    // 我们的登录脚本没参与，拿不到登录时刻。此时用 revivedAt（会话从失效恢复为
    // 有效的那一刻）兜底：它必然晚于真实登录时刻，用它算会**偏保守**（少报存活时间），
    // 对「提前预警重新登录」这个用途是安全的方向。
    const startAnchor = sessionStartedAt || revivedAt || null;
    const anchor = renewable === false
      ? (startAnchor || lastRenewedAt)
      : (lastRenewedAt || startAnchor);
    if (anchor) {
      anchorSource = sessionStartedAt ? 'login' : (revivedAt ? 'revived' : 'renew');
      const sessionExpiresAt = anchor + maxAgeMs;
      if (sessionExpiresAt < expiresAt) {
        expiresAt = sessionExpiresAt;
        ttlMs = sessionExpiresAt - now;
      }
    }
  }

  // 下一次访问网厅的时刻 = 保活与余额巡检中较早的那个
  const kaInterval = timing.keepAliveIntervalMs || 0;
  const moInterval = timing.monitorIntervalMs || 0;
  const candidates = [];
  if (kaInterval && timing.lastKeepAliveAt) {
    candidates.push({ at: timing.lastKeepAliveAt + kaInterval, source: 'keepalive' });
  }
  if (moInterval && timing.lastMonitorAt) {
    candidates.push({ at: timing.lastMonitorAt + moInterval, source: 'monitor' });
  }
  candidates.sort((a, b) => a.at - b.at);

  const renewAt = candidates.length ? candidates[0].at : null;
  const renewSource = candidates.length ? candidates[0].source : null;

  // 观测到的会话状态（地面真相）优先于 cookie 过期时间的乐观估计：
  // 实测（2026-11-20）电信的 7 天票据尚未过期，但服务端已作废会话、页面已回未登录态。
  // observedAlive=false 表示上次实际访问网厅时确认已掉线。
  let state = ttlMs > 0 ? 'ok' : 'expired';
  if (observedAlive === false) {
    state = 'not_logged_in';
    // 已确认掉线就不再给「预计存活」时间——那个时间只是 cookie 的乐观估计
    return {
      state,
      keyCookie: key.name,
      expiresAt: null,
      ttlMs: null,
      nextRenewAt: renewAt,
      renewSource,
      sessionStartedAt: sessionStartedAt || null,
      lastRenewedAt: lastRenewedAt || null,
      anchorSource,
      renewable: renewable === true,
    };
  }

  // 预计存活已归零，但上次实际访问仍判定会话有效：
  // 说明实测窗口估短了或服务端临时宽限。此时应预警「该重登了」而不是谎报过期。
  if (ttlMs <= 0 && state === 'expired' && observedAlive === true) state = 'expiring';
  // 剩余时间不足 warnMs：提前预警。
  // 重点场景（实测 2026-11-20）：移动的会话是「登录后固定 ~60 分钟」的硬上限，
  // 保活续不了它。所以必须在这段窗口内提醒用户重新扫码登录，
  // 否则用户只能在界面上看到「未登录」，根本不知道它是什么时候没的。
  else if (ttlMs > 0 && ttlMs <= warnMs) state = 'expiring';

  return {
    state,
    keyCookie: key.name,
    expiresAt,
    ttlMs,
    nextRenewAt: renewAt,
    renewSource,
    sessionStartedAt: sessionStartedAt || null,
    lastRenewedAt: lastRenewedAt || null,
    anchorSource,
    renewable: renewable === true,
  };
}

// 判定「本次访问观测到了会话的什么状态」。
// 输入：一次余额查询的结果 { ok, balance?, error? }
// 输出：
//   'alive'   会话有效（抓到了余额）
//   'dead'    会话已失效（服务端把我们送回登录页）
//   'unknown' 与登录态无关的失败（网络抖动、页面结构变化等）——不能据此判断生死
//
// 为什么需要 'unknown'（实测 2026-11-21）：
//   早先把任何失败都当成「会话有效」写入，于是网络抖动会掩盖真正的掉线；
//   反过来把任何失败都当成「掉线」又会误报。判定必须区分这三态。
export function classifySessionObservation(result) {
  if (!result) return 'unknown';
  if (result.ok === true) return 'alive';
  const err = String(result.error || '');
  if (/未登录|跳转登录页/.test(err)) return 'dead';
  return 'unknown';
}
