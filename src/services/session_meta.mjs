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
      account: j.account || null,
    };
  } catch {
    return null;
  }
}

// 合并写入会话元信息（只覆盖传入的字段）
export function writeSessionMeta(storageFile, patch = {}) {
  const cur = readSessionMeta(storageFile) || { loggedInAt: null, lastAliveAt: null, account: null };
  const next = {
    loggedInAt: patch.loggedInAt !== undefined ? patch.loggedInAt : cur.loggedInAt,
    lastAliveAt: patch.lastAliveAt !== undefined ? patch.lastAliveAt : cur.lastAliveAt,
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
  return writeSessionMeta(storageFile, { loggedInAt: now, lastAliveAt: now, account });
}

// 记录一次「访问网厅且会话仍然有效」：更新上次有效访问时刻
export function markSessionAlive(storageFile, account = null) {
  return writeSessionMeta(storageFile, { lastAliveAt: Date.now(), account });
}

// 记录「会话已失效」：清掉计时起点，让倒计时不再给出乐观估计
export function markSessionDead(storageFile) {
  return writeSessionMeta(storageFile, { lastAliveAt: null });
}
