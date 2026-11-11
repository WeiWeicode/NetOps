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
  /**
   * TRAFFIC 明細查詢(C3,工作模式內執行;docs/API.md §4.3):依時間由舊到新最多 limit 筆;more = 還有更多符合的。
   * scanned 為 ClickHouse 讀過的列數(X-ClickHouse-Summary;沒有時為 0)。maxSeconds ≤ 50(帳號 constraints)
   */
  searchTraffic(f: TrafficFilter, limit: number, maxSeconds: number, signal?: AbortSignal): Promise<{ rows: LogRecord[]; more: boolean; scanned: number }>;
  /** 期間內 TRAFFIC 每小時彙總的總筆數(明細查詢前判斷有沒有資料) */
  trafficCount(fromMs: number, toMs: number): Promise<number>;
}

/** 明細查詢條件(和 FTP 掃描 core/palog.js buildFilter 相同語意;時間為 UTC 毫秒,toMs 不含) */
export interface TrafficFilter {
  fromMs: number;
  toMs: number;
  src?: string;
  dst?: string;
  ip?: string;
  port?: string;
  proto?: string;
  app?: string;
  rule?: string;
  action?: string;
  fromZone?: string;
  toZone?: string;
  user?: string;
  country?: string;
  q?: string;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const isIPv6Text = (v: string) => v.includes(':') && /^[0-9a-fA-F:.]+$/.test(v);

/** q 比對的文字欄位(FTP 版比對整列 CSV;原始 log 不存整列) */
const TEXT_COLUMNS = [
  ipText('src'), ipText('dst'), ipText('nat_src'), ipText('nat_dst'), 'toString(sport)', 'toString(dport)', 'subtype', 'proto', 'rule', 'src_user', 'app',
  'from_zone', 'to_zone', 'action', 'category', 'src_country', 'dst_country', 'end_reason', 'src_host', 'dst_host',
];

/**
 * 明細條件 → SQL 條件與參數(純函式;值一律放參數,欄位名稱只來自程式內常數)。
 *   IP:完全相同(含 NAT 位址)、CIDR(IPv4 / IPv6,排序鍵友善的 BETWEEN)、萬用字元 *(LIKE,線性時間,沒有 ReDoS);
 *       不是合法 IP 也不是合法 CIDR 時同 FTP 版:CIDR 以字首比對、其他以字串完全相同比對
 *   其他欄位同 buildFilter:proto、區域完全相同不分大小寫;App、規則、使用者、國家包含;action allow / block / 原文
 */
export function trafficWhere(f: TrafficFilter): { where: string[]; params: Record<string, Param> } {
  const where = ['event_time >= toDateTime({from:UInt32})', 'event_time < toDateTime({to:UInt32})'];
  const params: Record<string, Param> = { from: sec(f.fromMs), to: Math.ceil(f.toMs / 1000) };
  let n = 0;
  const p = (v: Param, type: string) => {
    const k = `p${n++}`;
    params[k] = v;
    return `{${k}:${type}}`;
  };
  const ipOne = (col: string, pattern: string): string => {
    if (pattern.includes('/')) {
      const [base = '', bitsText = ''] = pattern.split('/');
      const bits = Number(bitsText);
      const v4 = IPV4.test(base) && /^\d{1,2}$/.test(bitsText) && bits <= 32;
      const v6 = isIPv6Text(base) && /^\d{1,3}$/.test(bitsText) && bits <= 128;
      if (v4 || v6) {
        const r = `IPv6CIDRToRange(toIPv6(${p(base, 'String')}), ${p(v4 ? bits + 96 : bits, 'UInt8')})`;
        return `${col} BETWEEN tupleElement(${r}, 1) AND tupleElement(${r}, 2)`;
      }
      return `startsWith(${ipText(col)}, ${p(base, 'String')})`;
    }
    if (pattern.includes('*')) return `${ipText(col)} LIKE ${p(pattern.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '%'), 'String')}`;
    if (IPV4.test(pattern) || isIPv6Text(pattern)) return `${col} = toIPv6OrNull(${p(pattern, 'String')})`;
    return `${ipText(col)} = ${p(pattern, 'String')}`;
  };
  const ipAny = (cols: [string, boolean][], pattern?: string) => {
    const v = String(pattern ?? '').trim();
    if (!v) return;
    // NAT 欄位空白(::)時不比對(同 FTP:r.natSrc && …)
    where.push(`(${cols.map(([c, nat]) => (nat ? `(${c} != toIPv6('::') AND ${ipOne(c, v)})` : ipOne(c, v))).join(' OR ')})`);
  };
  ipAny([['src', false], ['nat_src', true]], f.src);
  ipAny([['dst', false], ['nat_dst', true]], f.dst);
  ipAny([['src', false], ['dst', false], ['nat_src', true], ['nat_dst', true]], f.ip);
  const port = String(f.port ?? '').trim();
  if (port) {
    const ports = [...new Set(port.split(/[,\s]+/).filter(Boolean).map(Number))].filter((x) => Number.isInteger(x) && x >= 0 && x <= 65535);
    where.push(ports.length ? `dport IN ${p(`[${ports.join(',')}]`, 'Array(UInt16)')}` : '0');
  }
  const exact = (col: string, v?: string) => {
    const x = String(v ?? '').trim().toLowerCase();
    if (x) where.push(`lowerUTF8(${col}) = ${p(x, 'String')}`);
  };
  const contains = (cols: string[], v?: string) => {
    const x = String(v ?? '').trim();
    if (!x) return;
    const k = p(x, 'String');
    where.push(`(${cols.map((c) => `positionCaseInsensitiveUTF8(${c}, ${k}) > 0`).join(' OR ')})`);
  };
  exact('proto', f.proto);
  contains(['app'], f.app);
  contains(['rule'], f.rule);
  exact('from_zone', f.fromZone);
  exact('to_zone', f.toZone);
  contains(['src_user'], f.user);
  contains(['src_country', 'dst_country'], f.country);
  const action = String(f.action ?? '').trim();
  if (action === 'allow') where.push(`action = 'allow'`);
  else if (action === 'block') where.push(`action != 'allow'`);
  else if (action) where.push(`action = ${p(action, 'String')}`);
  contains([`concat(${TEXT_COLUMNS.join(", ',', ")})`], f.q);
  return { where, params };
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

  async function request(sql: string, params: Record<string, Param>, signal?: AbortSignal, settings: Record<string, string> = {}): Promise<Response> {
    const u = new URL(base);
    u.pathname = '/';
    for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, paramText(v));
    u.searchParams.set('max_execution_time', String(maxSeconds));
    for (const [k, v] of Object.entries(settings)) u.searchParams.set(k, v);
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
  async function stream(
    sql: string,
    params: Record<string, Param>,
    onLine: (cols: unknown[]) => void,
    signal?: AbortSignal,
    settings?: Record<string, string>,
    onResponse?: (res: Response) => void,
  ): Promise<number> {
    const res = await request(`${sql} FORMAT JSONCompactEachRow`, params, signal, settings);
    onResponse?.(res);
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
    async searchTraffic(f, limit, seconds, signal) {
      const { where, params } = trafficWhere(f);
      const names = TRAFFIC_FIELDS.map(([k]) => k);
      const out: LogRecord[] = [];
      let scanned = 0;
      await stream(
        `SELECT ${TRAFFIC_FIELDS.map(([, e]) => e).join(', ')} FROM ${READ_TABLES.traffic} WHERE ${where.join(' AND ')} ORDER BY event_time, src LIMIT {lim:UInt32}`,
        { ...params, lim: limit + 1 },
        (cols) => {
          const r: LogRecord = {};
          for (let i = 0; i < names.length; i++) r[names[i]!] = cols[i] as string | number;
          out.push(r);
        },
        signal,
        // 工作取消(HTTP 連線中斷)時 ClickHouse 也停止查詢
        { max_execution_time: String(Math.min(Math.max(Math.floor(seconds), 1), 50)), cancel_http_readonly_queries_on_client_close: '1' },
        (res) => {
          try {
            scanned = Number(JSON.parse(res.headers.get('x-clickhouse-summary') ?? '{}').read_rows) || 0;
          } catch {
            /* 沒有摘要標頭只是少了掃描筆數 */
          }
        },
      );
      const more = out.length > limit;
      return { rows: more ? out.slice(0, limit) : out, more, scanned };
    },
    async trafficCount(fromMs, toMs) {
      const r = await rows<{ n: number }>(
        `SELECT sum(sessions) AS n FROM ${READ_TABLES.hourlyApp} WHERE hour >= toStartOfHour(toDateTime({from:UInt32})) AND hour < toDateTime({to:UInt32})`,
        { from: sec(fromMs), to: Math.ceil(toMs / 1000) },
      );
      return Number(r[0]?.n ?? 0);
    },
    trafficRecords: (fromMs, toMs, onRow, signal) => records('traffic', TRAFFIC_FIELDS, fromMs, toMs, onRow, signal),
    threatRecords: (type, fromMs, toMs, onRow, signal) => records('threat', THREAT_FIELDS, fromMs, toMs, onRow, signal, type),
  };
}

const parseLines = (text: string) => text.split('\n').filter((l) => l.trim());
