// 输出 config.json 里配置的服务端口（供 启动项.bat 等脚本读取，避免端口写死）
// 用法：node scripts/port.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const cfg = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));
  process.stdout.write(String(cfg.port ?? 3000));
} catch {
  process.stdout.write('3000');
}
