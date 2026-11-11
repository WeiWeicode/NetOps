/**
 * netops-api 的 ClickHouse 唯讀查詢(C3;ARCHITECTURE D29、手冊 docs/PA-LOG-CLICKHOUSE-GUIDE.md §7.4、§10.2)。
 *   - 帳號 netops_reader(readonly=2;max_execution_time ≤ 50、max_memory_usage ≤ 500 MB、max_result_rows ≤ 100000 由 users.d constraints 固定)
 *   - 表名只用 READ_TABLES 常數;查詢條件一律 query_params(param_*),不拼接字串
 *   - 只提供具名函式;模組不能送任意 SQL(AGENT.md §7.2)
 *   - 原始 log 一次讀一小時以內,依每分鐘筆數切段,每段 ≤ SLICE_ROWS(不超過 max_result_rows)
 *
 * 時間參數一律 Unix 秒;欄位是 DateTime('Asia/Taipei'),回傳的小時也是 Unix 秒(呼叫端換成台灣時間的鍵)。
 */
import { ClickHouseError, clickHouseBase, connectError, responseError, type ClickHouseConfig } from './index.js';

/** 唯讀查詢用到的表(不接受外部字串) */
export const READ_TABLES = {
  traffic: 'netops.pa_traffic_logs',
  threat: 'netops.pa_threat_logs',
  hourlyApp: 'netops.pa_traffic_hourly_app',
} as const;

/** 存進 ClickHouse 的威脅類 log(其他類型仍只有 FTP;AGENT.md §7.2) */
export const CH_EVENT_TYPES = ['threat', 'url', 'data', 'wildfire'] as const;
export type ChEventType = (typeof CH_EVENT_TYPES)[number];
export const isChEventType = (t: string): t is ChEventType => (CH_EVENT_TYPES as readonly string[]).includes(t);

/** 原始 log 一段最多幾筆(netops_reader 的 max_result_rows 是 100000) */
export const SLICE_ROWS = 80_000;
/** netops_reader 的 max_result_rows(users.d/profiles.xml) */
const MAX_RESULT_ROWS = 100_000;

/** IPv6 欄位 → 舊版畫面的字串(IPv4 去掉 ::ffff:;空位址 :: 為空字串) */
const ipText = (col: string) => `if(${col} = toIPv6('::'), '', replaceRegexpOne(toString(${col}), '^::ffff:', ''))`;
const timeText = (col: string) => `formatDateTime(${col}, '%Y/%m/%d %H:%i:%S')`;

/**
 * 原始 log → 核心(core/palog.js、core/paevents.js)的紀錄欄位;欄位名稱同 FTP CSV 的對應(COLUMNS),
 * 所以 FTP 與 ClickHouse 用同一份摘要邏輯(createSummary / createEventSummary)。
 */
const TRAFFIC_FIELDS: [string, string][] = [
  ['time', timeText('event_time')],
  ['subtype', 'subtype'],
  ['src', ipText('src')],
  ['dst', ipText('dst')],
  ['natSrc', ipText('nat_src')],
  ['natDst', ipText('nat_dst')],
  ['rule', 'rule'],
  ['srcUser', 'src_user'],
  ['app', 'app'],
  ['fromZone', 'from_zone'],
  ['toZone', 'to_zone'],
  ['inIf', 'in_if'],
  ['outIf', 'out_if'],
  ['sport', 'sport'],
  ['dport', 'dport'],
  ['natDport', 'nat_dport'],
  ['proto', 'proto'],
  ['action', 'action'],
  ['bytes', 'bytes'],
  ['sent', 'bytes_sent'],
  ['recv', 'bytes_recv'],
  ['packets', 'packets'],
  ['start', `if(toUnixTimestamp(session_start) = 0, '', ${timeText('session_start')})`],
  ['elapsed', 'elapsed'],
  ['category', 'category'],
  ['srcCountry', 'src_country'],
  ['dstCountry', 'dst_country'],
  ['endReason', 'end_reason'],
  ['appRisk', 'app_risk'],
  ['appCategory', 'app_category'],
  ['appSubcat', 'app_subcat'],
  ['appTech', 'app_tech'],
  ['srcHost', 'src_host'],
  ['dstHost', 'dst_host'],
];

const THREAT_FIELDS: [string, string][] = [
  ['time', timeText('event_time')],
  ['subtype', 'subtype'],
  ['src', ipText('src')],
  ['dst', ipText('dst')],
  ['natSrc', ipText('nat_src')],
  ['natDst', ipText('nat_dst')],
  ['rule', 'rule'],
  ['srcUser', 'src_user'],
  ['app', 'app'],
  ['fromZone', 'from_zone'],
  ['toZone', 'to_zone'],
  ['dport', 'dport'],
  ['proto', 'proto'],
  ['action', 'action'],
  ['url', 'url'],
  ['name', 'name'],
  ['category', 'category'],
  ['severity', 'severity'],
  ['direction', 'direction'],
  ['srcCountry', 'src_country'],
  ['dstCountry', 'dst_country'],
  ['repeat', 'repeat_count'],
  ['thrCategory', 'thr_category'],
  ['filedigest', 'file_digest'],
  ['filetype', 'file_type'],
];

export type LogRecord = Record<string, string | number>;

/** pa_traffic_hourly_app 依小時、動作的合計 */
export interface TrafficHourRow {
  /** 小時開始(UTC 毫秒) */
  hour: number;
  action: string;
  n: number;
  bytes: number;
}

export interface ClickHouseReader {
  /** 連線與帳密是否可用 */
  ping(): Promise<void>;
  /** 每小時彙總依小時與動作的合計(期間 [fromMs, toMs)) */
  trafficHours(fromMs: number, toMs: number, signal?: AbortSignal): Promise<TrafficHourRow[]>;
  /** 明細查詢的下拉選項:期間內的 App(依次數前 limit 名)、區域、動作(來自每小時彙總) */
  trafficOptions(fromMs: number, toMs: number, limit: number): Promise<{ apps: string[]; zones: string[]; actions: string[] }>;
  /** 每小時彙總最早的小時(UTC 毫秒);沒有資料為 null */
  earliestTrafficHour(signal?: AbortSignal): Promise<number | null>;
  /** 威脅類每小時筆數(原始列數,不乘 Repeat Count) */
  threatHourCounts(fromMs: number, toMs: number, signal?: AbortSignal): Promise<{ type: ChEventType; hour: number; n: number }[]>;
  /** 逐列讀取期間內的 TRAFFIC 原始 log(核心紀錄格式);回傳筆數 */
  trafficRecords(fromMs: number, toMs: number, onRow: (r: LogRecord) => void, signal?: AbortSignal): Promise<number>;
  /** 逐列讀取期間內某類型的威脅類原始 log */
  threatRecords(type: ChEventType, fromMs: number, toMs: number, onRow: (r: LogRecord) => void, signal?: AbortSignal): Promise<number>;
}

type Fetch = typeof fetch;
type Param = string | number;

/** 字串參數:ClickHouse 以跳脫字元解析 param_*(反斜線、tab、換行要跳脫) */
const paramText = (v: Param) => (typeof v === 'number' ? String(v) : v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r'));
const sec = (ms: number) => Math.floor(ms / 1000);

export interface ReaderOptions {
  /** 一般查詢的伺服器端執行上限(秒;≤ 50,constraints 固定上限) */
  maxSeconds?: number;
}

export function createClickHouseReader(cfg: ClickHouseConfig, fetchImpl: Fetch = fetch, opts: ReaderOptions = {}): ClickHouseReader {
  const base = clickHouseBase(cfg.url);
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const maxSeconds = Math.min(opts.maxSeconds ?? 25, 50);
  const headers = { 'X-ClickHouse-User': cfg.user, 'X-ClickHouse-Key': cfg.password, 'Content-Type': 'text/plain; charset=utf-8' };

  async function request(sql: string, params: Record<string, Param>, signal?: AbortSignal): Promise<Response> {
    const u = new URL(base);
    u.pathname = '/';
    for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, paramText(v));
    u.searchParams.set('max_execution_time', String(maxSeconds));
    // UInt64(筆數、位元組)以數字輸出;實際值遠小於 2^53
    u.searchParams.set('output_format_json_quote_64bit_integers', '0');
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      // redirect: 'error':轉址時 X-ClickHouse-Key 會被帶到別的主機,一律不跟隨
      const res = await fetchImpl(u, { method: 'POST', headers, body: sql, redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      if (!res.ok) throw responseError(res, await res.text());
      return res;
    } catch (e) {
      if (e instanceof ClickHouseError) throw e;
      throw connectError(e, timeoutMs);
    }
  }

  /** 小結果:JSONEachRow 一次讀完 */
  async function rows<T>(sql: string, params: Record<string, Param> = {}, signal?: AbortSignal): Promise<T[]> {
    const res = await request(`${sql} FORMAT JSONEachRow`, params, signal);
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw connectError(e, timeoutMs);
    }
    try {
      return parseLines(text).map((l) => JSON.parse(l) as T);
    } catch {
      // HTTP 200 之後的中途錯誤:不把錯誤原文帶出去(資安審查 L2:可能含 log 內容)
      throw new ClickHouseError('ClickHouse 查詢中斷', Number(/Code: (\d+)/.exec(text)?.[1]) || undefined, 200);
    }
  }

  /** 大結果:逐行讀取(JSONCompactEachRow),中途的錯誤(HTTP 已回 200)以「無法解析的行」偵測;每個資料塊之後讓出事件迴圈 */
  async function stream(sql: string, params: Record<string, Param>, onLine: (cols: unknown[]) => void, signal?: AbortSignal): Promise<number> {
    const res = await request(`${sql} FORMAT JSONCompactEachRow`, params, signal);
    if (!res.body) throw new ClickHouseError('ClickHouse 回應沒有內容', undefined, res.status);
    const decoder = new TextDecoder();
    let buf = '';
    let n = 0;
    const take = (line: string) => {
      if (!line) return;
      let cols: unknown;
      try {
        cols = JSON.parse(line);
      } catch {
        throw new ClickHouseError('ClickHouse 查詢中斷', Number(/Code: (\d+)/.exec(line)?.[1]) || undefined, 200);
      }
      if (!Array.isArray(cols)) throw new ClickHouseError('ClickHouse 回應格式不符', undefined, 200);
      onLine(cols);
      n++;
    };
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          take(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
        await new Promise((r) => setImmediate(r));
      }
      take(buf + decoder.decode());
    } catch (e) {
      if (e instanceof ClickHouseError) throw e;
      throw connectError(e, timeoutMs);
    }
    return n;
  }

  /**
   * 期間內的筆數分布 → 切成每段 ≤ SLICE_ROWS 的時間段 [from, to);expected = 期間內的總筆數(讀完核對用)。
   * 先看每分鐘;單一分鐘就超過 SLICE_ROWS(大量掃描、DoS 經過防火牆)時,那一分鐘改看每秒(資安審查 M1)。
   * 單一秒就超過帳號的 max_result_rows 時無法切段,丟出錯誤(該小時記失敗,其他小時照建)
   */
  async function slices(table: 'traffic' | 'threat', fromMs: number, toMs: number, type?: ChEventType, signal?: AbortSignal): Promise<{ parts: [number, number][]; expected: number }> {
    const cond = type ? 'AND log_type = {type:String}' : '';
    const t: Record<string, Param> = type ? { type } : {};
    const count = (unit: 'toStartOfMinute' | 'toStartOfSecond', a: number, b: number) =>
      rows<{ m: number; n: number }>(
        `SELECT toUnixTimestamp(${unit === 'toStartOfMinute' ? 'toStartOfMinute(event_time)' : 'event_time'}) AS m, count() AS n FROM ${READ_TABLES[table]}
         WHERE event_time >= toDateTime({from:UInt32}) AND event_time < toDateTime({to:UInt32}) ${cond} GROUP BY m ORDER BY m`,
        { from: sec(a), to: sec(b), ...t },
        signal,
      );
    const units: { ms: number; n: number }[] = [];
    for (const { m, n } of await count('toStartOfMinute', fromMs, toMs)) {
      const ms = m * 1000;
      if (n <= SLICE_ROWS) units.push({ ms, n });
      else for (const x of await count('toStartOfSecond', Math.max(ms, fromMs), Math.min(ms + 60_000, toMs))) units.push({ ms: x.m * 1000, n: x.n });
    }
    const parts: [number, number][] = [];
    let start = -1;
    let acc = 0;
    let expected = 0;
    for (const { ms, n } of units) {
      if (n > MAX_RESULT_ROWS) throw new ClickHouseError(`單一秒超過 ${MAX_RESULT_ROWS} 筆,無法分段讀取`, undefined, undefined);
      expected += n;
      if (start >= 0 && acc + n > SLICE_ROWS) {
        parts.push([start, ms]);
        start = -1;
        acc = 0;
      }
      // 第一段可能早於 fromMs(fromMs 不在整分):段落不能超出期間
      if (start < 0) start = Math.max(ms, fromMs);
      acc += n;
    }
    if (start >= 0) parts.push([start, toMs]);
    return { parts, expected };
  }

  async function records(table: 'traffic' | 'threat', fields: [string, string][], fromMs: number, toMs: number, onRow: (r: LogRecord) => void, signal?: AbortSignal, type?: ChEventType) {
    const select = fields.map(([, expr]) => expr).join(', ');
    const names = fields.map(([k]) => k);
    const cond = type ? 'AND log_type = {type:String}' : '';
    const { parts, expected } = await slices(table, fromMs, toMs, type, signal);
    let total = 0;
    for (const [a, b] of parts) {
      if (signal?.aborted) throw connectError(Object.assign(new Error('aborted'), { name: 'AbortError' }), timeoutMs);
      total += await stream(
        `SELECT ${select} FROM ${READ_TABLES[table]} WHERE event_time >= toDateTime({from:UInt32}) AND event_time < toDateTime({to:UInt32}) ${cond}`,
        { from: sec(a), to: sec(b), ...(type ? { type } : {}) },
        (cols) => {
          const r: LogRecord = {};
          for (let i = 0; i < names.length; i++) r[names[i]!] = cols[i] as string | number;
          onRow(r);
        },
        signal,
      );
    }
    // 讀到的比分段時算的少:連線在行邊界被截斷等,不能當成完整(晚到的資料只會讓筆數變多)
    if (total < expected) throw new ClickHouseError(`ClickHouse 原始 log 讀取不完整(${total} / ${expected})`, undefined, undefined);
    return total;
  }

  const range = (fromMs: number, toMs: number) => ({ from: sec(fromMs), to: sec(toMs) });

  return {
    async ping() {
      const r = await rows<{ x: number }>('SELECT 1 AS x');
      if (r[0]?.x !== 1) throw new ClickHouseError('ClickHouse ping 回應不符', undefined, undefined);
    },
    async trafficHours(fromMs, toMs, signal) {
      const r = await rows<{ h: number; action: string; n: number; b: number }>(
        `SELECT toUnixTimestamp(hour) AS h, action, sum(sessions) AS n, sum(bytes) AS b FROM ${READ_TABLES.hourlyApp}
         WHERE hour >= toDateTime({from:UInt32}) AND hour < toDateTime({to:UInt32}) GROUP BY h, action ORDER BY h, action`,
        range(fromMs, toMs),
        signal,
      );
      return r.map((x) => ({ hour: x.h * 1000, action: x.action, n: Number(x.n), bytes: Number(x.b) }));
    },
    async trafficOptions(fromMs, toMs, limit) {
      const p = { ...range(fromMs, toMs), lim: limit };
      const where = 'hour >= toDateTime({from:UInt32}) AND hour < toDateTime({to:UInt32})';
      const [apps, zones, actions] = await Promise.all([
        rows<{ app: string }>(`SELECT app FROM ${READ_TABLES.hourlyApp} WHERE ${where} AND app != '' GROUP BY app ORDER BY sum(sessions) DESC, app LIMIT {lim:UInt16}`, p),
        rows<{ z: string }>(`SELECT DISTINCT arrayJoin([from_zone, to_zone]) AS z FROM ${READ_TABLES.hourlyApp} WHERE ${where} ORDER BY z LIMIT {lim:UInt16}`, p),
        rows<{ action: string }>(`SELECT DISTINCT action FROM ${READ_TABLES.hourlyApp} WHERE ${where} ORDER BY action`, p),
      ]);
      return { apps: apps.map((x) => x.app), zones: zones.map((x) => x.z).filter((z) => z && z !== '?'), actions: actions.map((x) => x.action || '(空白)') };
    },
    async earliestTrafficHour(signal) {
      const r = await rows<{ h: number }>(`SELECT toUnixTimestamp(min(hour)) AS h FROM ${READ_TABLES.hourlyApp}`, {}, signal);
      const h = Number(r[0]?.h ?? 0);
      return h > 0 ? h * 1000 : null;
    },
    async threatHourCounts(fromMs, toMs, signal) {
      const r = await rows<{ t: string; h: number; n: number }>(
        `SELECT log_type AS t, toUnixTimestamp(toStartOfHour(event_time)) AS h, count() AS n FROM ${READ_TABLES.threat}
         WHERE event_time >= toDateTime({from:UInt32}) AND event_time < toDateTime({to:UInt32}) GROUP BY t, h ORDER BY t, h`,
        range(fromMs, toMs),
        signal,
      );
      return r.filter((x) => isChEventType(x.t)).map((x) => ({ type: x.t as ChEventType, hour: x.h * 1000, n: Number(x.n) }));
    },
    trafficRecords: (fromMs, toMs, onRow, signal) => records('traffic', TRAFFIC_FIELDS, fromMs, toMs, onRow, signal),
    threatRecords: (type, fromMs, toMs, onRow, signal) => records('threat', THREAT_FIELDS, fromMs, toMs, onRow, signal, type),
  };
}

const parseLines = (text: string) => text.split('\n').filter((l) => l.trim());
