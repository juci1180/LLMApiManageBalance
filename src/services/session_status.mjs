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

// 组装单个平台的会话状态。
// 输入：
//   cookies     登录态文件里的 cookie 数组（无文件时传 null）
//   spec        CARRIER_RULES[provider].sessionCookie
//   timing      { keepAliveIntervalMs, monitorIntervalMs, lastKeepAliveAt, lastMonitorAt }
// 输出 state：
//   'not_logged_in' 没有登录态文件
//   'key_unknown'  有登录态文件但认不出关键 cookie（需要重新登录确认）
//   'uncalibrated' 该运营商尚未标定关键 cookie（如联通未联调）
//   'expired'      关键 cookie 已过期
//   'ok'           有效
export function buildSessionStatus({ cookies, spec, timing = {}, observedAlive = null, now = Date.now() }) {
  const base = {
    state: 'not_logged_in',
    keyCookie: null,
    expiresAt: null,
    ttlMs: null,
    nextRenewAt: null,
    renewSource: null,
  };
  if (!spec) return { ...base, state: 'uncalibrated' };
  if (!Array.isArray(cookies) || !cookies.length) return base;

  const key = pickKeySessionCookie(cookies, spec);
  if (!key) return { ...base, state: 'key_unknown' };

  const expiresAt = key.expires * 1000;
  const ttlMs = expiresAt - now;

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
    };
  }

  return {
    state,
    keyCookie: key.name,
    expiresAt,
    ttlMs,
    nextRenewAt: renewAt,
    renewSource,
  };
}
