/**
 * 活動熱力圖與時段明細(V-a;docs/VIZ-RULES-DESIGN.md §4.2、§4.3)。
 *   熱力圖:只讀彙總表(pa_heat_*),Redis 快取(含現在的期間 60 秒、已結束 1 小時)
 *   時段明細:一律建 pa-slice 工作,30 秒內完成直接回結果(200),否則回 202 工作狀態(D6、V3);同一人同條件重用同一個工作
 *     熱 / 冷分界 hotFloor = 今天 00:00 −(原始表保留天數 − 1)天;冷資料(C4 前)回 409 NETOPS_COLD_ARCHIVE_DISABLED
 *     冷查詢全系統 1 個(Redis 鎖),拿不到回 429 NETOPS_COLD_QUERY_BUSY + Retry-After(不回 5xx,BFF 斷路器)
 * ClickHouse 失敗回 503 NETOPS_CLICKHOUSE_UNAVAILABLE(同 C3 的既有代碼,docs/API.md §8);原文只寫日誌。
 */
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';
import { ClickHouseError } from '../../infra/clickhouse/index.js';
import type { HeatReader, SliceData, SliceFilter, SliceType } from '../../infra/clickhouse/heat.js';
import type { LogRecord } from '../../infra/clickhouse/reader.js';
import { JobRunner, type JobView } from '../../infra/jobs/index.js';
import type { ColdLock } from '../../infra/redis/cold-lock.js';
import type { DashboardCache } from '../../infra/redis/cache.js';
import { logTimeOut, taipeiTimeMs } from '../../shared/time.js';
import { unavailable } from '../pa/ch-overview.js';
import type { Reconciler } from '../pa/reconcile.js';
import { buildCells, DAY_VIEW_RETENTION_DAYS, dayText, heatRange, isoTaipei, parseDay, taipeiDayOf, type Gap, type GapMs, type Granularity, type Metric, type PaMetric } from './heat.js';

const DAY_MS = 86_400_000;
export const SLICE_KIND = 'pa-slice';
/** 同步等待秒數(V3);路由 x-timeout-ms 40000 */
export const SLICE_SYNC_MS = 30_000;
/** 時段明細最長 1 天(V3) */
export const SLICE_MAX_MS = DAY_MS;
/** 熱查詢的 ClickHouse 執行上限(netops_reader constraints 最多 50 秒) */
const SLICE_CH_SECONDS = 50;
/** 工作執行上限(V-a §4.3.2:120 秒) */
const SLICE_JOB_TIMEOUT_MS = 120_000;
/** 冷工作執行上限:比冷查詢鎖的 TTL(120 秒)短,鎖不會在查詢結束前過期 */
const COLD_JOB_TIMEOUT_MS = 110_000;
/** 冷查詢忙碌時建議幾秒後重試 */
export const COLD_RETRY_AFTER_SEC = 10;

/** 冷資料查詢(C4 提供;現在沒有) */
export interface ColdSlice {
  query(type: SliceType, f: SliceFilter, rowsLimit: number, sort: 'time' | 'bytes', signal: AbortSignal): Promise<SliceData>;
}

export interface HeatDeps {
  heat: HeatReader | null;
  cache: DashboardCache;
  recon: Reconciler | null;
  /** 原始表保留天數(config.paTtlDays) */
  ttlDays: { traffic: number; threat: number };
  cold: ColdSlice | null;
  coldLock: ColdLock | null;
  log: { warn(o: object, m: string): void };
  now?: () => number;
}

export interface SliceQuery {
  start: string;
  end: string;
  type?: SliceType;
  ip?: string;
  src?: string;
  dst?: string;
  app?: string;
  fromZone?: string;
  toZone?: string;
  dport?: number;
  action?: 'allow' | 'block';
  country?: string;
  severity?: string;
  threatName?: string;
  rows?: number;
  sort?: 'time' | 'bytes';
}

export interface SliceResult {
  source: 'hot' | 'cold' | 'mixed';
  type: SliceType;
  start: string;
  end: string;
  filters: Record<string, string | number>;
  summary: SliceData['summary'];
  top: SliceData['top'];
  rows: Record<string, string | number>[];
  rowsLimit: number;
  rowsTruncated: boolean;
  coverage: { partial: boolean; gaps: Gap[]; gapsKnown: boolean };
  seconds: number;
}

const FILTER_KEYS = ['ip', 'src', 'dst', 'app', 'fromZone', 'toZone', 'dport', 'action', 'country', 'severity', 'threatName'] as const;

/** ClickHouse 錯誤 → 503(原文只寫日誌,只記代碼) */
async function viaCh<T>(log: HeatDeps['log'], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof ClickHouseError)) throw err;
    log.warn({ code: err.code, status: err.status }, 'ClickHouse 熱力圖 / 時段明細查詢失敗');
    throw unavailable({ code: err.code, status: err.status });
  }
}

/** 兩段明細合併(跨熱 / 冷分界):總數相加;排行依鍵合併後重排取前 10;明細列依時間(或位元組)合併 */
export function mergeSlices(a: SliceData, b: SliceData, rowsLimit: number, sort: 'time' | 'bytes'): SliceData {
  const add = <T extends Record<string, number>>(x: T, y: T) => Object.fromEntries(Object.keys(x).map((k) => [k, (x[k] ?? 0) + (y[k] ?? 0)])) as T;
  const { threats: ta, ...sa } = a.summary;
  const { threats: tb, ...sb } = b.summary;
  const top: SliceData['top'] = {};
  for (const k of new Set([...Object.keys(a.top), ...Object.keys(b.top)])) {
    const m = new Map<string, Record<string, unknown>>();
    for (const it of [...(a.top[k] ?? []), ...(b.top[k] ?? [])] as Record<string, unknown>[]) {
      const cur = m.get(String(it.key));
      if (!cur) m.set(String(it.key), { ...it });
      else for (const [f, v] of Object.entries(it)) if (typeof v === 'number') cur[f] = Number(cur[f] ?? 0) + v;
    }
    const rank = (x: Record<string, unknown>) => Number(x.bytes ?? x.count ?? 0);
    top[k] = [...m.values()].sort((x, y) => rank(y) - rank(x) || String(x.key).localeCompare(String(y.key))).slice(0, 10) as SliceData['top'][string];
  }
  const rows = [...a.rows, ...b.rows].sort((x, y) => (sort === 'bytes' ? Number(y.bytes ?? 0) - Number(x.bytes ?? 0) : 0) || String(y.time).localeCompare(String(x.time)));
  return { summary: { ...add(sa, sb), threats: add(ta, tb) }, top, rows: rows.slice(0, rowsLimit), more: a.more || b.more || rows.length > rowsLimit };
}

export function createHeatService(d: HeatDeps) {
  const now = d.now ?? Date.now;
  const onError = (kind: string, err: unknown) => d.log.warn({ err, kind }, '時段明細工作發生非預期錯誤');
  // 熱查詢:同時執行 2 個(一個工作內的查詢依序執行,ClickHouse 最多同時 2 個查詢;資安審查 M1)
  const hotJobs = new JobRunner({ maxActivePerOwner: 2, maxActive: 6, concurrency: 2, retainMs: 30 * 60_000, maxRetained: 60, maxRetainedPerOwner: 5, now }, onError);
  // 冷查詢:全系統 1 個(Redis 鎖在送出前取得);不排隊,鎖的 TTL(120 秒)涵蓋整個執行上限(110 秒)(程式碼審查 #2)
  const coldJobs = new JobRunner({ maxActivePerOwner: 1, maxActive: 1, concurrency: 1, retainMs: 30 * 60_000, maxRetained: 20, maxRetainedPerOwner: 5, now }, onError);
  /** 工作在哪個佇列(id 是 UUID,不會重複);都找不到時由熱佇列回 404 */
  const jobsOf = (id: string, owner: string): JobRunner => {
    try {
      coldJobs.get(id, owner, SLICE_KIND);
      return coldJobs;
    } catch {
      return hotJobs;
    }
  };
  interface Entry {
    /** 工作 id;送出前(等冷查詢鎖)為空字串 */
    id: string;
    runner: JobRunner;
    /** 送出完成(或失敗)時 resolve;同條件的併發請求先等這個(程式碼審查 #3) */
    ready: Promise<void>;
    /** 工作結束時 resolve */
    done: Promise<void>;
    error: { err: unknown } | null;
  }
  /** 同一人同條件 → 工作(GET 冪等:重送回同一個工作) */
  const reuse = new Map<string, Entry>();

  const reader = () => {
    if (!d.heat) throw unavailable();
    return d.heat;
  };

  /** 期間內已知的缺口(C3 每日對帳的缺口小時);沒有對帳時 gapsKnown = false */
  function gapsIn(fromMs: number, toMs: number): { gaps: GapMs[]; known: boolean } {
    if (!d.recon) return { gaps: [], known: false };
    const days = d.recon.list(dayText(fromMs).replace(/-/g, '/'), dayText(toMs - 1).replace(/-/g, '/'));
    const gaps: GapMs[] = [];
    for (const day of days)
      for (const h of day.hours)
        if (h.status === 'gap') {
          const s = taipeiTimeMs(`${h.hour}:00`);
          if (s < toMs && s + 3600_000 > fromMs) gaps.push({ fromMs: s, toMs: s + 3600_000, reason: 'recon-gap' });
        }
    return { gaps: gaps.sort((a, b) => a.fromMs - b.fromMs), known: true };
  }
  const gapOut = (g: GapMs): Gap => ({ from: isoTaipei(g.fromMs), to: isoTaipei(g.toMs), reason: g.reason });

  async function heatmap(q: { granularity: Granularity; metric: Metric; date?: string; weekStart?: 0 | 1 }) {
    if (q.metric === 'ad') throw new AppError(409, 'NETOPS_HEATMAP_METRIC_UNAVAILABLE', 'AD 異常指標在 AD 階段(V-d)開放');
    const t = now();
    const today = taipeiDayOf(t);
    const dayMs = q.date ? parseDay(q.date) : today;
    if (Number.isNaN(dayMs)) throw new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', [{ field: 'date', message: '日期格式必須是 YYYY-MM-DD' }]);
    if (dayMs > today) throw new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', [{ field: 'date', message: '日期不可晚於今天' }]);
    if (q.granularity === 'day' && dayMs < today - DAY_VIEW_RETENTION_DAYS * DAY_MS) {
      const earliest = dayText(today - DAY_VIEW_RETENTION_DAYS * DAY_MS);
      throw new AppError(422, 'NETOPS_HEATMAP_OUT_OF_RETENTION', `日視圖(每 5 分鐘)只保留 1 年,最早可查 ${earliest}`, { earliest });
    }
    const range = heatRange(q.granularity, dayMs, t, q.weekStart ?? 1);
    const h = reader();
    // 含現在、或剛結束 1 小時內(最後幾格可能還有遲到的寫入)用 60 秒;更早結束的期間 1 小時(程式碼審查 #8)
    const live = range.toMs > t - 3600_000;
    // 快取原始格子(和指標無關:三個指標共用一份)
    const data = await viaCh(d.log, () =>
      d.cache.cached('pa-heat', { grain: range.grain, from: range.fromMs, to: range.toMs }, live ? 60 : 3600, async () => ({
        rows: await h.heatRows(range.grain, range.fromMs, range.toMs),
        since: await h.heatEarliest(range.grain),
      }), { longTtl: !live }),
    );
    const { gaps, known } = gapsIn(range.fromMs, range.toMs);
    const { cells, levels } = buildCells(range, q.metric as PaMetric, data.rows, data.since, gaps);
    return {
      granularity: q.granularity,
      metric: q.metric,
      date: dayText(dayMs),
      from: isoTaipei(range.fromMs),
      to: isoTaipei(range.toMs),
      bucketSeconds: range.bucketMs / 1000,
      coverage: { since: data.since === null ? null : isoTaipei(data.since), gaps: gaps.map(gapOut), gapsKnown: known },
      levels,
      cells,
      generatedAt: new Date(t).toISOString(),
    };
  }

  /** 熱 / 冷分界(UTC 毫秒) */
  const hotFloor = (type: SliceType) => taipeiDayOf(now()) - ((type === 'traffic' ? d.ttlDays.traffic : d.ttlDays.threat) - 1) * DAY_MS;

  function validate(q: SliceQuery): { startMs: number; endMs: number } {
    // 對齊到分鐘(API.md §1:時間精確到分鐘);快取與重用的鍵不會因秒數不同而繞過(資安審查 L3)
    const startMs = Math.floor(Date.parse(q.start) / 60_000) * 60_000;
    const endMs = Math.floor(Date.parse(q.end) / 60_000) * 60_000;
    const bad = (field: string, message: string) => new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', [{ field, message }]);
    if (Number.isNaN(startMs)) throw bad('start', '時間不正確');
    if (Number.isNaN(endMs)) throw bad('end', '時間不正確');
    if (endMs <= startMs) throw bad('end', '結束時間必須晚於開始時間');
    if (endMs - startMs > SLICE_MAX_MS) throw bad('end', '時段明細最長 1 天');
    return { startMs, endMs };
  }

  function toResult(q: SliceQuery, type: SliceType, source: SliceResult['source'], data: SliceData, rowsLimit: number, startMs: number, endMs: number, t0: number): SliceResult {
    const { gaps, known } = gapsIn(startMs, endMs);
    const filters = Object.fromEntries(FILTER_KEYS.filter((k) => q[k] !== undefined && q[k] !== '').map((k) => [k, q[k] as string | number]));
    return {
      source,
      type,
      start: isoTaipei(startMs),
      end: isoTaipei(endMs),
      filters,
      summary: data.summary,
      top: data.top,
      rows: data.rows.map((r: LogRecord) => ({ ...r, time: logTimeOut(String(r.time ?? '')) })),
      rowsLimit,
      rowsTruncated: data.more,
      coverage: { partial: gaps.length > 0, gaps: gaps.map(gapOut), gapsKnown: known },
      seconds: Math.round((Date.now() - t0) / 100) / 10,
    };
  }

  /**
   * 送出(或重用)時段明細工作,最多等 30 秒。回 { status: 200, body: 結果 } 或 { status: 202, body: 工作狀態 }。
   * waitMs 只給測試縮短
   */
  async function slice(owner: string, q: SliceQuery, waitMs = SLICE_SYNC_MS): Promise<{ status: 200 | 202; body: unknown }> {
    const type = q.type ?? 'traffic';
    const { startMs, endMs } = validate(q);
    const rowsLimit = q.rows ?? 100;
    const sort = q.sort ?? 'time';
    const floor = hotFloor(type);
    const source: SliceResult['source'] = startMs >= floor ? 'hot' : endMs <= floor ? 'cold' : 'mixed';
    if (source !== 'hot' && !d.cold)
      throw new AppError(
        409,
        'NETOPS_COLD_ARCHIVE_DISABLED',
        `${dayText(floor)} 之前的明細要從冷歸檔(NAS)讀取,冷歸檔尚未提供;可查 ${dayText(floor)} 起的時段,或點熱力圖格子看彙總`,
        { hotFrom: isoTaipei(floor) },
      );
    if (source === 'hot') reader();

    const key = createHash('sha256').update(JSON.stringify([owner, type, startMs, endMs, rowsLimit, sort, FILTER_KEYS.map((k) => q[k] ?? null)])).digest('hex');
    let entry = reuse.get(key);
    if (entry && !entry.id) {
      // 同條件的請求正在等冷查詢鎖 / 送出:等它結束後重新判斷(拿到工作就重用,失敗就自己再試)
      await entry.ready;
      return slice(owner, q, waitMs);
    }
    if (entry) {
      let ok = false;
      try {
        const st = entry.runner.get(entry.id, owner, SLICE_KIND).status;
        ok = st !== 'failed' && st !== 'cancelled';
      } catch {
        /* 已逾期 */
      }
      if (!ok) {
        reuse.delete(key);
        entry = undefined;
      }
    }
    if (!entry) entry = await submit(key, owner, q, { type, startMs, endMs, rowsLimit, sort, floor, source });

    // 等完成或 waitMs;工作被取消(排隊中取消時 run 不會執行)也要結束等待
    const deadline = Date.now() + waitMs;
    for (;;) {
      const st = entry.runner.get(entry.id, owner, SLICE_KIND).status;
      const left = deadline - Date.now();
      if (st === 'done' || st === 'failed' || st === 'cancelled' || left <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([entry.done, new Promise<void>((r) => (timer = setTimeout(r, Math.min(left, 500))))]);
      clearTimeout(timer);
    }
    const view = entry.runner.get<SliceResult>(entry.id, owner, SLICE_KIND);
    if (view.status === 'done') return { status: 200, body: view.result };
    // 30 秒內失敗:直接回原本的錯誤(例:503 ClickHouse 無法使用)
    if (view.status === 'failed' && entry.error) {
      reuse.delete(key);
      throw entry.error.err;
    }
    return { status: 202, body: view };
  }

  /** 建立工作(冷資料先取得冷查詢鎖);送出前先放進 reuse,同條件的併發請求會等這次送出 */
  async function submit(
    key: string,
    owner: string,
    q: SliceQuery,
    o: { type: SliceType; startMs: number; endMs: number; rowsLimit: number; sort: 'time' | 'bytes'; floor: number; source: SliceResult['source'] },
  ): Promise<Entry> {
    let markReady!: () => void;
    let finish!: () => void;
    const entry: Entry = { id: '', runner: o.source === 'hot' ? hotJobs : coldJobs, ready: new Promise<void>((r) => (markReady = r)), done: new Promise<void>((r) => (finish = r)), error: null };
    // 上限:只留最近 200 組條件(工作本身由 JobRunner 管保留期限)
    if (reuse.size >= 200) reuse.delete(reuse.keys().next().value!);
    reuse.set(key, entry);
    const filter: SliceFilter = {
      fromMs: o.startMs,
      toMs: o.endMs,
      ip: q.ip,
      src: q.src,
      dst: q.dst,
      app: q.app,
      fromZone: q.fromZone,
      toZone: q.toZone,
      port: q.dport === undefined ? undefined : String(q.dport),
      action: q.action,
      country: q.country,
      severity: q.severity,
      threatName: q.threatName,
    };
    // 鎖的值加亂數:同條件前一個工作逾時後重送,不會刪到對方的鎖
    const lockId = o.source === 'hot' ? '' : `${key.slice(0, 16)}:${randomUUID()}`;
    try {
      if (lockId) {
        // 冷查詢全系統 1 個(V3);Redis 異常也當成忙碌(不回 5xx)
        let ok = false;
        try {
          ok = Boolean(d.coldLock) && (await d.coldLock!.acquire(lockId));
        } catch {
          ok = false;
        }
        if (!ok) throw Object.assign(new AppError(429, 'NETOPS_COLD_QUERY_BUSY', `已有冷資料查詢在執行,請 ${COLD_RETRY_AFTER_SEC} 秒後再試`, { retryAfter: COLD_RETRY_AFTER_SEC }), { retryAfter: COLD_RETRY_AFTER_SEC });
      }
      const { type, rowsLimit, sort, floor, source } = o;
      let job: JobView<SliceResult>;
      try {
        job = entry.runner.submit<SliceResult>(
          SLICE_KIND,
          owner,
          async ({ signal }) => {
            const t0 = Date.now();
            try {
              // 熱查詢經 60 秒共用快取(inflight 多人共用,所以不帶工作的 signal:取消不會中止已送出的 ClickHouse 查詢,最多 50 秒)
              const hot = (f: SliceFilter) =>
                viaCh(d.log, () => d.cache.cached('pa-slice', { type, f, rowsLimit, sort }, 60, () => reader().slice(type, f, rowsLimit, sort, SLICE_CH_SECONDS)));
              let data: SliceData;
              if (source === 'hot') data = await hot(filter);
              else if (source === 'cold') data = await d.cold!.query(type, filter, rowsLimit, sort, signal);
              else {
                const c = await d.cold!.query(type, { ...filter, toMs: floor }, rowsLimit, sort, signal);
                data = mergeSlices(c, await hot({ ...filter, fromMs: floor }), rowsLimit, sort);
              }
              return toResult(q, type, source, data, rowsLimit, o.startMs, o.endMs, t0);
            } catch (err) {
              entry.error = { err };
              throw err;
            } finally {
              if (lockId) await d.coldLock!.release(lockId);
              finish();
            }
          },
          { timeoutMs: source === 'hot' ? SLICE_JOB_TIMEOUT_MS : COLD_JOB_TIMEOUT_MS },
        );
      } catch (err) {
        if (lockId) await d.coldLock!.release(lockId);
        throw err;
      }
      entry.id = job.id;
      return entry;
    } catch (err) {
      reuse.delete(key);
      throw err;
    } finally {
      markReady();
    }
  }

  return {
    heatmap,
    slice,
    /** 工作狀態(本人);完成時含 result */
    sliceJob: (id: string, owner: string) => jobsOf(id, owner).get<SliceResult>(id, owner, SLICE_KIND),
    /** 取消(冪等):進行中中止,已完成丟棄結果 */
    cancelSlice(id: string, owner: string) {
      try {
        jobsOf(id, owner).cancel(id, owner, SLICE_KIND, { discard: true });
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'NETOPS_JOB_NOT_FOUND') throw err;
      }
    },
    hotFloor,
    close: () => {
      hotJobs.close();
      coldJobs.close();
    },
  };
}

export type HeatService = ReturnType<typeof createHeatService>;
