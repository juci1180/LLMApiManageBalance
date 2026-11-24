// 自动巡检的抓取策略：决定自动任务能不能弹浏览器窗口、该不该跳过某个平台。
//
// 为什么需要（实测 2026-11-24）：
//   用户反馈「一直弹窗浏览器，烦」。排查结论：弹窗来自**每小时余额巡检**，不是保活
//   （保活当天 12:58 就已关闭，服务日志里三家都打印了「不再访问网厅」）。
//   巡检之所以弹窗，有两条路径：
//     1) 189.cn（电信）对无头浏览器做站点级拦截（有头正文 1257 字 / 无头 0 字），
//        抓取时只能开可见窗口；
//     2) 移动先用无头抓，未登录时必然失败，随后回退到可见窗口重试。
//   两家当前都未登录，于是每轮巡检都会走完「无头失败 → 可见窗口重试 → 仍然失败」，
//   弹窗一次都省不掉。
//
// 策略（config.json 的 scrape 段）：
//   headedInAuto        自动巡检是否允许开可见窗口，默认 false（不允许）
//   skipLoggedOutInAuto 自动巡检是否跳过已确认掉线的平台，默认 true（跳过）
//
// 手动刷新（界面按钮）不受这些开关限制：用户在场，弹窗是预期行为。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', '..', 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

// 自动巡检是否允许开可见窗口（默认不允许）
export function autoHeadedAllowed(config = readConfig()) {
  return config?.scrape?.headedInAuto === true;
}

// 自动巡检是否跳过已确认掉线的平台（默认跳过）
export function autoSkipLoggedOut(config = readConfig()) {
  return config?.scrape?.skipLoggedOutInAuto !== false;
}

// 会话是否已确认失效（服务端作废过，且此后没有再成功访问过）
// 判据来自登录态旁边的 sidecar 元信息：
//   deadAt      首次确认失效的时刻（重新登录会被清空）
//   lastAliveAt 最近一次成功访问的时刻（失效时被置空）
export function sessionConfirmedLoggedOut(meta) {
  if (!meta) return false;
  if (!meta.deadAt) return false;
  return !meta.lastAliveAt;
}
