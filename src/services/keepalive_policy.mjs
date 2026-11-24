// 保活（自动续命）开关：读 config.json 的 keepalive 段。
//
// 为什么做成配置而不是删代码（实测 2026-11-24）：
//   保活会按 CARRIER_KEEPALIVE_MS 定期访问网厅。189.cn（电信）对无头浏览器做站点级
//   拦截，只能用有头窗口抓——于是每 10~20 分钟就弹一次浏览器窗口。
//   用户明确要求关掉。做成配置开关后，改一行 json + 重启即可关，不必改代码。
//
// config.json 结构：
//   "keepalive": {
//     "enabled": true,                                  // 总开关；false = 全部运营商都不保活
//     "disabledProviders": ["carrier_cmcc", "carrier_ct"]  // 只关掉这几家
//   }
//
// 未配置 keepalive 段时行为不变（全部照旧保活），向后兼容。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARRIER_KEEPALIVE_MS } from './scraper_wallets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', '..', 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

// 总开关：默认开（只有显式写 false 才关）
export function keepAliveMasterEnabled(config = readConfig()) {
  return config?.keepalive?.enabled !== false;
}

// 单个运营商是否被单独关掉
export function keepAliveDisabledFor(provider, config = readConfig()) {
  const list = config?.keepalive?.disabledProviders;
  return Array.isArray(list) && list.includes(provider);
}

// 该运营商当前是否跑保活
export function keepAliveEnabledFor(provider, config = readConfig()) {
  if (!keepAliveMasterEnabled(config)) return false;
  return !keepAliveDisabledFor(provider, config);
}

// 实际生效的保活间隔（毫秒）。
// 关掉时返回 0：调用方据此跳过保活；界面据此不再把「保活」算进下一次访问网厅的时刻。
export function keepAliveIntervalMs(provider, config = readConfig()) {
  if (!keepAliveEnabledFor(provider, config)) return 0;
  return CARRIER_KEEPALIVE_MS[provider] || 0;
}
