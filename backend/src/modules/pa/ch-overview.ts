/**
 * PA 總覽、安全事件、篩選選項只查 ClickHouse(C3;ARCHITECTURE D29、D42、D43:2026-11-11 需求方決定捨棄 FTP 查詢路徑、
 * 不再並行 2 週)。回應格式沿用 docs/API.md §4.1、§4.2,另加:
 *   source     固定 'clickhouse'
 *   topsUntil  排行與疑似掃描只算到這個時間(已結束且建好摘要的小時;之後的小時還沒有排行)
 *   topsState  ok;not-ready(服務剛啟動,每小時摘要還在建立);stale(太久沒更新,ClickHouse 可能停止)
 *   coverage   ClickHouse 實際有資料的範圍 { from, to }(YYYY-MM-DD);partial = 期間有一部分在範圍之前
 *
 * TRAFFIC:筆數、允許 / 阻擋、位元組、每小時統計、動作 → 每小時彙總表(即時,含進行中的小時);
 *          排行、疑似掃描、送出 / 接收、類型、最早 / 最晚時間 → 每小時摘要(ch-summary.ts)
 * 威脅類:全部來自每小時摘要(沒有彙總表;量小)
 * 期間整個在 ClickHouse 有資料之前(超過保留期限)回 404 NETOPS_PA_OUT_OF_RETENTION,不回 0(AGENT.md §5)。
 * ClickHouse 連不上或未設定回 503 NETOPS_CLICKHOUSE_UNAVAILABLE(不再改用 FTP)。
 */
import { AppError } from '../../errors.js';
import { ClickHouseError } from '../../infra/clickhouse/index.js';
import type { ChEventType, ClickHouseReader } from '../../infra/clickhouse/reader.js';
import type { DashboardCache } from '../../infra/redis/cache.js';
import { taipeiDayStartMs, taipeiHourKey, taipeiText } from '../../shared/time.js';
import type { ChSummaryBuilder } from './ch-summary.js';
import { isAllow, mergeSummaries } from './core/palog.js';
import { mergeEventSummaries } from '../pa-events/core/paevents.js';

/** 快取秒數(CQ11:30–60 秒) */
export const CACHE_SEC = 60;
const DAY_MS = 86_400_000;

export interface ChOverviewDeps {
  reader: ClickHouseReader | null;
  builder: ChSummaryBuilder | null;
  cache: DashboardCache;
  log: { warn(o: object, m: string): void };
}

/** 503:原因(cause)只寫日誌,回應只有分類過的訊息(app.ts 錯誤處理) */
export const unavailable = (cause?: unknown) =>
  Object.assign(new AppError(503, 'NETOPS_CLICKHOUSE_UNAVAILABLE', 'PA log 資料庫(ClickHouse)暫時無法使用,請稍後再試'), cause ? { cause } : {});

/** ClickHouse 有設定才可用 */
export function need(d: Pick<ChOverviewDeps, 'reader' | 'builder'>): { reader: ClickHouseReader; builder: ChSummaryBuilder } {
  if (!d.reader || !d.builder) throw unavailable();
  return { reader: d.reader, builder: d.builder };
}

/** ClickHouse 失敗 → 503(日誌只記代碼:錯誤原文可能帶 log 內容;資安審查 L2) */
export async function viaClickHouse<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ClickHouseError) throw unavailable({ code: err.code, status: err.status });
    throw err;
  }
}

/** 日期期間('yyyy/MM/dd')→ [fromMs, toMs) */
export const dayRangeMs = (from: string, to: string): [number, number] => [taipeiDayStartMs(from), taipeiDayStartMs(to) + DAY_MS];

const ymd = (ms: number) => taipeiText(ms).slice(0, 10).replace(/\//g, '-');
const untilOut = (until: number | null, toMs: number) => (until === null ? '' : taipeiHourKey(Math.min(until, toMs)));

/** ClickHouse 有資料的日期(新的在前):TRAFFIC 來自每小時彙總;威脅類來自原始表 */
export type DayRow = { day: string; hours: number; rows: number };

/**
 * 有資料的日期也放在程序內 2 分鐘(資安審查 M:Redis 停止時不讓每個請求都掃一次);威脅類一次查全部類型
 */
const DAYS_MEMO_MS = 120_000;
const memo = new WeakMap<ChOverviewDeps, Map<string, { at: number; v: Promise<DayRow[]> }>>();

export async function dataDays(d: ChOverviewDeps, kind: 'traffic' | ChEventType): Promise<DayRow[]> {
  const { reader } = need(d);
  const key = kind === 'traffic' ? 'traffic' : 'threat';
  const m = memo.get(d) ?? new Map();
  memo.set(d, m);
  let hit = m.get(key);
  if (!hit || Date.now() - hit.at > DAYS_MEMO_MS) {
    const v = viaClickHouse(async () => {
      if (key === 'traffic') return (await reader.trafficDays()).map((x) => ({ type: 'traffic', day: ymd(x.day), hours: x.hours, rows: x.rows }));
      return (await reader.threatDays()).map((x) => ({ type: x.type, day: ymd(x.day), hours: x.hours, rows: x.rows }));
    });
    hit = { at: Date.now(), v };
    m.set(key, hit);
    // 失敗不留在記憶裡,下次重查
    v.catch(() => m.get(key) === hit && m.delete(key));
  }
  const all = (await hit.v) as (DayRow & { type: string })[];
  return all.filter((x) => x.type === kind).map(({ day, hours, rows }) => ({ day, hours, rows }));
}

/**
 * 期間和 ClickHouse 實際有資料的範圍比對:整個在範圍之前(超過保留期限)回 404 NETOPS_PA_OUT_OF_RETENTION;
 * 還沒有任何資料回 404 NETOPS_PA_NO_DATA。回傳 coverage 與 partial(期間開始早於最早的資料)
 */
export async function checkCoverage(d: ChOverviewDeps, kind: 'traffic' | ChEventType, fromMs: number, toMs: number) {
  const days = await dataDays(d, kind);
  if (!days.length) throw new AppError(404, 'NETOPS_PA_NO_DATA', 'ClickHouse 目前還沒有這類 log');
  const coverage = { from: days.at(-1)!.day, to: days[0]!.day };
  const first = taipeiDayStartMs(coverage.from.replace(/-/g, '/'));
  if (toMs <= first)
    throw new AppError(404, 'NETOPS_PA_OUT_OF_RETENTION', `這段期間超過資料保留期限:目前只有 ${coverage.from} ~ ${coverage.to} 的資料`, [{ field: 'from', message: `最早 ${coverage.from}` }]);
  // TRAFFIC 用最早一小時判斷(最早那天可能只從 08:00 起有資料);威脅類以天為單位(程式碼審查 #5)
  const earliest = kind === 'traffic' ? (d.builder?.earliest() ?? first) : first;
  return { coverage, partial: fromMs < Math.max(earliest, first) };
}

/** 快取一律用排行上限算,回應前再截到 top:快取鍵不含 top,換 top 不會繞過快取(資安審查 M2) */
const TOP_MAX = 100;
type TopMap = Record<string, unknown[]>;
const cut = (m: TopMap | undefined, n: number) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.slice(0, n)])) : m);

/** TRAFFIC 總覽(hours / timeMin / timeMax / topsUntil 仍是核心時間字串,由路由轉換) */
export async function trafficOverview(d: ChOverviewDeps, from: string, to: string, topN: number) {
  const { reader, builder } = need(d);
  const [fromMs, toMs] = dayRangeMs(from, to);
  const cov = await checkCoverage(d, 'traffic', fromMs, toMs);
  const r = await d.cache.cached('pa-overview', { from, to }, CACHE_SEC, () =>
    viaClickHouse(async () => {
      const { list, missing, until, state } = await builder.summaries('traffic', fromMs, toMs);
      const hourRows = await reader.trafficHours(fromMs, toMs);
      const merged = mergeSummaries(list, TOP_MAX) as ReturnType<typeof mergeSummaries> & { timeMin: string; timeMax: string };
      const hours = new Map<number, { n: number; allow: number; block: number; bytes: number }>();
      const actions: Record<string, number> = {};
      let rows = 0;
      let allow = 0;
      let bytes = 0;
      for (const x of hourRows) {
        const h = hours.get(x.hour) ?? { n: 0, allow: 0, block: 0, bytes: 0 };
        h.n += x.n;
        h.bytes += x.bytes;
        if (isAllow(x.action)) h.allow += x.n;
        else h.block += x.n;
        hours.set(x.hour, h);
        const a = x.action || '(空白)';
        actions[a] = (actions[a] ?? 0) + x.n;
        rows += x.n;
        bytes += x.bytes;
        if (isAllow(x.action)) allow += x.n;
      }
      return {
        ...merged,
        source: 'clickhouse' as const,
        // 有資料的小時數(0 = 這段期間 ClickHouse 沒有資料)
        files: hours.size,
        missing,
        rows,
        allow,
        block: rows - allow,
        bytes,
        actions,
        hours: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([h, v]) => ({ hour: taipeiHourKey(h), ...v })),
        topsUntil: untilOut(until, toMs),
        topsState: state,
      };
    }),
    // 排行還沒建好 / 過期的結果不快取(建好後馬上看得到;程式碼審查 #8)
    (v) => v.topsState === 'ok',
  );
  return { ...r, ...cov, top: cut(r.top as TopMap, topN), topBytes: cut(r.topBytes as TopMap, topN) };
}

/** 明細查詢的下拉選項(App、區域、動作來自每小時彙總;規則來自每小時摘要) */
export async function trafficOptions(d: ChOverviewDeps, from: string, to: string) {
  const { reader, builder } = need(d);
  // 超過保留期限同總覽回 404(程式碼審查 #3)
  await checkCoverage(d, 'traffic', ...dayRangeMs(from, to));
  return d.cache.cached('pa-options', { from, to }, CACHE_SEC, () =>
    viaClickHouse(async () => {
      const [fromMs, toMs] = dayRangeMs(from, to);
      const o = await reader.trafficOptions(fromMs, toMs, 200);
      const m = mergeSummaries((await builder.summaries('traffic', fromMs, toMs)).list, 200) as unknown as { top: Record<string, { key: string }[]> };
      return { apps: o.apps, rules: (m.top.rule ?? []).map((x) => x.key), zones: o.zones, actions: o.actions };
    }),
  );
}

/** 威脅類總覽(格式同 mergeEventSummaries;files = 有摘要的小時數) */
export async function eventOverview(d: ChOverviewDeps, type: ChEventType, from: string, to: string, topN: number) {
  const { builder } = need(d);
  const [fromMs, toMs] = dayRangeMs(from, to);
  const cov = await checkCoverage(d, type, fromMs, toMs);
  const r = await d.cache.cached('pa-events-overview', { type, from, to }, CACHE_SEC, () =>
    viaClickHouse(async () => {
      const { list, missing, until, state } = await builder.summaries(type, fromMs, toMs);
      const m = mergeEventSummaries(type, list, TOP_MAX);
      return { ...m, source: 'clickhouse' as const, missing, topsUntil: untilOut(until, toMs), topsState: state };
    }),
    (v) => v.topsState === 'ok',
  );
  return { ...r, ...cov, tops: r.tops.map((t: { items: unknown[] }) => ({ ...t, items: t.items.slice(0, topN) })) };
}
