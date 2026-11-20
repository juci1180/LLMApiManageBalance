#!/usr/bin/env node
// 「最后查询」字段的单元测试（不联网、不依赖数据库）
// 覆盖：computeQueryStatus 的标红/标黄/未查过判定，以及时间解析边界。
import { computeQueryStatus } from '../src/services/query_status.mjs';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? `   [${detail}]` : ''}`);
}

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-21T02:30:00.000Z');
const iso = (ms) => new Date(NOW - ms).toISOString();
const STALE_AFTER = 2 * HOUR; // 巡检周期 1 小时 × 2

// ===== 1. 从未查询过（新建实例）=====
{
  const s = computeQueryStatus({ now: NOW, staleAfterMs: STALE_AFTER });
  check('从未查询：hasQuery=false', s.hasQuery === false);
  check('从未查询：不标红也不标黄', s.failed === false && s.stale === false);
  check('从未查询：两个时间戳均为空', s.lastQueryAt === null && s.lastSuccessAt === null);
}

// ===== 2. 查询失败 → 标红 =====
{
  const s = computeQueryStatus({
    lastQueryAt: iso(5 * 60 * 1000),
    lastQueryStatus: 'fail',
    lastSuccessAt: null,
    now: NOW,
    staleAfterMs: STALE_AFTER,
  });
  check('查询失败：failed=true（标红）', s.failed === true);
  check('查询失败：hasQuery=true', s.hasQuery === true);
  check('查询失败：距上次尝试约 5 分钟', Math.abs(s.ageMs - 5 * 60 * 1000) < 1000, `ageMs=${s.ageMs}`);
  check('查询失败：从未成功过则不标黄（没有可比的成功时间）', s.stale === false);
}

// ===== 3. 查询成功且新鲜 → 不标色 =====
{
  const s = computeQueryStatus({
    lastQueryAt: iso(10 * 60 * 1000),
    lastQueryStatus: 'ok',
    lastSuccessAt: iso(10 * 60 * 1000),
    now: NOW,
    staleAfterMs: STALE_AFTER,
  });
  check('成功且新鲜：不标红', s.failed === false);
  check('成功且新鲜：不标黄', s.stale === false);
  check('成功且新鲜：hasQuery=true', s.hasQuery === true);
}

// ===== 4. 成功但超过巡检周期 2 倍未更新 → 标黄 =====
{
  const s = computeQueryStatus({
    lastQueryAt: iso(3 * HOUR),
    lastQueryStatus: 'ok',
    lastSuccessAt: iso(3 * HOUR),
    now: NOW,
    staleAfterMs: STALE_AFTER,
  });
  check('3 小时未成功查询：stale=true（标黄）', s.stale === true);
  check('3 小时未成功查询：不标红', s.failed === false);
  check('距上次成功约 3 小时', Math.abs(s.successAgeMs - 3 * HOUR) < 1000, `successAgeMs=${s.successAgeMs}`);
}

// ===== 5. 边界：恰好等于 2 倍周期（不算陈旧）=====
{
  const s = computeQueryStatus({
    lastQueryAt: iso(2 * HOUR),
    lastQueryStatus: 'ok',
    lastSuccessAt: iso(2 * HOUR),
    now: NOW,
    staleAfterMs: STALE_AFTER,
  });
  check('恰好等于 2 倍周期：不标黄（严格大于才算陈旧）', s.stale === false);
}
{
  const s = computeQueryStatus({
    lastQueryAt: iso(2 * HOUR + 1000),
    lastQueryStatus: 'ok',
    lastSuccessAt: iso(2 * HOUR + 1000),
    now: NOW,
    staleAfterMs: STALE_AFTER,
  });
  check('略超 2 倍周期：标黄', s.stale === true);
}

// ===== 6. 手动录入型实例也参与陈旧判定 =====
// 手动录入型的「最后一次成功」就是最后一次录入余额的时刻，
// 很久没录入同样意味着数据陈旧（应标黄）。
{
  const s = computeQueryStatus({
    lastQueryAt: iso(10 * HOUR),
    lastQueryStatus: 'ok',
    lastSuccessAt: iso(10 * HOUR),
    now: NOW,
    staleAfterMs: STALE_AFTER,
  });
  check('手动录入型：很久没录入 → 标黄', s.stale === true);
  check('手动录入型：仍记录查询时刻', s.hasQuery === true);
}

// ===== 7. 停用平台不参与陈旧判定（避免假警报）=====
{
  const s = computeQueryStatus({
    lastQueryAt: iso(10 * HOUR),
    lastQueryStatus: 'ok',
    lastSuccessAt: iso(10 * HOUR),
    staleEligible: false, // 路由层对停用平台传 staleEligible=false
    now: NOW,
    staleAfterMs: STALE_AFTER,
  });
  check('停用平台：不标黄', s.stale === false);
}

// ===== 8. 时间解析边界 =====
{
  const s = computeQueryStatus({ lastQueryAt: 'not-a-date', now: NOW });
  check('非法时间串按「未查询」处理', s.hasQuery === false && s.lastQueryAt === null);
}
{
  const s = computeQueryStatus({ lastQueryAt: null, lastSuccessAt: null, now: NOW });
  check('空值安全', s.hasQuery === false && s.stale === false && s.failed === false);
}
{
  // 失败后的一次成功尝试：last_query_status 应为 ok → 不标红
  const s = computeQueryStatus({
    lastQueryAt: iso(60 * 1000),
    lastQueryStatus: 'ok',
    lastSuccessAt: iso(60 * 1000),
    now: NOW,
    staleAfterMs: STALE_AFTER,
  });
  check('失败后重试成功：不再标红', s.failed === false);
}

const fail = results.filter((r) => !r.pass);
console.log(`\n结果：共 ${results.length} 项，通过 ${results.length - fail.length}，失败 ${fail.length}`);
if (fail.length) {
  console.log('失败项：');
  for (const f of fail) console.log('  - ' + f.name);
}
process.exit(fail.length ? 1 : 0);
