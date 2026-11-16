/**
 * FTP 補漏(C3;ARCHITECTURE D33、手冊 §11.3):netops-ingest 從佇列取工作,逐小時:
 *   1. 查 ClickHouse 這一小時已有的 seqno(netops_writer)
 *   2. 從 FTP 逐列讀涵蓋這一小時的 TRAFFIC CSV(只讀,不落地;AGENT.md §7.4)
 *   3. 只寫 seqno 不在 ClickHouse 的列(source = 'ftp');沒有 seqno 的列無法去重,略過並計數
 * 不刪除既有資料(不做 DELETE / REPLACE PARTITION);物化檢視自動補上每小時彙總,netops-api 的每小時摘要偵測到筆數變了會重建。
 * 一次只做一個工作;每批最多 BATCH 列,去重 token 由工作 id、小時與批次組成(重送不重複)。
 */
import type { ClickHouseWriter } from '../infra/clickhouse/index.js';
import type { Ftp } from '../infra/ftp/index.js';
import type { BackfillJob, BackfillQueue } from '../infra/redis/backfill.js';
import { readLog } from '../modules/pa/core/palog.js';
import { parsePaTime, seqno, toTrafficRow } from './rows.js';

const BATCH = 5000;
const HOUR_MS = 3600_000;
/** 一個 FTP 檔最多暫存幾列待寫(PA 匯出檔每檔 65,536 列;超過視為異常檔,工作失敗;資安審查 M2) */
export const PENDING_MAX = 70_000;
/** 工作內容上限:一天最多 24 小時、每小時最多幾個 FTP 檔(資安審查 M1) */
const FILES_PER_HOUR_MAX = 40;
/** 只補最近幾天(ClickHouse TRAFFIC 保留 30 天) */
const MAX_AGE_MS = 31 * 86_400_000;

/**
 * 工作內容來自 Redis(netops-redis 沒有 ACL,同網路還有 netops-pa):執行前再驗一次,不信任 netops-api 以外寫入的內容(資安審查 M1)。
 * 小時要對齊整點、在保留期間內、屬於 job.day;檔案要在 FTP_LOG_DIR 之下、符合 FTP_PATTERN、數量有上限
 */
export function validateJob(job: BackfillJob, rules: { logDir: string; pattern: RegExp; now: number }): string | null {
  if (!job.hours.length || job.hours.length > 24) return '工作的小時數不正確';
  const dir = rules.logDir === '/' ? '/' : `${rules.logDir}/`;
  for (const { hour, files } of job.hours) {
    if (!Number.isInteger(hour) || hour % HOUR_MS !== 0 || hour > rules.now || rules.now - hour > MAX_AGE_MS) return '工作的小時不正確';
    if (new Date(hour + 8 * HOUR_MS).toISOString().slice(0, 10).replace(/-/g, '/') !== job.day) return '工作的小時不屬於該日期';
    if (!Array.isArray(files) || files.length > FILES_PER_HOUR_MAX) return '工作的 FTP 檔數量不正確';
    for (const f of files) {
      const name = typeof f === 'string' ? f.slice(dir.length) : '';
      if (typeof f !== 'string' || !f.startsWith(dir) || !name || name.includes('/') || f.includes('..') || !rules.pattern.test(name)) return '工作的 FTP 檔不在 log 目錄或檔名不符';
    }
  }
  return null;
}

/**
 * FTP TRAFFIC CSV 的欄位(同 core/palog.js 的 COLUMNS,加上 seqno / Session ID;核心逐字沿用舊版不能改,所以另列)。
 * 鍵名同收集器送進 Stream 的 JSON,才能直接用 toTrafficRow
 */
export const BACKFILL_COLUMNS: Record<string, string[]> = {
  time: ['Receive Time', 'Generate Time', 'Time Generated'],
  subtype: ['Threat/Content Type', 'Content/Threat Type', 'Subtype'],
  src: ['Source address', 'Source Address'],
  dst: ['Destination address', 'Destination Address'],
  natSrc: ['NAT Source IP'],
  natDst: ['NAT Destination IP'],
  rule: ['Rule'],
  srcUser: ['Source User'],
  app: ['Application'],
  fromZone: ['Source Zone'],
  toZone: ['Destination Zone'],
  inIf: ['Inbound Interface'],
  outIf: ['Outbound Interface'],
  sport: ['Source Port'],
  dport: ['Destination Port'],
  natDport: ['NAT Destination Port'],
  proto: ['IP Protocol'],
  action: ['Action'],
  bytes: ['Bytes'],
  sent: ['Bytes Sent'],
  recv: ['Bytes Received'],
  packets: ['Packets'],
  start: ['Start Time'],
  elapsed: ['Elapsed Time (sec)'],
  category: ['Category', 'URL Category'],
  srcCountry: ['Source Country'],
  dstCountry: ['Destination Country'],
  endReason: ['Session End Reason'],
  appRisk: ['Risk of app'],
  appCategory: ['Category of app'],
  appSubcat: ['Subcategory of app'],
  appTech: ['Technology of app'],
  srcHost: ['Source Hostname'],
  dstHost: ['Destination Hostname'],
  seqno: ['Sequence Number'],
  sessionId: ['Session ID'],
};
/** 數字欄位(seqno 是 64 位元,保留字串) */
const NUMERIC = new Set(['bytes', 'sent', 'recv', 'packets', 'elapsed', 'sport', 'dport', 'natDport', 'appRisk', 'sessionId']);

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

/** 錯誤訊息:只留分類(AppError 的訊息已分類;其他只留名稱),不帶 log 內容 */
const errText = (e: unknown) => {
  const x = e as { code?: unknown; message?: string; name?: string };
  if (typeof x?.code === 'string' && x.code.startsWith('NETOPS_')) return String(x.message ?? x.code).slice(0, 200);
  if (typeof x?.code === 'number') return `ClickHouse 錯誤(code ${x.code})`;
  return `補漏失敗(${x?.name ?? 'Error'})`;
};

/** 執行一個工作(測試直接呼叫) */
export async function runBackfill(
  job: BackfillJob,
  deps: { ch: ClickHouseWriter; ftp: Ftp; queue: BackfillQueue; log: Log; signal: AbortSignal; rules?: { logDir: string; pattern: RegExp } },
): Promise<void> {
  const { ch, ftp, queue, log, signal } = deps;
  const c = { read: 0, skipped: 0, inserted: 0, noSeqno: 0 };
  try {
    const invalid = deps.rules ? validateJob(job, { ...deps.rules, now: Date.now() }) : null;
    if (invalid) throw Object.assign(new Error(invalid), { code: 'NETOPS_BACKFILL_INVALID' });
    if (!job.hours.length) throw Object.assign(new Error('工作沒有小時'), { code: 'NETOPS_BACKFILL_EMPTY' });
    // 失敗要明確(AGENT.md §5):沒有檔案、FTP 檔沒有 Sequence Number 欄位時不能標成完成(程式碼審查 #1)
    if (job.hours.some((h) => !h.files.length)) throw Object.assign(new Error('有小時找不到涵蓋的 FTP 檔,請先同步分析 FTP 檔'), { code: 'NETOPS_BACKFILL_NO_FILES' });
    const aborted = () => Object.assign(new Error('netops-ingest 停止,工作中斷;可重新送出(只補缺的列,不會重複)'), { code: 'NETOPS_BACKFILL_ABORTED' });
    for (const { hour, files } of job.hours) {
      const have = await ch.trafficSeqnos(hour, hour + HOUR_MS);
      let batch: string[] = [];
      let n = 0;
      const flush = async () => {
        if (!batch.length) return;
        await ch.insertJson('traffic', batch, `backfill:${job.id}:${hour}:${n++}`);
        c.inserted += batch.length;
        batch = [];
        // 進度更新失敗(Redis 暫時斷線)不影響寫入(程式碼審查 #7)
        await queue.update(job.id, c).catch(() => undefined);
      };
      const readBefore = c.read;
      const noSeqBefore = c.noSeqno;
      for (const file of files) {
        if (signal.aborted) throw aborted();
        const opened = await ftp.openStream(file, { signal });
        // 先序列化成 JSON 字串:一個 FTP 檔約 6.5 萬列,物件比字串多佔數倍記憶體(容器 256 MB)
        const pending: string[] = [];
        try {
          const { columns } = await readLog(
            opened.stream,
            file,
            (r: Record<string, unknown>) => {
              // 停止時中斷讀檔(回 false;大檔不用等讀完)
              if (signal.aborted) return false;
              // 以時間值判斷是否在這一小時(不靠字串格式;程式碼審查 #6)
              const ms = parsePaTime(r.time);
              if (!ms || ms.ms < hour || ms.ms >= hour + HOUR_MS) return;
              c.read++;
              // 同 rows.ts 的 seqno():超過 UInt64、不是數字都當沒有 seqno(否則寫成 0,每次補漏都重複;資安審查 L4)
              const seq = seqno(String(r.seqno ?? '').trim());
              if (seq === '0') {
                c.noSeqno++;
                return;
              }
              if (have.has(seq)) {
                c.skipped++;
                return;
              }
              have.add(seq);
              if (pending.length >= PENDING_MAX) throw Object.assign(new Error(`一個 FTP 檔超過 ${PENDING_MAX} 列待補,視為異常檔`), { code: 'NETOPS_BACKFILL_TOO_MANY' });
              pending.push(JSON.stringify({ ...toTrafficRow(r, ms.ms, { badTime: false }), source: 'ftp' }));
            },
            { columns: BACKFILL_COLUMNS as never, numeric: NUMERIC },
          );
          if (signal.aborted) throw aborted();
          if (!(columns as string[]).includes('seqno')) throw Object.assign(new Error('FTP 檔沒有 Sequence Number 欄位,無法去重補漏'), { code: 'NETOPS_BACKFILL_NO_SEQNO' });
          await opened.done;
        } finally {
          opened.abort();
        }
        // readLog 的 onRow 是同步的:一個檔案讀完再分批寫(一個 FTP 檔約 6.5 萬列)
        for (const row of pending) {
          batch.push(row);
          if (batch.length >= BATCH) await flush();
        }
      }
      await flush();
      // 這一小時讀到的列全都沒有 seqno:無法補,標失敗
      if (c.read > readBefore && c.noSeqno - noSeqBefore === c.read - readBefore) throw Object.assign(new Error('FTP 檔的列都沒有 Sequence Number,無法去重補漏'), { code: 'NETOPS_BACKFILL_NO_SEQNO' });
    }
    await queue.update(job.id, { ...c, state: 'done', finishedAt: new Date().toISOString() });
    await queue.finish(job.id).catch(() => undefined);
    log('info', 'FTP 補漏完成', { id: job.id, day: job.day, ...c });
  } catch (e) {
    await queue.update(job.id, { ...c, state: 'failed', error: errText(e), finishedAt: new Date().toISOString() }).catch(() => undefined);
    await queue.finish(job.id).catch(() => undefined);
    log('warn', 'FTP 補漏失敗', { id: job.id, day: job.day, error: errText(e) });
  }
}

/** 背景迴圈:啟動時把上次中斷的工作標失敗(程式碼審查 #2),之後每 intervalMs 看一次佇列,一次做一個 */
export async function backfillLoop(deps: {
  ch: ClickHouseWriter;
  ftp: Ftp;
  queue: BackfillQueue;
  log: Log;
  signal: AbortSignal;
  rules: { logDir: string; pattern: RegExp };
  intervalMs?: number;
}): Promise<void> {
  const wait = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      deps.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
    });
  let lastWarn = 0;
  let recovered = false;
  while (!deps.signal.aborted) {
    let job: BackfillJob | null = null;
    try {
      if (!recovered) {
        const ids = await deps.queue.failInterrupted('netops-ingest 重新啟動,工作中斷;可重新送出(只補缺的列,不會重複)');
        if (ids.length) deps.log('warn', '補漏工作在上次停止時中斷,已標成失敗', { ids });
        recovered = true;
      }
      job = await deps.queue.take();
    } catch (e) {
      // 補漏用的 Redis 連線斷線:一分鐘最多記一次(程式碼審查 #8)
      if (Date.now() - lastWarn > 60_000) {
        lastWarn = Date.now();
        deps.log('warn', '補漏佇列讀取失敗,稍後重試', { error: (e as Error).name });
      }
    }
    if (job) await runBackfill(job, deps);
    else await wait(deps.intervalMs ?? 10_000);
  }
}
