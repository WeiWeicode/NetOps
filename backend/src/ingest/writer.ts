/**
 * netops-ingest 核心:Redis Stream(consumer group ch-writer)→ ClickHouse 批次寫入(C2;手冊 §6.1、§6.6;ARCHITECTURE D28)。
 *
 * 至少一次 + 去重:
 * - 每 batchMs(預設 5 秒)或任一類型湊滿 batchMax 筆、或這輪讀到的資料超過 MAX_BATCH_BYTES 就寫一批;ClickHouse 成功才 XACK。
 * - 重啟時先處理待處理清單(已送達、未 ACK = 上次寫到一半的那一批),**單獨成批、不混新資料**,
 *   所以批次內容和當機前相同,去重 token(類型 + 第一筆與最後一筆 ID + 筆數)也相同,ClickHouse 會略過已寫過的那批
 *   (表設 non_replicated_deduplication_window;被略過的批次也不會再進每小時彙總的物化檢視)。
 * - 一批每種類型最多 batchMax 筆(每次讀取的 COUNT 不超過剩餘空間),待處理清單一次讀 batchMax 筆,兩邊的切法一致。
 *
 * 失敗處理:
 * - 暫時性錯誤(連線、逾時、記憶體、Too many parts)與**結構性錯誤**(欄位或表對不上、帳密權限):不 ACK,退避重試(1、2、4…60 秒),
 *   期間不讀新資料;Stream 還在就不會掉(TRAFFIC 約 1 小時,CQ13),超過就由缺口偵測記下、交給 FTP 補漏(C3)。
 * - 資料錯誤:對半拆批找出壞列,壞列計數(rejected)後丟棄。熔斷:拆批時前 SCHEMA_SUSPECT_REJECTS 個葉子全被拒、
 *   而且沒有任何子批成功,視為結構性問題(每一列都壞),整批改走重試、不 ACK(程式碼審查 #1)。
 * - 無法分類的 HTTP 400:整批連續失敗 UNKNOWN_SPLIT_AFTER 次後才拆批(資安審查 M2),之後同上。
 * - 壞 JSON 或單筆超過 MAX_ENTRY_BYTES(malformed)、待處理條目已被修剪(trimmed):計數後 ACK。
 * 不過濾雜訊(CQ8)。所有計數寫進心跳(main.ts)。
 */
import { isDataError, isSchemaError, isUnknownBadRequest, type ClickHouseWriter, type TableKey } from '../infra/clickhouse/index.js';
import { INGEST_TYPES, type Gap, type IngestRedis, type IngestType, type RawEntry } from '../infra/redis/ingest.js';
import { idMs, toRow, type Row } from './rows.js';

export const COUNTERS = ['read', 'inserted', 'malformed', 'trimmed', 'rejected', 'badTime', 'batches'] as const;
export type Counter = (typeof COUNTERS)[number];

/** 單筆上限(bytes):收集器每個欄位已截斷,正常一筆 < 2 KB;超過視為異常(資安審查 M1) */
export const MAX_ENTRY_BYTES = 64 * 1024;
/** 一輪讀取累計上限(bytes,所有類型合計):超過就提早寫入,控制記憶體(容器 256m) */
export const MAX_BATCH_BYTES = 16 * 1024 * 1024;
/** 拆批時連續幾個單列被拒、而且沒有任何子批成功,就判定為結構性問題 */
export const SCHEMA_SUSPECT_REJECTS = 3;
/** 無法分類的 400 連續幾次後才拆批 */
export const UNKNOWN_SPLIT_AFTER = 5;

export interface WriterOptions {
  /** 一批最長等待時間(毫秒),預設 5000(IMPL-PLAN C2:3–5 秒) */
  batchMs: number;
  /** 每種類型一批最多幾筆,預設 5000 */
  batchMax: number;
  /** 寫入失敗的退避上限(毫秒) */
  maxBackoffMs: number;
}

export const DEFAULT_WRITER_OPTIONS: WriterOptions = { batchMs: 5_000, batchMax: 5_000, maxBackoffMs: 60_000 };

/** 心跳顯示用:去掉控制字元(含 C1)並截斷;ClickHouse 的解析錯誤會引用一小段 log 內容(資安審查 L2) */
export function sanitizeMessage(e: unknown): string {
  const raw = String((e as Error)?.message ?? e).split('\n', 1)[0] ?? '';
  return raw.replace(/\p{Cc}/gu, ' ').slice(0, 200);
}

/** 心跳要顯示的狀態;main.ts 讀取 */
export class WriterStatus {
  readonly counts = Object.fromEntries(INGEST_TYPES.map((t) => [t, Object.fromEntries(COUNTERS.map((c) => [c, 0]))])) as Record<IngestType, Record<Counter, number>>;
  /** 每種類型最後 ACK 的 Stream ID(落後時間 = 現在 − 這個 ID 的毫秒) */
  readonly lastAcked: Partial<Record<IngestType, string>> = {};
  /** 目前的缺口(下一次偵測沒有就清掉;歷史在 Redis 的缺口清單) */
  readonly gaps: Partial<Record<IngestType, Gap>> = {};
  lastInsertAt: string | null = null;
  /** 啟動檢查(ClickHouse 帳密、consumer group)通過 */
  ready = false;
  /** 連續寫入失敗次數(成功歸零) */
  failing = 0;
  /** 目前的失敗是結構性的(欄位、表、權限):需要人處理 */
  schemaError = false;
  insertFailures = 0;
  lastError: { at: string; where: string; message: string } | null = null;
  /** 主迴圈最後一次推進的時間(健康檢查用) */
  aliveAt = Date.now();

  add(t: IngestType, c: Counter, n = 1) {
    this.counts[t][c] += n;
  }
  fail(where: string, e: unknown) {
    this.lastError = { at: new Date().toISOString(), where, message: sanitizeMessage(e) };
  }
}

const TABLE: Record<IngestType, TableKey> = { traffic: 'traffic', threat: 'threat', url: 'threat', data: 'threat', wildfire: 'threat' };

/** 拆批後判定為結構性問題:整批改走重試(不 ACK) */
class SchemaSuspectError extends Error {
  constructor(source: unknown) {
    super(`拆批後每一列都被拒絕,視為欄位或表對不上:${sanitizeMessage(source)}`);
  }
}

export interface Sleep {
  (ms: number, signal: AbortSignal): Promise<void>;
}
export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

const entryBytes = (e: RawEntry) => (e.data === null ? 0 : e.data.length * 2); // V8 字串最壞每字 2 bytes

export class Writer {
  readonly status = new WriterStatus();
  private readonly opts: WriterOptions;
  /** 正在寫入(還沒 ACK)的批次第一筆 ID:ClickHouse 停太久、待處理條目被修剪時,這批還在記憶體裡,不算缺口 */
  private readonly inFlight: Partial<Record<IngestType, string>> = {};

  constructor(
    private readonly redis: IngestRedis,
    private readonly ch: ClickHouseWriter,
    opts: Partial<WriterOptions> = {},
    private readonly wait: Sleep = sleep,
    private readonly now: () => number = Date.now,
  ) {
    this.opts = { ...DEFAULT_WRITER_OPTIONS, ...opts };
  }

  /** 建立 consumer group,並做一次缺口偵測 */
  async init(): Promise<void> {
    for (const t of INGEST_TYPES) await this.redis.ensureGroup(t);
    await this.checkGaps();
    this.status.ready = true;
  }

  /** 缺口偵測:新的缺口(from 不同)才寫進缺口清單,同一個缺口只更新心跳;沒有缺口就清掉心跳上的舊值 */
  async checkGaps(): Promise<Gap[]> {
    const found: Gap[] = [];
    for (const t of INGEST_TYPES) {
      let g = await this.redis.detectGap(t);
      // 待處理條目被修剪,但那一批正在寫入(記憶體裡還有):寫成功就不會漏
      if (g?.kind === 'pending-trimmed' && this.inFlight[t] !== undefined && g.from === this.inFlight[t]) g = null;
      if (!g) {
        delete this.status.gaps[t];
        continue;
      }
      found.push(g);
      if (this.status.gaps[t]?.from !== g.from) await this.redis.pushGap({ ...g, detectedAt: new Date(this.now()).toISOString() });
      this.status.gaps[t] = g;
    }
    return found;
  }

  /** 重啟後先寫完待處理清單;每一批單獨寫入(不混新資料,去重 token 才會和當機前相同) */
  async drainPending(signal: AbortSignal): Promise<void> {
    for (const t of INGEST_TYPES) {
      let after = '0';
      while (!signal.aborted) {
        const entries = await this.redis.readPending(t, after, this.opts.batchMax);
        if (!entries.length) break;
        await this.flush(t, entries, signal);
        after = entries.at(-1)!.id;
      }
    }
  }

  /** 讀一輪(最多 batchMs)並寫入;回傳這輪讀到的筆數 */
  async cycle(signal: AbortSignal): Promise<number> {
    const buf = Object.fromEntries(INGEST_TYPES.map((t) => [t, [] as RawEntry[]])) as Record<IngestType, RawEntry[]>;
    const deadline = this.now() + this.opts.batchMs;
    let total = 0;
    let bytes = 0;
    while (!signal.aborted && bytes < MAX_BATCH_BYTES) {
      const remain = deadline - this.now();
      if (remain <= 0) break;
      const room = Math.min(...INGEST_TYPES.map((t) => this.opts.batchMax - buf[t].length));
      if (room <= 0) break;
      // BLOCK 最多 1 秒:讓停止訊號與批次期限及時生效
      const got = await this.redis.readNew(INGEST_TYPES, Math.min(1000, room), Math.max(1, Math.min(1000, remain)));
      this.status.aliveAt = this.now();
      for (const t of INGEST_TYPES) {
        const rows = got[t];
        if (rows?.length) {
          buf[t].push(...rows);
          total += rows.length;
          for (const e of rows) bytes += entryBytes(e);
        }
      }
    }
    // 停止時已讀到的仍寫完再 ACK(不寫也不會掉:未 ACK 的下次啟動從待處理清單補)
    for (const t of INGEST_TYPES) if (buf[t].length) await this.flush(t, buf[t], signal);
    return total;
  }

  /** 主迴圈:先補待處理,之後一直讀新的;signal 中止時寫完手上這批就結束 */
  async run(signal: AbortSignal): Promise<void> {
    await this.drainPending(signal);
    while (!signal.aborted) await this.cycle(signal);
  }

  /** 一批:轉成列 → 寫入(含重試與拆批)→ ACK */
  private async flush(t: IngestType, entries: RawEntry[], signal: AbortSignal): Promise<void> {
    const rows: Row[] = [];
    for (const e of entries) {
      this.status.add(t, 'read');
      if (e.data === null) {
        this.status.add(t, 'trimmed');
        continue;
      }
      const issues = { badTime: false };
      const row = e.data.length > MAX_ENTRY_BYTES ? null : toRow(t, e.data, idMs(e.id), issues);
      if (!row) {
        this.status.add(t, 'malformed');
        continue;
      }
      if (issues.badTime) this.status.add(t, 'badTime');
      rows.push(row);
    }
    const token = `${t}:${entries[0]!.id}:${entries.at(-1)!.id}:${entries.length}`;
    this.inFlight[t] = entries[0]!.id;
    try {
      const ok = await this.insertWithRetry(t, rows, token, signal);
      // 停止訊號中斷了重試:不 ACK,下次啟動從待處理清單重送(同一個 token)
      if (!ok) return;
      await this.ackWithRetry(t, entries.map((e) => e.id), signal);
    } finally {
      delete this.inFlight[t];
    }
  }

  /** 回傳 true = 已寫入(或壞列已計數);false = 停止訊號中斷 */
  private async insertWithRetry(t: IngestType, rows: Row[], token: string, signal: AbortSignal): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = { rejected: 0, inserted: 0 };
        await this.insertSplit(t, rows, token, attempt >= UNKNOWN_SPLIT_AFTER, res);
        // 計數只在整批完成後加:中途重試時,已寫過的子批由 token 去重,計數不會重複
        if (res.rejected) this.status.add(t, 'rejected', res.rejected);
        if (rows.length - res.rejected > 0) {
          this.status.add(t, 'inserted', rows.length - res.rejected);
          this.status.add(t, 'batches');
          this.status.lastInsertAt = new Date(this.now()).toISOString();
        }
        this.status.failing = 0;
        this.status.schemaError = false;
        return true;
      } catch (e) {
        this.status.failing++;
        this.status.insertFailures++;
        this.status.schemaError = e instanceof SchemaSuspectError || isSchemaError(e);
        this.status.fail(this.status.schemaError ? 'clickhouse-schema' : 'clickhouse', e);
        if (signal.aborted) return false;
        await this.wait(Math.min(this.opts.maxBackoffMs, 1_000 * 2 ** Math.min(attempt, 10)), signal);
        this.status.aliveAt = this.now();
        if (signal.aborted) return false;
      }
    }
  }

  /**
   * 資料錯誤時對半拆批(子批 token 加 :a / :b 與筆數,重送時切法相同);單列仍失敗就丟棄並計入 res.rejected。
   * 結構性、暫時性錯誤往上拋(整批重試);熔斷條件見檔頭。
   */
  private async insertSplit(t: IngestType, rows: Row[], token: string, splitUnknown: boolean, res: { rejected: number; inserted: number }): Promise<void> {
    if (!rows.length) return;
    try {
      await this.ch.insert(TABLE[t], rows, token);
      res.inserted += rows.length;
    } catch (e) {
      const splittable = isDataError(e) || (splitUnknown && isUnknownBadRequest(e));
      if (!splittable) throw e;
      if (rows.length === 1) {
        res.rejected++;
        this.status.fail('clickhouse-row', e);
        if (res.inserted === 0 && res.rejected >= SCHEMA_SUSPECT_REJECTS) throw new SchemaSuspectError(e);
        return;
      }
      const mid = Math.ceil(rows.length / 2);
      await this.insertSplit(t, rows.slice(0, mid), `${token}:a${mid}`, splitUnknown, res);
      await this.insertSplit(t, rows.slice(mid), `${token}:b${rows.length - mid}`, splitUnknown, res);
    }
  }

  /** ACK 失敗(Redis 暫時斷線)重試;停止時放棄(下次啟動重送,ClickHouse 以 token 去重) */
  private async ackWithRetry(t: IngestType, ids: string[], signal: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.redis.ack(t, ids);
        this.status.lastAcked[t] = ids.at(-1);
        return;
      } catch (e) {
        this.status.fail('redis', e);
        if (signal.aborted) return;
        await this.wait(Math.min(this.opts.maxBackoffMs, 1_000 * 2 ** Math.min(attempt, 10)), signal);
        if (signal.aborted) return;
      }
    }
  }
}

