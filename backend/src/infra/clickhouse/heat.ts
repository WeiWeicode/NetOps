/**
 * 熱力圖彙總與時段明細的唯讀查詢(V-a;docs/VIZ-RULES-DESIGN.md §3、§4.2、§4.3;帳號 netops_reader)。
 *   - 表名只用 HEAT_TABLES / READ_TABLES 常數;條件一律 query_params(AGENT.md §7.2)
 *   - 熱力圖只讀彙總表(pa_heat_5m / _1h / _1d);時段明細讀原始表,範圍最多 1 天(呼叫端檢查)
 *   - 時間參數一律 Unix 秒;回傳的時間是 UTC 毫秒
 * 和 reader.ts 分開:reader.ts 是 C3 的總覽 / 明細(既有服務不動),本檔只放 V-a 新增的查詢。
 */
import { ClickHouseError, clickHouseBase, connectError, responseError, type ClickHouseConfig } from './index.js';
import { ipText, paramText, READ_TABLES, THREAT_FIELDS, TRAFFIC_FIELDS, trafficWhere, type LogRecord, type Param, type TrafficFilter } from './reader.js';

export const HEAT_GRANULARITIES = ['5m', '1h', '1d'] as const;
export type HeatGrain = (typeof HEAT_GRANULARITIES)[number];
export const HEAT_TABLES: Record<HeatGrain, string> = { '5m': 'netops.pa_heat_5m', '1h': 'netops.pa_heat_1h', '1d': 'netops.pa_heat_1d' };

/** 一個時間格的彙總(查詢結果;沒有列的格子不會出現) */
export interface HeatRow {
  /** 格子開始(UTC 毫秒) */
  t: number;
  sessions: number;
  bytes: number;
  sent: number;
  recv: number;
  deny: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  /** topK 近似;IPv4 去掉 ::ffff:,沒有時空陣列 */
  topBytes: string[];
  topDeny: string[];
  topThreat: string[];
}

/** 時段明細的類型 */
export type SliceType = 'traffic' | 'threat';

/** 時段明細條件:TRAFFIC 沿用明細查詢的條件(trafficWhere);威脅另加嚴重度與威脅名稱 */
export interface SliceFilter extends TrafficFilter {
  severity?: string;
  threatName?: string;
}

export interface TopItem {
  key: string;
  sessions: number;
  bytes: number;
}

export interface SliceData {
  summary: { sessions: number; bytes: number; sent: number; recv: number; deny: number; threats: { critical: number; high: number; medium: number; low: number; info: number } };
  top: Record<string, (TopItem | { key: string; count: number; severity?: string })[]>;
  rows: LogRecord[];
  /** rows 是否被截斷(還有更多符合的) */
  more: boolean;
}

export interface HeatReader {
  /** 期間 [fromMs, toMs) 的彙總格(依時間排序) */
  heatRows(grain: HeatGrain, fromMs: number, toMs: number, signal?: AbortSignal): Promise<HeatRow[]>;
  /** 彙總表最早的格子(UTC 毫秒);沒有資料為 null(coverage.since) */
  heatEarliest(grain: HeatGrain, signal?: AbortSignal): Promise<number | null>;
  /* ───── 分析儀表板(V-b1;docs/VIZ-RULES-DESIGN.md §4.4):期間 [fromMs, toMs),最長 90 天 ───── */
  /** 來源區域 → App → 目的區域的位元組(pa_traffic_hourly_app);App 只取位元組前 topApps 名,其他併成 '' */
  insightFlows(fromMs: number, toMs: number, topApps: number, signal?: AbortSignal): Promise<{ fromZone: string; app: string; toZone: string; bytes: number }[]>;
  /** 位元組前 limit 名的 App(pa_traffic_hourly_app) */
  insightTopApps(fromMs: number, toMs: number, limit: number, signal?: AbortSignal): Promise<{ app: string; bytes: number; sessions: number }[]>;
  /** 位元組前 limit 名的來源 IP 與上傳 / 下載(pa_traffic_hourly_src,migrations/003 之前的列上傳 / 下載為 0) */
  insightTopSrc(fromMs: number, toMs: number, limit: number, signal?: AbortSignal): Promise<{ ip: string; bytes: number; sent: number; recv: number; sessions: number }[]>;
  /** 威脅(log_type = threat)依來源國家(PA 的英文全名) */
  threatCountries(fromMs: number, toMs: number, signal?: AbortSignal): Promise<{ country: string; count: number; critical: number; high: number }[]>;
  /** 威脅依來源 IP,只算 RFC 1918 內網(10/8、172.16/12、192.168/16) */
  threatTopInternalSrc(fromMs: number, toMs: number, limit: number, signal?: AbortSignal): Promise<{ ip: string; count: number; high: number }[]>;
  /** 威脅名稱排行 */
  threatTopNames(fromMs: number, toMs: number, limit: number, signal?: AbortSignal): Promise<{ name: string; severity: string; count: number }[]>;
  /** 時段明細(熱資料:原始表);rows ≤ rowsLimit,sort 依時間新到舊或位元組大到小 */
  slice(type: SliceType, f: SliceFilter, rowsLimit: number, sort: 'time' | 'bytes', maxSeconds: number, signal?: AbortSignal): Promise<SliceData>;
}

const sec = (ms: number) => Math.floor(ms / 1000);
const ipArr = (expr: string) => `arrayMap(x -> replaceRegexpOne(toString(x), '^::ffff:', ''), ${expr})`;
const TOP_N = 10;
const HOUR_RANGE = 'hour >= toDateTime({from:UInt32}) AND hour < toDateTime({to:UInt32})';
const THREAT_RANGE = `log_type = 'threat' AND event_time >= toDateTime({from:UInt32}) AND event_time < toDateTime({to:UInt32})`;
/** RFC 1918(常數;不接受外部字串) */
const PRIVATE_V4: [string, string][] = [
  ['10.0.0.0', '10.255.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.168.0.0', '192.168.255.255'],
];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;


/** 威脅條件:沿用 trafficWhere(IP、Port、App、區域、國家、動作在威脅表也有同名欄位),另加 log_type、嚴重度、威脅名稱 */
export function threatWhere(f: SliceFilter): { where: string[]; params: Record<string, Param> } {
  const { where, params } = trafficWhere({ ...f, q: undefined, proto: undefined, rule: undefined, user: undefined });
  where.push(`log_type = 'threat'`);
  let n = 0;
  const p = (v: Param) => {
    const k = `t${n++}`;
    params[k] = v;
    return `{${k}:String}`;
  };
  const sev = String(f.severity ?? '').trim().toLowerCase();
  if (sev) where.push(`severity = ${p(sev === 'info' ? 'informational' : sev)}`);
  const name = String(f.threatName ?? '').trim();
  if (name) where.push(`positionCaseInsensitiveUTF8(name, ${p(name)}) > 0`);
  return { where, params };
}

export function createHeatReader(cfg: ClickHouseConfig, fetchImpl: typeof fetch = fetch): HeatReader {
  const base = clickHouseBase(cfg.url);
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const headers = { 'X-ClickHouse-User': cfg.user, 'X-ClickHouse-Key': cfg.password, 'Content-Type': 'text/plain; charset=utf-8' };

  async function rows<T>(sql: string, params: Record<string, Param>, maxSeconds: number, signal?: AbortSignal): Promise<T[]> {
    const u = new URL(base);
    u.pathname = '/';
    for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, paramText(v));
    const secs = Math.min(Math.max(Math.floor(maxSeconds), 1), 50);
    u.searchParams.set('max_execution_time', String(secs));
    u.searchParams.set('output_format_json_quote_64bit_integers', '0');
    // 請求中斷時 ClickHouse 也停止(工作取消、逾時)
    u.searchParams.set('cancel_http_readonly_queries_on_client_close', '1');
    const waitMs = Math.max(timeoutMs, (secs + 10) * 1000);
    const timeout = AbortSignal.timeout(waitMs);
    let text: string;
    try {
      // redirect: 'error':轉址時 X-ClickHouse-Key 會被帶到別的主機,一律不跟隨
      const res = await fetchImpl(u, { method: 'POST', headers, body: `${sql} FORMAT JSONEachRow`, redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      text = await res.text();
      if (!res.ok) throw responseError(res, text);
    } catch (e) {
      if (e instanceof ClickHouseError) throw e;
      throw connectError(e, waitMs);
    }
    try {
      return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T);
    } catch {
      // HTTP 200 之後的中途錯誤:不把錯誤原文帶出去(可能含 log 內容)
      throw new ClickHouseError('ClickHouse 查詢中斷', Number(/Code: (\d+)/.exec(text)?.[1]) || undefined, 200);
    }
  }

  const num = (v: unknown) => Number(v ?? 0) || 0;

  return {
    async heatRows(grain, fromMs, toMs, signal) {
      type R = { t: number; s: number; b: number; bs: number; br: number; d: number; c: number; h: number; m: number; l: number; i: number; tb: string[]; td: string[]; tt: string[] };
      const r = await rows<R>(
        `SELECT toUnixTimestamp(bucket) AS t, sum(sessions) AS s, sum(bytes) AS b, sum(bytes_sent) AS bs, sum(bytes_recv) AS br, sum(deny) AS d,
                sum(thr_critical) AS c, sum(thr_high) AS h, sum(thr_medium) AS m, sum(thr_low) AS l, sum(thr_info) AS i,
                ${ipArr('topKWeightedMerge(3)(top_bytes_src)')} AS tb, ${ipArr('topKIfMerge(3)(top_deny_src)')} AS td, ${ipArr('topKIfMerge(3)(top_thr_src)')} AS tt
         FROM ${HEAT_TABLES[grain]} WHERE bucket >= toDateTime({from:UInt32}) AND bucket < toDateTime({to:UInt32}) GROUP BY bucket ORDER BY bucket`,
        { from: sec(fromMs), to: sec(toMs) },
        20,
        signal,
      );
      return r.map((x) => ({
        t: x.t * 1000,
        sessions: num(x.s),
        bytes: num(x.b),
        sent: num(x.bs),
        recv: num(x.br),
        deny: num(x.d),
        critical: num(x.c),
        high: num(x.h),
        medium: num(x.m),
        low: num(x.l),
        info: num(x.i),
        topBytes: x.tb ?? [],
        topDeny: x.td ?? [],
        topThreat: x.tt ?? [],
      }));
    },
    async heatEarliest(grain, signal) {
      const r = await rows<{ t: number; n: number }>(`SELECT toUnixTimestamp(min(bucket)) AS t, count() AS n FROM ${HEAT_TABLES[grain]}`, {}, 20, signal);
      return num(r[0]?.n) > 0 && num(r[0]?.t) > 0 ? num(r[0]?.t) * 1000 : null;
    },
    async insightFlows(fromMs, toMs, topApps, signal) {
      const r = await rows<{ fz: string; a: string; tz: string; b: number }>(
        `WITH top AS (SELECT app FROM ${READ_TABLES.hourlyApp} WHERE ${HOUR_RANGE} GROUP BY app ORDER BY sum(bytes) DESC LIMIT {n:UInt16})
         SELECT from_zone AS fz, if(app IN top, app, '') AS a, to_zone AS tz, sum(bytes) AS b FROM ${READ_TABLES.hourlyApp}
         WHERE ${HOUR_RANGE} GROUP BY fz, a, tz HAVING b > 0 ORDER BY b DESC LIMIT 500`,
        { from: sec(fromMs), to: sec(toMs), n: topApps },
        20,
        signal,
      );
      return r.map((x) => ({ fromZone: x.fz, app: x.a, toZone: x.tz, bytes: num(x.b) }));
    },
    async insightTopApps(fromMs, toMs, limit, signal) {
      const r = await rows<{ a: string; b: number; n: number }>(
        `SELECT app AS a, sum(bytes) AS b, sum(sessions) AS n FROM ${READ_TABLES.hourlyApp} WHERE ${HOUR_RANGE} GROUP BY a ORDER BY b DESC, a LIMIT {n:UInt16}`,
        { from: sec(fromMs), to: sec(toMs), n: limit },
        20,
        signal,
      );
      return r.map((x) => ({ app: x.a, bytes: num(x.b), sessions: num(x.n) }));
    },
    async insightTopSrc(fromMs, toMs, limit, signal) {
      const r = await rows<{ ip: string; b: number; bs: number; br: number; n: number }>(
        `SELECT ${ipText('src')} AS ip, sum(bytes) AS b, sum(bytes_sent) AS bs, sum(bytes_recv) AS br, sum(sessions) AS n FROM ${READ_TABLES.hourlySrc}
         WHERE ${HOUR_RANGE} GROUP BY src ORDER BY b DESC, ip LIMIT {n:UInt16}`,
        { from: sec(fromMs), to: sec(toMs), n: limit },
        20,
        signal,
      );
      return r.map((x) => ({ ip: x.ip, bytes: num(x.b), sent: num(x.bs), recv: num(x.br), sessions: num(x.n) }));
    },
    async threatCountries(fromMs, toMs, signal) {
      const r = await rows<{ c: string; n: number; cr: number; hi: number }>(
        `SELECT src_country AS c, count() AS n, countIf(severity = 'critical') AS cr, countIf(severity = 'high') AS hi FROM ${READ_TABLES.threat}
         WHERE ${THREAT_RANGE} GROUP BY c ORDER BY n DESC LIMIT 500`,
        { from: sec(fromMs), to: sec(toMs) },
        30,
        signal,
      );
      return r.map((x) => ({ country: x.c, count: num(x.n), critical: num(x.cr), high: num(x.hi) }));
    },
    async threatTopInternalSrc(fromMs, toMs, limit, signal) {
      const r = await rows<{ ip: string; n: number; hi: number }>(
        `SELECT ${ipText('src')} AS ip, count() AS n, countIf(severity IN ('critical', 'high')) AS hi FROM ${READ_TABLES.threat}
         WHERE ${THREAT_RANGE} AND (${PRIVATE_V4.map(([a, b]) => `src BETWEEN toIPv6('::ffff:${a}') AND toIPv6('::ffff:${b}')`).join(' OR ')})
         GROUP BY src ORDER BY n DESC, ip LIMIT {n:UInt16}`,
        { from: sec(fromMs), to: sec(toMs), n: limit },
        30,
        signal,
      );
      return r.map((x) => ({ ip: x.ip, count: num(x.n), high: num(x.hi) }));
    },
    async threatTopNames(fromMs, toMs, limit, signal) {
      const r = await rows<{ k: string; sv: string; n: number }>(
        `SELECT name AS k, any(severity) AS sv, count() AS n FROM ${READ_TABLES.threat} WHERE ${THREAT_RANGE} GROUP BY k ORDER BY n DESC, k LIMIT {n:UInt16}`,
        { from: sec(fromMs), to: sec(toMs), n: limit },
        30,
        signal,
      );
      return r.map((x) => ({ name: x.k, severity: x.sv === 'informational' ? 'info' : x.sv, count: num(x.n) }));
    },
    async slice(type, f, rowsLimit, sort, maxSeconds, signal) {
      const isTraffic = type === 'traffic';
      const table = isTraffic ? READ_TABLES.traffic : READ_TABLES.threat;
      const { where, params } = isTraffic ? trafficWhere(f) : threatWhere(f);
      const w = where.join(' AND ');
      const q = <T>(sql: string, extra: Record<string, Param> = {}) => rows<T>(sql, { ...params, ...extra }, maxSeconds, signal);
      // 別名一律不和欄位同名:ClickHouse 的 WHERE 會先解析成 SELECT 的別名(例:ipText('src') AS src 會讓 src 條件變成字串比較)
      const topBy = async (expr: string): Promise<SliceData['top'][string]> =>
        isTraffic
          ? (
              await q<{ k: string; n: number; bt: number }>(
                `SELECT ${expr} AS k, count() AS n, sum(bytes) AS bt FROM ${table} WHERE ${w} GROUP BY k ORDER BY bt DESC, n DESC, k LIMIT ${TOP_N}`,
              )
            ).map((x) => ({ key: String(x.k ?? ''), sessions: num(x.n), bytes: num(x.bt) }))
          : (await q<{ k: string; n: number }>(`SELECT ${expr} AS k, count() AS n FROM ${table} WHERE ${w} GROUP BY k ORDER BY n DESC, k LIMIT ${TOP_N}`)).map((x) => ({
              key: String(x.k ?? ''),
              count: num(x.n),
            }));

      // 威脅嚴重度:TRAFFIC 明細也附上同時段、同 IP 條件的威脅數(抽屜摘要列;只帶 IP 條件)
      const thrFilter: SliceFilter = isTraffic ? { fromMs: f.fromMs, toMs: f.toMs, ip: f.ip, src: f.src, dst: f.dst } : f;
      const tw = threatWhere(thrFilter);
      // 查詢依序執行(不並行):一個時段明細最多同時佔 ClickHouse 1 個查詢名額(資安審查 M1)
      const sevP = () => rows<{ c: number; h: number; m: number; l: number; i: number }>(
        `SELECT ${SEVERITIES.map((s, i) => `countIf(severity = '${s}') AS ${'chmli'[i]}`).join(', ')} FROM ${READ_TABLES.threat} WHERE ${tw.where.join(' AND ')}`,
        tw.params,
        maxSeconds,
        signal,
      );
      const sumP = () =>
        isTraffic
        ? q<{ s: number; b: number; bs: number; br: number; d: number }>(
            `SELECT count() AS s, sum(bytes) AS b, sum(bytes_sent) AS bs, sum(bytes_recv) AS br, countIf(action != 'allow') AS d FROM ${table} WHERE ${w}`,
          )
        : q<{ s: number; d: number }>(`SELECT count() AS s, countIf(action != 'allow') AS d FROM ${table} WHERE ${w}`);
      const fields = isTraffic ? TRAFFIC_FIELDS : THREAT_FIELDS;
      const order = sort === 'bytes' && isTraffic ? 'bytes DESC, event_time DESC' : 'event_time DESC';
      const rowsP = () =>
        rowsLimit
        ? q<Record<string, string | number>>(`SELECT ${fields.map(([, e], i) => `${e} AS f${i}`).join(', ')} FROM ${table} WHERE ${w} ORDER BY ${order} LIMIT {lim:UInt16}`, { lim: rowsLimit + 1 }).then(
            (list) => list.map((r) => Object.fromEntries(fields.map(([k], i) => [k, r[`f${i}`] ?? ''])) as LogRecord),
          )
        : Promise.resolve([] as LogRecord[]);
      const topsP = async (): Promise<SliceData['top']> => {
        if (isTraffic) return { src: await topBy(ipText('src')), dst: await topBy(ipText('dst')), app: await topBy('app'), dport: await topBy('toString(dport)'), dstCountry: await topBy('dst_country') };
        const name = (await q<{ k: string; sv: string; n: number }>(`SELECT name AS k, any(severity) AS sv, count() AS n FROM ${table} WHERE ${w} GROUP BY k ORDER BY n DESC, k LIMIT ${TOP_N}`)).map((x) => ({
          key: String(x.k ?? ''),
          severity: x.sv === 'informational' ? 'info' : x.sv,
          count: num(x.n),
        }));
        return { name, src: await topBy(ipText('src')), dst: await topBy(ipText('dst')), srcCountry: await topBy('src_country') };
      };
      const sev = await sevP();
      const sum = await sumP();
      const list = await rowsP();
      const top = await topsP();
      const s = sum[0] as { s?: number; b?: number; bs?: number; br?: number; d?: number } | undefined;
      const t = sev[0];
      const more = list.length > rowsLimit;
      return {
        summary: {
          sessions: num(s?.s),
          bytes: num(s?.b),
          sent: num(s?.bs),
          recv: num(s?.br),
          deny: num(s?.d),
          threats: { critical: num(t?.c), high: num(t?.h), medium: num(t?.m), low: num(t?.l), info: num(t?.i) },
        },
        top,
        rows: more ? list.slice(0, rowsLimit) : list,
        more,
      };
    },
  };
}
