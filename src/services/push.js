// 手机推送：Server酱（微信）+ Bark（iPhone），可同时配置，哪个有 key 就发哪个
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let config = {};
try {
  config = JSON.parse(readFileSync(join(__dirname, '..', '..', 'config.json'), 'utf-8'));
} catch {}

const serverchanKey = config.notify?.serverchan || '';
const barkKey = config.notify?.bark || '';

// 发送手机推送（不抛异常，通知失败不影响巡检）
// 返回值里带上 delivered 字段：是否真的送达。
// 为什么要这个字段（实测 2026-11-20 晚）：
//   config.json 里 notify.serverchan / notify.bark 可能都是空的，
//   此时 sendPhoneNotify 什么都不发，但调用方原来无条件打印「已推送登录态失效提醒」——
//   日志谎报“已通知”，用户以为会收到提醒，实际一条都没收到，
//   结果只能在界面上看到「未登录」才知道掉了线。
export async function sendPhoneNotify(title, body) {
  const results = {};
  let delivered = false;
  if (serverchanKey) {
    try {
      const r = await fetch(`https://sctapi.ftqq.com/${serverchanKey}.send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(body)}`,
      });
      results.serverchan = r.ok ? 'ok' : `http ${r.status}`;
      if (r.ok) delivered = true;
    } catch (err) {
      results.serverchan = 'error: ' + err.message;
    }
  }
  if (barkKey) {
    try {
      const r = await fetch(
        `https://api.day.app/${barkKey}/${encodeURIComponent(title)}?body=${encodeURIComponent(body)}&group=${encodeURIComponent('余额预警')}`,
        { method: 'POST' }
      );
      results.bark = r.ok ? 'ok' : `http ${r.status}`;
      if (r.ok) delivered = true;
    } catch (err) {
      results.bark = 'error: ' + err.message;
    }
  }
  return { ...results, delivered };
}

// 是否已配置任一手机通道
export function hasPhoneNotify() {
  return Boolean(serverchanKey || barkKey);
}
