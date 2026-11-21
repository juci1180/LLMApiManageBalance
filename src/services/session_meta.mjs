// 运营商登录态的会话元信息（登录时刻 / 上次有效访问时刻 / 绑定号码）
//
// 为什么需要单独存一份，而不是直接看 cookie 的过期时间：
//   实测（2026-11-20 晚）两家机制完全不同：
//   - 移动 chargeresource：每次访问*值不变*、只有过期时间被推到「访问时刻+30 分钟」。
//     服务端没有换发会话 → 定期访问只是让 cookie 看起来还新鲜，
//     实际会话在「登录时刻 + 约 60 分钟」被服务端作废。保活续不了它。
//   - 电信 yiUIIlbdQT3fT：每次访问*被换发新值*（= 新会话），窗口约 60 分钟。
//     只要在窗口内访问就能一直续下去。
//   所以「预计存活」必须基于「登录时刻」或「上次成功访问时刻」推算，
//   而不是 cookie 的 expires（那会把电信显示成 7 天，实际 1 小时就死）。
//
// 为什么放 sidecar 文件而不是数据库：
//   登录脚本（scripts/wallet-login.mjs）与服务端是两个进程，各自有 sql.js 内存库，
//   同时写同一个 db 文件会互相覆盖。sidecar 文件是纯文件读写，天然无冲突。
import fs from 'node:fs';
import path from 'node:path';

// 从页面正文里取脱敏手机号（网厅登录后右上角会显示），例如 178****6402
export function parseMaskedAccount(text) {
  const m = String(text || '').match(/1\d{2}\*{4}\d{4}/);
  return m ? m[0] : null;
}

function metaPath(storageFile) {
  return `${storageFile}.meta.json`;
}

// 读取会话元信息；文件不存在或损坏时返回 null（调用方按「无元信息」处理）
export function readSessionMeta(storageFile) {
  try {
    const raw = fs.readFileSync(metaPath(storageFile), 'utf-8');
    const j = JSON.parse(raw);
    return {
      loggedInAt: Number(j.loggedInAt) || null,
      lastAliveAt: Number(j.lastAliveAt) || null,
      // 「首次」确认已失效的时刻——一旦记录就不再被后续观测覆盖。
      // 为什么要有它（实测 2026-11-21 16:37）：用户问「多久掉的」时，
      // 之前只能拿到最后一次确认失效的时刻（每隔 10~20 分钟就被刷新一次），
      // 与真正掉线的时刻差了两个多小时。首次失效时刻才是答案。
      deadAt: Number(j.deadAt) || null,
      // 最近一次确认已失效的时刻（每次观测都更新，用于「已失效多久」）
      lastDeadAt: Number(j.lastDeadAt) || null,
      // 失效原因（跳登录页 / 服务端失效标记 / 页面已无登录标识）
      deadReason: j.deadReason || null,
      // 最近一次「从失效恢复为有效」的时刻——会话被重新登录后由第一次有效访问确定。
      // 用途：用户没走我们的登录脚本扫码时（loggedInAt 缺失），用它作为倒计时锚点的兜底。
      aliveSince: Number(j.aliveSince) || null,
      // 保活最近一次运行的结果：'alive' 访问成功 / 'dead' 判定失效 / 'error' 抛异常
      // 为什么要记（实测 2026-11-21）：原先保活异常只打一行日志就过去了，
      // 界面上的状态与「保活根本没跑」长得一模一样，无法区分。
      keepaliveState: j.keepaliveState || null,
      keepaliveAt: Number(j.keepaliveAt) || null,
      keepaliveReason: j.keepaliveReason || null,
      account: j.account || null,
    };
  } catch {
    return null;
  }
}

// 合并写入会话元信息（只覆盖传入的字段）
export function writeSessionMeta(storageFile, patch = {}) {
  const cur = readSessionMeta(storageFile) || {
    loggedInAt: null, lastAliveAt: null, deadAt: null, lastDeadAt: null, deadReason: null,
    aliveSince: null, keepaliveState: null, keepaliveAt: null, keepaliveReason: null, account: null,
  };
  const next = {
    loggedInAt: patch.loggedInAt !== undefined ? patch.loggedInAt : cur.loggedInAt,
    lastAliveAt: patch.lastAliveAt !== undefined ? patch.lastAliveAt : cur.lastAliveAt,
    deadAt: patch.deadAt !== undefined ? patch.deadAt : cur.deadAt,
    lastDeadAt: patch.lastDeadAt !== undefined ? patch.lastDeadAt : cur.lastDeadAt,
    deadReason: patch.deadReason !== undefined ? patch.deadReason : cur.deadReason,
    aliveSince: patch.aliveSince !== undefined ? patch.aliveSince : cur.aliveSince,
    keepaliveState: patch.keepaliveState !== undefined ? patch.keepaliveState : cur.keepaliveState,
    keepaliveAt: patch.keepaliveAt !== undefined ? patch.keepaliveAt : cur.keepaliveAt,
    keepaliveReason: patch.keepaliveReason !== undefined ? patch.keepaliveReason : cur.keepaliveReason,
    account: patch.account !== undefined ? patch.account : cur.account,
  };
  try {
    fs.mkdirSync(path.dirname(storageFile), { recursive: true });
    const tmp = `${metaPath(storageFile)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(tmp, metaPath(storageFile));
    return next;
  } catch {
    return next;
  }
}

// 记录一次「成功登录」：重置计时起点（窗口从登录时刻起算）
export function markSessionLoggedIn(storageFile, account = null) {
  const now = Date.now();
  return writeSessionMeta(storageFile, {
    loggedInAt: now, lastAliveAt: now,
    // 重新登录 = 新的会话周期，之前记录的失效时刻不再有意义
    deadAt: null, lastDeadAt: null, deadReason: null,
    aliveSince: now,
    // 保活字段清空：登录不是一次保活运行。
    // 留着上一次会话的 keepaliveState='dead' 会让界面误报「保活判定失效」，
    // 而实际上保活还没跑过这一轮（新会话）。清空后界面显示「保活尚未运行」，是事实。
    keepaliveState: null, keepaliveAt: null, keepaliveReason: null,
    account,
  });
}

// 记录一次「访问网厅且会话仍然有效」：更新上次有效访问时刻。
// 若之前记录过「已失效」，说明用户重新登录过了 → 这一刻就是新会话的起点
// （loggedInAt 缺失时，aliveSince 就是倒计时的兜底锚点）。
export function markSessionAlive(storageFile, account = null) {
  const cur = readSessionMeta(storageFile);
  const revived = Boolean(cur && cur.deadAt && !cur.lastAliveAt);
  return writeSessionMeta(storageFile, {
    lastAliveAt: Date.now(),
    deadAt: revived ? null : (cur ? cur.deadAt : null),
    lastDeadAt: revived ? null : (cur ? cur.lastDeadAt : null),
    deadReason: revived ? null : (cur ? cur.deadReason : null),
    aliveSince: revived ? Date.now() : (cur ? cur.aliveSince : Date.now()),
    account: account !== undefined ? account : (cur ? cur.account : null),
  });
}

// 记录「会话已失效」：清掉计时起点，让倒计时不再给出乐观估计。
// deadAt = **首次**失效时刻（一旦记录就不再覆盖），lastDeadAt = 最近一次确认时刻。
// reason：失效原因，写进 meta 供界面显示，不用再翻日志。
export function markSessionDead(storageFile, reason = null) {
  const cur = readSessionMeta(storageFile);
  const now = Date.now();
  return writeSessionMeta(storageFile, {
    lastAliveAt: null,
    // 首次失效时刻：已有就保留，不覆盖
    deadAt: cur && cur.deadAt ? cur.deadAt : now,
    lastDeadAt: now,
    // 原因：本次没给就沿用上一次已有的，不能被抹成 null
    // （实测 2026-11-21：保活记了「页面已无登录标识」，
    //   随后的抓取路径又调了一次不带原因的 markSessionDead，把原因冲掉了）
    deadReason: reason || (cur ? cur.deadReason : null),
    // 注意：这里**不**写 keepaliveState / keepaliveAt。
    // 那些字段只描述「保活这一条链路」的状态，由 markSessionKeepalive 独占写入。
    // 早先这里一并写 'dead'，导致巡检刷新失败（走 markSessionDead）也会把
    // keepaliveAt 刷成刷新时刻——界面于是显示「保活判定失效」，
    // 而实际上保活根本没判定过失效，是巡检先发现的（实测 2026-11-21）。
  });
}

// 记录保活的一次运行结果（保活链路独占写这三个字段）。
// 为什么要单独记（实测 2026-11-21）：保活抛异常时原先只打一行日志，
// 界面上看不出「保活跑了但失败」和「保活根本没跑」的区别——
// 前者说明网厅有问题，后者说明服务没在跑，两者的处置完全不同。
// state: 'alive' | 'dead' | 'error'
export function markSessionKeepalive(storageFile, state, reason = null) {
  return writeSessionMeta(storageFile, {
    keepaliveState: state,
    keepaliveAt: Date.now(),
    keepaliveReason: reason || null,
  });
}
