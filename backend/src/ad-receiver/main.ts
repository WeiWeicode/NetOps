/**
 * netops-ad-receiver 進入點(AD-1;ARCHITECTURE D49、docs/AD-AGENT-PLAN.md §4.1):和 netops-api 同一個映像,Compose 以
 *   command: ["node", "dist/src/ad-receiver/main.js"]
 * 啟動。只寫 netops-redis;不連 ClickHouse、不是 Gateway 上游。獨立容器:改 AD 接收不會重建 netops-pa(H1)。
 */
import { connectAdReceiverRedis } from '../infra/redis/ad-receiver.js';
import { buildAdReceiverApp, type Log } from './app.js';
import { AD_RECEIVER_PORT, loadAdReceiverConfig } from './config.js';

const log: Log = (level, msg, extra = {}) =>
  // 一行 JSON(同 netops-ingest);不含 Token 與事件內容
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: 'netops-ad-receiver', msg, ...extra }));

async function main(): Promise<void> {
  const cfg = loadAdReceiverConfig();
  let redisErrorLogged = 0;
  const redis = connectAdReceiverRedis(cfg.redisUrl, (e) => {
    if (Date.now() - redisErrorLogged > 60_000) {
      redisErrorLogged = Date.now();
      log('warn', 'Redis 連線錯誤', { error: e.message });
    }
  });
  const app = buildAdReceiverApp({ tokens: cfg.tokens, redis, log });
  const stop = async () => {
    await app.close().catch(() => undefined);
    await redis.quit();
    log('info', 'netops-ad-receiver 已停止');
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void stop());
  await app.listen({ host: '0.0.0.0', port: AD_RECEIVER_PORT });
  // 只記 DC 台數與名稱(不記 Token 或雜湊)
  log('info', 'netops-ad-receiver 啟動', { gwEnv: cfg.gwEnv, release: cfg.release, port: AD_RECEIVER_PORT, dcs: cfg.tokens.computers });
}

if (process.argv[1] && /ad-receiver[\\/]main\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    log('error', '啟動失敗', { error: String((e as Error)?.message ?? e) });
    process.exit(1);
  });
}
