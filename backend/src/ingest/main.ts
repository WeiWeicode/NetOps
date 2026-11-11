/**
 * netops-ingest 進入點(C2;ARCHITECTURE D28、手冊 §6、§10.1):和 netops-api 同一個映像,Compose 以
 *   command: ["node", "dist/src/ingest/main.js"]
 * 啟動。不是 Gateway 上游、不開 port、不接 setupGateway(D24);狀態寫心跳 Hash netops:ingest:heartbeat
 * (每 HEARTBEAT_MS 一次,同時做缺口偵測),容器健康檢查看 ALIVE_FILE 的修改時間。
 * 單一容器(不要加 replicas):consumer 名稱固定,待處理清單與去重 token 才穩定。
 */
import { writeFileSync } from 'node:fs';
import { createClickHouseWriter } from '../infra/clickhouse/index.js';
import { connectIngestRedis, INGEST_TYPES, type IngestRedis } from '../infra/redis/ingest.js';
import { loadIngestConfig, type IngestConfig } from './config.js';
import { COUNTERS, sleep, Writer } from './writer.js';
import { createFtp } from '../infra/ftp/index.js';
import { connectBackfillQueue } from '../infra/redis/backfill.js';
import { backfillLoop } from './backfill.js';

export const HEARTBEAT_MS = 10_000;
/** 健康檢查:主迴圈每次推進都更新(Compose healthcheck 看 2 分鐘內有沒有更新) */
export const ALIVE_FILE = '/tmp/netops-ingest.alive';

const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) =>
  // 一行 JSON,和 netops-api(pino)同樣能被 docker logs 收集;不含機密與 log 內容
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: 'netops-ingest', msg, ...extra }));

/** 心跳欄位(全部字串);netops-api 的 /readyz 與畫面在 C3 讀 */
export function heartbeatFields(w: Writer, cfg: Pick<IngestConfig, 'gwEnv' | 'release'>, startedAt: string, now = Date.now()): Record<string, string> {
  const s = w.status;
  const f: Record<string, string> = {
    updatedAt: new Date(now).toISOString(),
    startedAt,
    release: cfg.release,
    gwEnv: cfg.gwEnv,
    state: !s.ready ? 'starting' : s.schemaError ? 'clickhouse-schema-error' : s.failing > 0 ? 'clickhouse-failing' : 'ok',
    failing: String(s.failing),
    insertFailures: String(s.insertFailures),
    lastInsertAt: s.lastInsertAt ?? '',
  };
  for (const t of INGEST_TYPES) {
    for (const c of COUNTERS) f[`${c}:${t}`] = String(s.counts[t][c]);
    const acked = s.lastAcked[t];
    if (acked) {
      f[`lastAcked:${t}`] = acked;
      f[`lagMs:${t}`] = String(Math.max(0, now - Number(acked.split('-', 1)[0])));
    }
    const g = s.gaps[t];
    if (g) {
      f[`gapFrom:${t}`] = g.from;
      f[`gapTo:${t}`] = g.to;
      f[`gapKind:${t}`] = g.kind;
      if (g.missed !== null) f[`gapMissed:${t}`] = String(g.missed);
    }
  }
  if (s.lastError) {
    f.lastError = s.lastError.message;
    f.lastErrorAt = s.lastError.at;
    f.lastErrorWhere = s.lastError.where;
  }
  return f;
}

async function main(): Promise<void> {
  const cfg = loadIngestConfig();
  const startedAt = new Date().toISOString();
  let redisErrorLogged = 0;
  const redis: IngestRedis = connectIngestRedis(cfg.redisUrl, (e) => {
    // ioredis 斷線時每次重連都會觸發;一分鐘最多記一次
    if (Date.now() - redisErrorLogged > 60_000) {
      redisErrorLogged = Date.now();
      log('warn', 'Redis 連線錯誤', { error: e.message });
    }
  });
  const ch = createClickHouseWriter(cfg.clickhouse);
  const writer = new Writer(redis, ch, { batchMs: cfg.batchMs, batchMax: cfg.batchMax });
  const stop = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => stop.abort());

  const touch = () => {
    try {
      writeFileSync(ALIVE_FILE, String(writer.status.aliveAt));
    } catch {
      // 寫不進去只會讓健康檢查失敗,不影響寫入
    }
  };

  // 心跳與缺口偵測:另一個計時器,ClickHouse 重試期間也照常更新
  const beat = async () => {
    try {
      const gaps = await writer.checkGaps();
      for (const g of gaps) log('warn', '偵測到缺口(Stream 已修剪,未寫進 ClickHouse;交給 FTP 補漏)', { ...g });
    } catch (e) {
      writer.status.fail('redis', e);
    }
    try {
      await redis.writeHeartbeat(heartbeatFields(writer, cfg, startedAt));
    } catch (e) {
      writer.status.fail('redis', e);
    }
    if (Date.now() - writer.status.aliveAt < 2 * cfg.batchMs + 61_000) touch();
  };
  const timer = setInterval(() => void beat(), HEARTBEAT_MS);

  log('info', 'netops-ingest 啟動', { gwEnv: cfg.gwEnv, release: cfg.release, batchMs: cfg.batchMs, batchMax: cfg.batchMax });
  // 啟動:等 ClickHouse 與 Redis 都可用(compose depends_on 已等 healthy;這裡再確認帳密)
  for (let attempt = 0; !stop.signal.aborted; attempt++) {
    try {
      await ch.ping();
      await writer.init();
      break;
    } catch (e) {
      writer.status.fail('startup', e);
      log('warn', '啟動檢查失敗,稍後重試', { error: writer.status.lastError?.message });
      await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)), stop.signal);
    }
  }
  touch();
  void beat();

  // FTP 補漏(C3):有設定 FTP 才執行;和寫入主迴圈並行,一次一個工作
  const backfillQueue = cfg.ftp ? connectBackfillQueue(cfg.redisUrl) : null;
  const backfill = backfillQueue && cfg.ftp ? backfillLoop({ ch, ftp: createFtp(cfg.ftp), queue: backfillQueue, log, signal: stop.signal, rules: { logDir: cfg.ftp.logDir, pattern: cfg.ftp.pattern } }) : Promise.resolve();
  log('info', cfg.ftp ? 'FTP 補漏已啟用' : '沒有設定 FTP_HOST,不執行 FTP 補漏');

  // 主迴圈:Redis 錯誤(連線中斷)時退避後重來;重來會先補待處理清單
  for (let attempt = 0; !stop.signal.aborted; ) {
    const before = writer.status.aliveAt;
    try {
      await writer.run(stop.signal);
    } catch (e) {
      // 這次 run 有推進過(讀到資料或完成過一輪)就是新的一次斷線:退避從 1 秒重新算
      if (writer.status.aliveAt > before) attempt = 0;
      writer.status.fail('redis', e);
      log('warn', '讀取 Redis 失敗,稍後重試', { error: writer.status.lastError?.message });
      await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5)), stop.signal);
    }
  }

  clearInterval(timer);
  await backfill;
  await backfillQueue?.close();
  await beat();
  await redis.quit();
  log('info', 'netops-ingest 已停止', { counts: writer.status.counts });
}

// 只在直接執行時啟動(測試 import 時不啟動)
if (process.argv[1] && /ingest[\\/]main\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    log('error', '啟動失敗', { error: String((e as Error)?.message ?? e) });
    process.exit(1);
  });
}
