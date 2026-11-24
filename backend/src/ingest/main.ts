/**
 * netops-ingest 進入點(C2;ARCHITECTURE D28、手冊 §6、§10.1):和 netops-api 同一個映像,Compose 以
 *   command: ["node", "dist/src/ingest/main.js"]
 * 啟動。不是 Gateway 上游、不開 port、不接 setupGateway(D24);狀態寫心跳 Hash netops:ingest:heartbeat
 * (每 HEARTBEAT_MS 一次,同時做缺口偵測),容器健康檢查看 ALIVE_FILE 的修改時間。
 * 單一容器(不要加 replicas):consumer 名稱固定,待處理清單與去重 token 才穩定。
 */
import { writeFileSync } from 'node:fs';
import { createClickHouseWriter } from '../infra/clickhouse/index.js';
import { AD_TYPES, connectIngestRedis, INGEST_TYPES, type IngestRedis } from '../infra/redis/ingest.js';
import { loadIngestConfig, type IngestConfig } from './config.js';
import { COUNTERS, sleep, Writer } from './writer.js';
import { createFtp } from '../infra/ftp/index.js';
import { connectBackfillQueue } from '../infra/redis/backfill.js';
import { backfillLoop } from './backfill.js';
import { adBackfillLoop } from './ad-backfill.js';
import { connectAdBackfillQueue } from '../infra/redis/ad-backfill.js';
import { createAdBackfillCh } from '../infra/clickhouse/ad-backfill.js';
import { AD_ARCHIVE_KIND_LIST, createArchiveWriterClient, createColdFileClient } from '../infra/clickhouse/archive.js';
import { connectColdLock } from '../infra/redis/cold-lock.js';
import { archiveHeartbeatFields, archiveLoop, Archiver } from './archive.js';

export const HEARTBEAT_MS = 10_000;
/** 健康檢查:主迴圈每次推進都更新(Compose healthcheck 看 2 分鐘內有沒有更新) */
export const ALIVE_FILE = '/tmp/netops-ingest.alive';

const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) =>
  // 一行 JSON,和 netops-api(pino)同樣能被 docker logs 收集;不含機密與 log 內容
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: 'netops-ingest', msg, ...extra }));

/** Writer 的狀態字串(PA 寫在 state,AD 寫在 adState) */
const writerState = (w: Writer) => (!w.status.ready ? 'starting' : w.status.schemaError ? 'clickhouse-schema-error' : w.status.failing > 0 ? 'clickhouse-failing' : 'ok');

/** 每種類型的計數、ACK 位置與缺口 */
function typeFields(w: Writer, now: number, f: Record<string, string>) {
  const s = w.status;
  for (const t of w.types) {
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
}

/**
 * AD 事件寫入(AD-1)的心跳欄位:adState / adFailing / adLastInsertAt / adLastError…,計數 read:ad 等;
 * 和 PA 的 state 分開(AD 寫入失敗不影響 PA 的 state 與 CI 部署檢查)
 */
export function adHeartbeatFields(w: Writer | null, now = Date.now(), archiver: Archiver | null = null): Record<string, string> {
  if (!w) return {};
  const s = w.status;
  const f: Record<string, string> = {
    ...archiveHeartbeatFields(archiver, 'adArchive'),
    adState: writerState(w),
    adFailing: String(s.failing),
    adInsertFailures: String(s.insertFailures),
    adLastInsertAt: s.lastInsertAt ?? '',
    adAliveAt: new Date(s.aliveAt).toISOString(),
  };
  typeFields(w, now, f);
  if (s.lastError) {
    f.adLastError = s.lastError.message;
    f.adLastErrorAt = s.lastError.at;
    f.adLastErrorWhere = s.lastError.where;
  }
  return f;
}

/** 心跳欄位(全部字串);netops-api 的 /readyz 與畫面在 C3 讀 */
export function heartbeatFields(w: Writer, cfg: Pick<IngestConfig, 'gwEnv' | 'release'>, startedAt: string, now = Date.now(), archiver: Archiver | null = null): Record<string, string> {
  const s = w.status;
  const f: Record<string, string> = {
    ...archiveHeartbeatFields(archiver),
    updatedAt: new Date(now).toISOString(),
    startedAt,
    release: cfg.release,
    gwEnv: cfg.gwEnv,
    state: writerState(w),
    failing: String(s.failing),
    insertFailures: String(s.insertFailures),
    lastInsertAt: s.lastInsertAt ?? '',
  };
  typeFields(w, now, f);
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
  const onRedisError = (e: Error) => {
    // ioredis 斷線時每次重連都會觸發;一分鐘最多記一次(PA、AD 的連線共用)
    if (Date.now() - redisErrorLogged > 60_000) {
      redisErrorLogged = Date.now();
      log('warn', 'Redis 連線錯誤', { error: e.message });
    }
  };
  const redis: IngestRedis = connectIngestRedis(cfg.redisUrl, onRedisError);
  const ch = createClickHouseWriter(cfg.clickhouse);
  const writer = new Writer(redis, ch, { batchMs: cfg.batchMs, batchMax: cfg.batchMax }, undefined, undefined, INGEST_TYPES);
  // AD 事件(AD-1):另一個 Writer 與 Redis 連線(XREADGROUP BLOCK 佔住連線),寫入失敗時只影響 AD,不卡住 PA
  const adRedis: IngestRedis = connectIngestRedis(cfg.redisUrl, onRedisError);
  const adWriter = new Writer(adRedis, ch, { batchMs: cfg.batchMs, batchMax: cfg.batchMax }, undefined, undefined, AD_TYPES);
  const stop = new AbortController();
  // 冷歸檔(C4):NETOPS_ARCHIVE_ENABLED=1 才執行;匯出用 netops_writer(長時間串流,不設一般請求逾時),讀回核對用 netops_cold
  const coldLock = cfg.archive ? connectColdLock(cfg.redisUrl) : null;
  const archiveDeps = cfg.archive && coldLock ? { ch: createArchiveWriterClient({ ...cfg.clickhouse, timeoutMs: 120_000 }), cold: createColdFileClient({ ...cfg.archive.cold, timeoutMs: 120_000 }), lock: coldLock, log } : null;
  const archiver = cfg.archive && archiveDeps ? new Archiver(archiveDeps, cfg.archive) : null;
  // AD 事件的 Parquet(AD-1):ad-archive 目錄,同一個排程迴圈(PA 之後)
  const adArchiver = cfg.archive && archiveDeps ? new Archiver(archiveDeps, { ...cfg.archive, dir: cfg.archive.adDir, kinds: AD_ARCHIVE_KIND_LIST }) : null;
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
      const gaps = await adWriter.checkGaps();
      for (const g of gaps) log('warn', '偵測到 AD 缺口(Stream 已修剪,未寫進 ClickHouse;AD-3 交給 FTP 補漏)', { ...g });
    } catch (e) {
      adWriter.status.fail('redis', e);
    }
    try {
      await redis.writeHeartbeat({ ...heartbeatFields(writer, cfg, startedAt, Date.now(), archiver), ...adHeartbeatFields(adWriter, Date.now(), adArchiver) });
    } catch (e) {
      writer.status.fail('redis', e);
    }
    // 健康檢查只看 PA 主迴圈(AD 卡住不讓整個容器被重啟、連帶中斷 PA;AD 的狀態看心跳 adState / adAliveAt,code review L11)
    if (Date.now() - writer.status.aliveAt < 2 * cfg.batchMs + 61_000) touch();
  };
  const timer = setInterval(() => void beat(), HEARTBEAT_MS);

  log('info', 'netops-ingest 啟動', { gwEnv: cfg.gwEnv, release: cfg.release, batchMs: cfg.batchMs, batchMax: cfg.batchMax });
  // 啟動:等 ClickHouse 與 Redis 都可用(compose depends_on 已等 healthy;這裡再確認帳密)
  for (let attempt = 0; !stop.signal.aborted; attempt++) {
    try {
      await ch.ping();
      await writer.init();
      await adWriter.init();
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
  // AD FTP 補漏(AD-3):同一個 FTP 設定(FTP_AD_DIR),和 PA 補漏各自一次一個工作
  const adBackfillQueue = cfg.ftp ? connectAdBackfillQueue(cfg.redisUrl) : null;
  const adBackfill =
    adBackfillQueue && cfg.ftp
      ? adBackfillLoop({
          ch,
          q: createAdBackfillCh(cfg.clickhouse),
          ftp: createFtp(cfg.ftp),
          queue: adBackfillQueue,
          log,
          signal: stop.signal,
          rules: { adDir: cfg.ftp.adDir, ttlDays: cfg.adTtlDays },
        })
      : Promise.resolve();
  const archiving = archiver && adArchiver ? archiveLoop([archiver, adArchiver], stop.signal, log) : Promise.resolve();
  log('info', cfg.archive ? '冷歸檔已啟用' : 'NETOPS_ARCHIVE_ENABLED 不是 1,不執行冷歸檔', cfg.archive ? { keepDays: cfg.archive.keepDays, alertDays: cfg.archive.alertDays } : {});

  // 主迴圈(PA、AD 各一個,並行):Redis 錯誤(連線中斷)時退避後重來;重來會先補待處理清單
  const runLoop = async (w: Writer, name: string) => {
    for (let attempt = 0; !stop.signal.aborted; ) {
      const before = w.status.aliveAt;
      try {
        await w.run(stop.signal);
      } catch (e) {
        // 這次 run 有推進過(讀到資料或完成過一輪)就是新的一次斷線:退避從 1 秒重新算
        if (w.status.aliveAt > before) attempt = 0;
        w.status.fail('redis', e);
        log('warn', '讀取 Redis 失敗,稍後重試', { writer: name, error: w.status.lastError?.message });
        await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5)), stop.signal);
      }
    }
  };
  await Promise.all([runLoop(writer, 'pa'), runLoop(adWriter, 'ad')]);

  clearInterval(timer);
  await backfill;
  await backfillQueue?.close();
  await adBackfill;
  await adBackfillQueue?.close();
  await archiving;
  await coldLock?.close();
  await beat();
  await redis.quit();
  await adRedis.quit();
  log('info', 'netops-ingest 已停止', { counts: writer.status.counts, adCounts: adWriter.status.counts });
}

// 只在直接執行時啟動(測試 import 時不啟動)
if (process.argv[1] && /ingest[\\/]main\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    log('error', '啟動失敗', { error: String((e as Error)?.message ?? e) });
    process.exit(1);
  });
}
