// 「最后查询」状态计算（纯函数，供路由与单元测试共用）
//
// 语义（需求对齐结论）：
//   last_query_at     = 最后一次「查询尝试」的时刻（成功与失败都更新）
//   last_query_status = 'ok' / 'fail'，用于标红
//   last_success_at   = 最后一次「查询成功」的时刻，用于判断多久没查成 → 标黄
//
// 标黄阈值：超过巡检周期 2 倍（默认巡检 1 小时 → 2 小时）没有成功查询。
// 适用范围：全部实例（含手动录入型——它的「成功」就是最后一次录入余额的时刻）。
// 停用平台不参与（用户主动停用，不该当成故障报警）。

// ISO 字符串 → 毫秒时间戳；无法解析返回 null
function parseTs(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function computeQueryStatus({
  lastQueryAt = null,
  lastQueryStatus = null,
  lastSuccessAt = null,
  // 是否参与陈旧（标黄）判定。停用平台传 false。
  staleEligible = true,
  now = Date.now(),
  staleAfterMs = 7200000,
} = {}) {
  const at = parseTs(lastQueryAt);
  const succ = parseTs(lastSuccessAt);
  const failed = lastQueryStatus === 'fail';
  // 陈旧判定只看「最后一次成功」；从未成功过（还没查成过）不算陈旧
  const stale = Boolean(staleEligible && succ !== null && now - succ > staleAfterMs);
  return {
    // 从未查询过（新建实例还没跑过巡检）
    hasQuery: at !== null,
    // 上一次查询是失败的 → 标红
    failed,
    // 超过巡检周期 2 倍没有成功查询 → 标黄
    stale,
    lastQueryAt: at,
    lastSuccessAt: succ,
    // 距上次查询尝试多久
    ageMs: at === null ? null : now - at,
    // 距上次成功查询多久
    successAgeMs: succ === null ? null : now - succ,
  };
}
