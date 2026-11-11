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
import { parsePaTime, toTrafficRow } from './rows.js';

const BATCH = 5000;
const HOUR_MS = 3600_000;

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

/** 'yyyy/MM/dd HH'(台灣時間) */
const hourKey = (ms: number) => new Date(ms + 8 * HOUR_MS).toISOString().slice(0, 13).replace(/-/g, '/').replace('T', ' ');

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

/** 錯誤訊息:只留分類(AppError 的訊息已分類;其他只留名稱),不帶 log 內容 */
const errText = (e: unknown) => {
  const x = e as { code?: unknown; message?: string; name?: string };
  if (typeof x?.code === 'string' && x.code.startsWith('NETOPS_')) return String(x.message ?? x.code).slice(0, 200);
  if (typeof x?.code === 'number') return `ClickHouse 錯誤(code ${x.code})`;
  return `補漏失敗(${x?.name ?? 'Error'})`;
};

/** 執行一個工作(測試直接呼叫) */
export async function runBackfill(job: BackfillJob, deps: { ch: ClickHouseWriter; ftp: Ftp; queue: BackfillQueue; log: Log; signal: AbortSignal }): Promise<void> {
  const { ch, ftp, queue, log, signal } = deps;
  const c = { read: 0, skipped: 0, inserted: 0, noSeqno: 0 };
  try {
    if (!job.hours.length) throw Object.assign(new Error('工作沒有小時'), { code: 'NETOPS_BACKFILL_EMPTY' });
    for (const { hour, files } of job.hours) {
      const key = hourKey(hour);
      const have = await ch.trafficSeqnos(hour, hour + HOUR_MS);
      let batch: string[] = [];
      let n = 0;
      const flush = async () => {
        if (!batch.length) return;
        await ch.insertJson('traffic', batch, `backfill:${job.id}:${hour}:${n++}`);
        c.inserted += batch.length;
        batch = [];
        await queue.update(job.id, c);
      };
      for (const file of files) {
        if (signal.aborted) throw Object.assign(new Error('netops-ingest 停止中,工作中斷'), { code: 'NETOPS_BACKFILL_ABORTED' });
        const opened = await ftp.openStream(file, { signal });
        // 先序列化成 JSON 字串:一個 FTP 檔約 6.5 萬列,物件比字串多佔數倍記憶體(容器 256 MB)
        const pending: string[] = [];
        try {
          await readLog(
            opened.stream,
            file,
            (r: Record<string, unknown>) => {
              const t = String(r.time ?? '');
              if (t.slice(0, 13) !== key) return;
              c.read++;
              const seq = String(r.seqno ?? '').trim();
              if (!/^[1-9]\d{0,19}$/.test(seq)) {
                c.noSeqno++;
                return;
              }
              if (have.has(seq)) {
                c.skipped++;
                return;
              }
              have.add(seq);
              const ms = parsePaTime(t)?.ms ?? hour;
              pending.push(JSON.stringify({ ...toTrafficRow(r, ms, { badTime: false }), source: 'ftp' }));
            },
            { columns: BACKFILL_COLUMNS as never, numeric: NUMERIC },
          );
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
    }
    await queue.update(job.id, { ...c, state: 'done', finishedAt: new Date().toISOString() });
    log('info', 'FTP 補漏完成', { id: job.id, day: job.day, ...c });
  } catch (e) {
    await queue.update(job.id, { ...c, state: 'failed', error: errText(e), finishedAt: new Date().toISOString() }).catch(() => undefined);
    log('warn', 'FTP 補漏失敗', { id: job.id, day: job.day, error: errText(e) });
  }
}

/** 背景迴圈:每 intervalMs 看一次佇列,一次做一個 */
export async function backfillLoop(deps: { ch: ClickHouseWriter; ftp: Ftp; queue: BackfillQueue; log: Log; signal: AbortSignal; intervalMs?: number }): Promise<void> {
  const wait = (ms: number) => new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    deps.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });
  while (!deps.signal.aborted) {
    let job: BackfillJob | null = null;
    try {
      job = await deps.queue.take();
    } catch {
      // Redis 斷線:主迴圈會記錄,這裡只等下一輪
    }
    if (job) await runBackfill(job, deps);
    else await wait(deps.intervalMs ?? 10_000);
  }
}
