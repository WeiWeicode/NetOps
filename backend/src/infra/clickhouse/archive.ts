/**
 * 冷資料 Parquet 歸檔(C4;ARCHITECTURE D30、D35,手冊 docs/PA-LOG-CLICKHOUSE-GUIDE.md §8)。
 *   - 歸檔原始 log(X1 = A):每天一個檔 pa_traffic_YYYY-MM-DD.parquet、pa_threat_YYYY-MM-DD.parquet,放在 pa-archive/YYYY/
 *   - IP 欄位轉成文字(IPv4 去掉 ::ffff:;其他工具也能讀,C1 報告 §3.2),讀回時(coldSource)再轉回 IPv6、時間轉回台灣時區,
 *     所以冷查詢和熱查詢共用同一份條件與欄位運算式(heat.ts runSlice)
 *   - 路徑只由 ARCHIVE_KINDS 常數與驗證過的日期組成(file() 的路徑不接受外部字串);相對 ClickHouse 的 user_files(唯讀掛 archive/)
 *   - 歸檔狀態記在 netops.pa_archive_manifest(migrations/004;ReplacingMergeTree,查詢用 FINAL)
 * 寫入端(匯出、來源筆數、manifest 寫入)用 netops_writer;讀 Parquet(file())只有 netops_cold 可以(netops_reader 沒有 READ ON FILE)。
 */
import { ClickHouseError, clickHouseBase, connectError, responseError, type ClickHouseConfig } from './index.js';
import { paramText } from './reader.js';

export const ARCHIVE_KINDS = {
  traffic: { source: 'netops.pa_traffic_logs', file: 'pa_traffic', times: ['event_time', 'session_start'] },
  threat: { source: 'netops.pa_threat_logs', file: 'pa_threat', times: ['event_time'] },
} as const;
export type ArchiveKind = keyof typeof ARCHIVE_KINDS;
export const ARCHIVE_KIND_LIST = Object.keys(ARCHIVE_KINDS) as ArchiveKind[];
export const MANIFEST_TABLE = 'netops.pa_archive_manifest';
/** ClickHouse user_files 底下的掛載目錄(唯讀) */
export const USER_FILES_DIR = 'archive';
const IP_COLS = ['src', 'dst', 'nat_src', 'nat_dst'] as const;

export type ArchiveStatus = 'ok' | 'failed' | 'expired';
export interface ManifestEntry {
  day: string;
  kind: ArchiveKind;
  status: ArchiveStatus;
  rows: number;
  bytes: number;
  sha256: string;
  /** 相對 pa-archive 的路徑(YYYY/檔名),不含主機路徑 */
  path: string;
  error: string;
  /** UTC 毫秒 */
  updatedAt: number;
}

const DAY_MS = 86_400_000;
const TZ_MS = 8 * 3600_000;

/** YYYY-MM-DD 且是真的日期(防止 ../ 等字串進路徑) */
export function isDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}
function mustDay(day: string): string {
  if (!isDay(day)) throw new Error(`日期格式錯誤:${day.slice(0, 20)}`);
  return day;
}
/** 台灣時間的日期 */
export const taipeiDay = (ms: number): string => new Date(ms + TZ_MS).toISOString().slice(0, 10);
/** 台灣日 00:00(UTC 毫秒) */
export const dayStartMs = (day: string): number => Date.parse(`${mustDay(day)}T00:00:00+08:00`);
/** day 加減天數 */
export const addDays = (day: string, n: number): string => taipeiDay(dayStartMs(day) + n * DAY_MS);
/** [fromMs, toMs) 涵蓋的台灣日(由舊到新) */
export function daysCovering(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  for (let d = taipeiDay(fromMs); dayStartMs(d) < toMs; d = addDays(d, 1)) out.push(d);
  return out;
}

export const archiveFileName = (kind: ArchiveKind, day: string): string => `${ARCHIVE_KINDS[kind].file}_${mustDay(day)}.parquet`;
/** 相對 pa-archive 的路徑:YYYY/pa_traffic_YYYY-MM-DD.parquet */
export const archiveRelPath = (kind: ArchiveKind, day: string): string => `${day.slice(0, 4)}/${archiveFileName(kind, day)}`;
/** 解析歸檔目錄裡的檔名(保留期限清理用);不是本系統的檔名回 null */
export function parseArchiveName(name: string): { kind: ArchiveKind; day: string; ext: '' | '.sha256' | '.tmp' } | null {
  const m = /^pa_(traffic|threat)_(\d{4}-\d{2}-\d{2})\.parquet(\.sha256|\.tmp)?$/.exec(name);
  if (!m || !isDay(m[2]!)) return null;
  return { kind: m[1] as ArchiveKind, day: m[2]!, ext: (m[3] ?? '') as '' | '.sha256' | '.tmp' };
}

/** IP → 文字(歸檔時;:: 保留 ::,讀回時 toIPv6 還原) */
const ipOut = (c: string) => `replaceRegexpOne(toString(${c}), '^::ffff:', '') AS ${c}`;
/** 匯出 SQL:一天([from, to) Unix 秒,參數);不排序(全量排序吃記憶體,Parquet 不需要) */
export function exportSql(kind: ArchiveKind): string {
  const k = ARCHIVE_KINDS[kind];
  return `SELECT * EXCEPT (${IP_COLS.join(', ')}), ${IP_COLS.map(ipOut).join(', ')} FROM ${k.source}
          WHERE event_time >= toDateTime({from:UInt32}) AND event_time < toDateTime({to:UInt32})`;
}

/**
 * 冷查詢的資料來源(子查詢):讀回 Parquet,IP 轉回 IPv6、時間轉回台灣時區,欄位名稱和型別同原始表。
 * days 必須是驗證過的日期;路徑字串只由常數與日期組成
 */
export function coldSource(kind: ArchiveKind, days: readonly string[]): string {
  if (!days.length) throw new Error('沒有指定日期');
  const k = ARCHIVE_KINDS[kind];
  const replace = [...IP_COLS.map((c) => `toIPv6(${c}) AS ${c}`), ...k.times.map((c) => `toDateTime(${c}, 'Asia/Taipei') AS ${c}`)].join(', ');
  const one = (day: string) => `SELECT * REPLACE (${replace}) FROM file('${USER_FILES_DIR}/${archiveRelPath(kind, mustDay(day))}', 'Parquet')`;
  return `(${days.map(one).join(' UNION ALL ')})`;
}

const sec = (ms: number) => Math.floor(ms / 1000);
const num = (v: unknown) => Number(v ?? 0) || 0;

/** 共用的 HTTP 呼叫:參數用 param_*;回應全文 */
function client(cfg: ClickHouseConfig, fetchImpl: typeof fetch) {
  const base = clickHouseBase(cfg.url);
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const headers = { 'X-ClickHouse-User': cfg.user, 'X-ClickHouse-Key': cfg.password, 'Content-Type': 'text/plain; charset=utf-8' };
  const url = (settings: Record<string, string>, params: Record<string, string | number>) => {
    const u = new URL(base);
    u.pathname = '/';
    for (const [k, v] of Object.entries(settings)) u.searchParams.set(k, v);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, paramText(v));
    return u;
  };
  async function text(sql: string, params: Record<string, string | number> = {}, settings: Record<string, string> = {}, waitMs = timeoutMs): Promise<string> {
    let res: Response;
    let body: string;
    try {
      // redirect: 'error':轉址時 X-ClickHouse-Key 會被帶到別的主機,一律不跟隨
      res = await fetchImpl(url(settings, params), { method: 'POST', headers, body: sql, redirect: 'error', signal: AbortSignal.timeout(waitMs) });
      body = await res.text();
    } catch (e) {
      throw connectError(e, waitMs);
    }
    if (!res.ok) throw responseError(res, body);
    return body;
  }
  const json = async <T>(sql: string, params: Record<string, string | number> = {}, settings: Record<string, string> = {}): Promise<T[]> => {
    const t = await text(`${sql} FORMAT JSONEachRow`, params, { output_format_json_quote_64bit_integers: '0', ...settings });
    try {
      return t
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T);
    } catch {
      throw new ClickHouseError('ClickHouse 查詢中斷', Number(/Code: (\d+)/.exec(t)?.[1]) || undefined, 200);
    }
  };
  return { base, headers, url, text, json };
}

/** 讀 manifest 的最新狀態(FINAL);netops_writer / netops_cold 都有 SELECT */
async function readManifest(c: ReturnType<typeof client>, days: readonly string[]): Promise<ManifestEntry[]> {
  if (!days.length) return [];
  type R = { day: string; table_name: string; status: string; rows: number; bytes: number; sha256: string; path: string; error: string; t: number };
  const rows = await c.json<R>(
    `SELECT toString(day) AS day, table_name, status, rows, bytes, sha256, path, error, toUnixTimestamp64Milli(updated_at) AS t
     FROM ${MANIFEST_TABLE} FINAL WHERE day IN {days:Array(Date)}`,
    { days: `[${days.map((d) => `'${mustDay(d)}'`).join(',')}]` },
  );
  return rows
    .filter((r) => (ARCHIVE_KIND_LIST as string[]).includes(r.table_name))
    .map((r) => ({ day: r.day, kind: r.table_name as ArchiveKind, status: r.status as ArchiveStatus, rows: num(r.rows), bytes: num(r.bytes), sha256: r.sha256, path: r.path, error: r.error, updatedAt: num(r.t) }));
}

export interface ArchiveWriterClient {
  /** 匯出一天的 Parquet(串流);呼叫端負責讀完。HTTP 200 之後的中途錯誤只會讓檔案截斷 → 由讀回列數核對發現 */
  exportParquet(kind: ArchiveKind, day: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  /** 一天的原始列數 */
  countDay(kind: ArchiveKind, day: string): Promise<number>;
  /** 期間內每天的原始列數(歸檔後有補漏 / 去重時重新歸檔) */
  countDays(kind: ArchiveKind, fromDay: string, toDay: string): Promise<Map<string, number>>;
  manifest(days: readonly string[]): Promise<ManifestEntry[]>;
  writeManifest(entries: readonly ManifestEntry[]): Promise<void>;
}

/** 匯出一天的上限:一天約 1,000 萬筆、單執行緒約 30–60 秒(C1 報告 §3.2);NAS 慢時留餘裕 */
export const EXPORT_MAX_SECONDS = 900;

export function createArchiveWriterClient(cfg: ClickHouseConfig, fetchImpl: typeof fetch = fetch): ArchiveWriterClient {
  const c = client(cfg, fetchImpl);
  const range = (day: string) => ({ from: sec(dayStartMs(day)), to: sec(dayStartMs(day) + DAY_MS) });
  return {
    async exportParquet(kind, day, signal) {
      const settings = {
        max_threads: '1',
        max_execution_time: String(EXPORT_MAX_SECONDS),
        output_format_parquet_compression_method: 'zstd',
        // row group 小一點:ClickHouse 寫 Parquet 時整個 row group 放在記憶體(預設 100 萬列,C1 實測匯出 407 MiB)
        output_format_parquet_row_group_size: '100000',
        output_format_parquet_row_group_size_bytes: String(64 * 1024 * 1024),
      };
      let res: Response;
      try {
        res = await fetchImpl(c.url(settings, range(day)), {
          method: 'POST',
          headers: c.headers,
          body: `${exportSql(kind)} FORMAT Parquet`,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout((EXPORT_MAX_SECONDS + 60) * 1000)]),
        });
      } catch (e) {
        throw connectError(e, (EXPORT_MAX_SECONDS + 60) * 1000);
      }
      if (!res.ok || !res.body) throw responseError(res, await res.text().catch(() => ''));
      return res.body;
    },
    async countDay(kind, day) {
      const r = await c.json<{ n: number }>(`SELECT count() AS n FROM ${ARCHIVE_KINDS[kind].source} WHERE event_time >= toDateTime({from:UInt32}) AND event_time < toDateTime({to:UInt32})`, range(day));
      return num(r[0]?.n);
    },
    async countDays(kind, fromDay, toDay) {
      const r = await c.json<{ d: string; n: number }>(
        `SELECT toString(toDate(event_time)) AS d, count() AS n FROM ${ARCHIVE_KINDS[kind].source}
         WHERE event_time >= toDateTime({from:UInt32}) AND event_time < toDateTime({to:UInt32}) GROUP BY d`,
        { from: sec(dayStartMs(fromDay)), to: sec(dayStartMs(toDay) + DAY_MS) },
      );
      return new Map(r.map((x) => [x.d, num(x.n)]));
    },
    manifest: (days) => readManifest(c, days),
    async writeManifest(entries) {
      if (!entries.length) return;
      const lines = entries.map((e) =>
        JSON.stringify({
          day: mustDay(e.day),
          table_name: e.kind,
          status: e.status,
          rows: e.rows,
          bytes: e.bytes,
          sha256: e.sha256,
          path: e.path,
          error: e.error.slice(0, 500),
          updated_at: new Date(e.updatedAt).toISOString(),
        }),
      );
      await c.text(`INSERT INTO ${MANIFEST_TABLE} FORMAT JSONEachRow\n${lines.join('\n')}`, {}, { async_insert: '0', wait_end_of_query: '1', date_time_input_format: 'best_effort', input_format_skip_unknown_fields: '0' });
    },
  };
}

export interface ColdFileClient {
  /** Parquet 檔的列數(ClickHouse 從唯讀掛載讀;壞檔會解析失敗)。relPath 預設是正式檔名,歸檔時先核對 .tmp */
  parquetCount(kind: ArchiveKind, day: string, tmp?: boolean): Promise<number>;
  manifest(days: readonly string[]): Promise<ManifestEntry[]>;
  /** 唯讀查詢(冷明細,heat.ts runSlice 用);maxSeconds ≤ 50(netops_cold constraints) */
  rows<T>(sql: string, params: Record<string, string | number>, maxSeconds: number, signal?: AbortSignal): Promise<T[]>;
}

/** netops_cold:讀 user_files/archive 的 Parquet */
export function createColdFileClient(cfg: ClickHouseConfig, fetchImpl: typeof fetch = fetch): ColdFileClient {
  const c = client(cfg, fetchImpl);
  return {
    async parquetCount(kind, day, tmp = false) {
      const p = `${USER_FILES_DIR}/${archiveRelPath(kind, day)}${tmp ? '.tmp' : ''}`;
      const r = await c.json<{ n: number }>(`SELECT count() AS n FROM file('${p}', 'Parquet')`, {}, { max_execution_time: '50' });
      return num(r[0]?.n);
    },
    manifest: (days) => readManifest(c, days),
    async rows<T>(sql: string, params: Record<string, string | number>, maxSeconds: number, signal?: AbortSignal) {
      const secs = Math.min(Math.max(Math.floor(maxSeconds), 1), 50);
      const waitMs = (secs + 10) * 1000;
      const u = c.url({ max_execution_time: String(secs), output_format_json_quote_64bit_integers: '0', cancel_http_readonly_queries_on_client_close: '1' }, params);
      let res: Response;
      let t: string;
      try {
        const timeout = AbortSignal.timeout(waitMs);
        res = await fetchImpl(u, { method: 'POST', headers: c.headers, body: `${sql} FORMAT JSONEachRow`, redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
        t = await res.text();
      } catch (e) {
        throw connectError(e, waitMs);
      }
      if (!res.ok) throw responseError(res, t);
      try {
        return t
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as T);
      } catch {
        throw new ClickHouseError('ClickHouse 查詢中斷', Number(/Code: (\d+)/.exec(t)?.[1]) || undefined, 200);
      }
    },
  };
}
