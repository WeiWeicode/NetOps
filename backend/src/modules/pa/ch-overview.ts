/**
 * 總覽改查 ClickHouse(C3;ARCHITECTURE D29、D34、手冊 §12 CQ10、CQ11)。回應格式與 FTP 來源相同(docs/API.md §4.1、§4.2),另加:
 *   source     'clickhouse' | 'ftp'(實際使用的來源)
 *   topsUntil  排行與疑似掃描只算到這個時間(已結束且建好摘要的小時;之後的小時還沒有排行)
 *
 * TRAFFIC:筆數、允許 / 阻擋、位元組、每小時統計、動作 → 每小時彙總表(即時,含進行中的小時);
 *          排行、疑似掃描、送出 / 接收、類型、最早 / 最晚時間 → 每小時摘要(ch-summary.ts)
 * 威脅類:全部來自每小時摘要(沒有彙總表;量小)
 * 來源選擇:query 的 source 優先;否則依設定(auto:期間的開始在 ClickHouse 最早一小時之後才用 ClickHouse)。
 * auto 時 ClickHouse 失敗改用 FTP 並記 warn;指定 clickhouse 時回 503 NETOPS_CLICKHOUSE_UNAVAILABLE(只影響這些 API)。
 */
import type { PaSource } from '../../config.js';
import { AppError } from '../../errors.js';
import { ClickHouseError } from '../../infra/clickhouse/index.js';
import type { ChEventType, ClickHouseReader } from '../../infra/clickhouse/reader.js';
import type { DashboardCache } from '../../infra/redis/cache.js';
import { taipeiDayStartMs, taipeiHourKey } from '../../shared/time.js';
import type { ChSummaryBuilder } from './ch-summary.js';
import { isAllow, mergeSummaries } from './core/palog.js';
import { mergeEventSummaries } from '../pa-events/core/paevents.js';

/** 快取秒數(CQ11:30–60 秒) */
export const CACHE_SEC = 60;

export interface ChOverviewDeps {
  reader: ClickHouseReader | null;
  builder: ChSummaryBuilder | null;
  cache: DashboardCache;
  mode: PaSource;
  log: { warn(o: object, m: string): void };
}

/** 503:原因(cause)只寫日誌,回應只有分類過的訊息(app.ts 錯誤處理) */
export const unavailable = (cause?: unknown) =>
  Object.assign(new AppError(503, 'NETOPS_CLICKHOUSE_UNAVAILABLE', 'PA log 資料庫(ClickHouse)暫時無法使用,請稍後再試或改用 FTP 來源'), cause ? { cause } : {});

/**
 * 決定來源。requested:query 的 source;fromMs:期間開始。
 * auto:ClickHouse 有設定、而且期間開始不早於 ClickHouse 最早一小時(期間前段沒有資料就不完整)才用 ClickHouse
 */
export function pickSource(d: Pick<ChOverviewDeps, 'reader' | 'builder' | 'mode'>, requested: string | undefined, fromMs: number): 'ftp' | 'clickhouse' {
  const mode = (requested as PaSource | undefined) ?? d.mode;
  if (mode === 'ftp') return 'ftp';
  if (!d.reader || !d.builder) {
    if (mode === 'clickhouse') throw unavailable();
    return 'ftp';
  }
  if (mode === 'clickhouse') return 'clickhouse';
  const earliest = d.builder.earliest();
  return earliest !== null && fromMs >= earliest ? 'clickhouse' : 'ftp';
}

/** ClickHouse 失敗:auto 回 null(呼叫端改用 FTP),指定 clickhouse 時丟 503 */
export async function viaClickHouse<T>(d: ChOverviewDeps, requested: string | undefined, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof ClickHouseError)) throw err;
    if ((requested ?? d.mode) === 'clickhouse') throw unavailable(err);
    d.log.warn({ err: err.message }, 'ClickHouse 查詢失敗,改用 FTP 來源');
    return null;
  }
}

/** 日期期間('yyyy/MM/dd')→ [fromMs, toMs) */
export const dayRangeMs = (from: string, to: string): [number, number] => [taipeiDayStartMs(from), taipeiDayStartMs(to) + 86_400_000];

const untilOut = (until: number | null, toMs: number) => (until === null ? '' : taipeiHourKey(Math.min(until, toMs)));

/** TRAFFIC 總覽(格式同 routes.ts 的 FTP 來源;hours / timeMin / timeMax 仍是核心時間字串,由路由轉換) */
export async function trafficOverview(d: ChOverviewDeps, from: string, to: string, topN: number) {
  const reader = d.reader!;
  const builder = d.builder!;
  return d.cache.cached('pa-overview', { from, to, topN }, CACHE_SEC, async () => {
    const [fromMs, toMs] = dayRangeMs(from, to);
    const hourRows = await reader.trafficHours(fromMs, toMs);
    const { list, missing, until } = builder.summaries('traffic', fromMs, toMs);
    const merged = mergeSummaries(list, topN) as ReturnType<typeof mergeSummaries> & { timeMin: string; timeMax: string };
    const hours = new Map<number, { n: number; allow: number; block: number; bytes: number }>();
    const actions: Record<string, number> = {};
    let rows = 0;
    let allow = 0;
    let bytes = 0;
    for (const r of hourRows) {
      const h = hours.get(r.hour) ?? { n: 0, allow: 0, block: 0, bytes: 0 };
      h.n += r.n;
      h.bytes += r.bytes;
      if (isAllow(r.action)) h.allow += r.n;
      else h.block += r.n;
      hours.set(r.hour, h);
      const a = r.action || '(空白)';
      actions[a] = (actions[a] ?? 0) + r.n;
      rows += r.n;
      bytes += r.bytes;
      if (isAllow(r.action)) allow += r.n;
    }
    return {
      ...merged,
      source: 'clickhouse' as const,
      // FTP 來源的 files 是已分析的檔案數;ClickHouse 來源是有資料的小時數(0 = 沒有資料)
      files: hours.size,
      missing,
      rows,
      allow,
      block: rows - allow,
      bytes,
      actions,
      hours: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([h, v]) => ({ hour: taipeiHourKey(h), ...v })),
      topsUntil: untilOut(until, toMs),
    };
  });
}

/** 明細查詢的下拉選項(App、區域、動作來自每小時彙總;規則來自每小時摘要) */
export async function trafficOptions(d: ChOverviewDeps, from: string, to: string) {
  return d.cache.cached('pa-options', { from, to }, CACHE_SEC, async () => {
    const [fromMs, toMs] = dayRangeMs(from, to);
    const o = await d.reader!.trafficOptions(fromMs, toMs, 200);
    const m = mergeSummaries(d.builder!.summaries('traffic', fromMs, toMs).list, 200) as unknown as { top: Record<string, { key: string }[]> };
    return { apps: o.apps, rules: (m.top.rule ?? []).map((x) => x.key), zones: o.zones, actions: o.actions };
  });
}

/** 威脅類總覽(格式同 mergeEventSummaries;files = 有摘要的小時數) */
export async function eventOverview(d: ChOverviewDeps, type: ChEventType, from: string, to: string, topN: number) {
  return d.cache.cached('pa-events-overview', { type, from, to, topN }, CACHE_SEC, async () => {
    const [fromMs, toMs] = dayRangeMs(from, to);
    const { list, missing, until } = d.builder!.summaries(type, fromMs, toMs);
    const m = mergeEventSummaries(type, list, topN);
    return { ...m, source: 'clickhouse' as const, missing, topsUntil: untilOut(until, toMs) };
  });
}

