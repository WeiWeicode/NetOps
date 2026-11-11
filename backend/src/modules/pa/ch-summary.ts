/**
 * ClickHouse 每小時摘要(C3;ARCHITECTURE D29、D34):總覽的 27 種排行、疑似掃描、安全事件的 KPI 與排行,
 * 每小時彙總表(pa_traffic_hourly_app / src)只涵蓋 App、區域、來源 IP,其餘要掃原始 log(一天約 9 秒,超過路由逾時)。
 * 所以背景每 N 分鐘把「已結束的小時」從 ClickHouse 原始 log 逐列讀出,餵給和 FTP 相同的摘要邏輯
 * (core/palog.js createSummary、pa-events core/paevents.js createEventSummary),存成每小時一份摘要(infra/store);
 * 總覽合併這些摘要(mergeSummaries / mergeEventSummaries),結果格式與 FTP 來源相同。
 *
 *   - 一小時結束 3 分鐘後(寫入批次延遲)才建;每小時彙總的筆數變了(晚到、FTP 補漏、去重)就重建
 *   - 只建最近 days 天(和 ClickHouse 保留期限相同),更早的摘要清除
 *   - 單一容器、程序內執行(D9);每輪最多執行 BUDGET_MS,沒建完的下一輪繼續(新的小時先建)
 *   - 不新增 ClickHouse 表(C3 不動彙總表設計;需求方 2026-11-11)
 */
import type { ClickHouseReader, ChEventType } from '../../infra/clickhouse/reader.js';
import { CH_EVENT_TYPES } from '../../infra/clickhouse/reader.js';
import type { PaStore } from '../../infra/store/index.js';
import { HOUR_MS, hourStartMs, taipeiHourKey } from '../../shared/time.js';
import { createSummary } from './core/palog.js';
import { createEventSummary } from '../pa-events/core/paevents.js';

export type ChKind = 'traffic' | ChEventType;
export const CH_KINDS: readonly ChKind[] = ['traffic', ...CH_EVENT_TYPES];

/** 一小時結束後多久才建(netops-ingest 每 5 秒一批,留 3 分鐘) */
export const GRACE_MS = 3 * 60_000;
/** 每輪最多執行多久 */
const BUDGET_MS = 4 * 60_000;
/** 記憶體內保留幾份已讀的摘要(同 FTP 摘要的快取) */
const CACHE_MAX = 400;
const INDEX_VERSION = 1;

interface Meta {
  /** 建立時每小時彙總(TRAFFIC)或原始表(威脅類)的筆數;和最新的不同就重建 */
  count: number;
  /** 實際讀到的原始列數 */
  rows: number;
  builtAt: string;
}
interface Index {
  version: number;
  kinds: Record<string, Record<string, Meta>>;
}

/** UTC 毫秒 → 摘要代號 'YYYYMMDDHH'(台灣時間) */
export const hourId = (ms: number) => taipeiHourKey(ms).replace(/\D/g, '');

export interface ChSummaryStatus {
  busy: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  /** 上一輪結束時還沒建好的小時數 */
  pending: number;
}

export interface ChSummaryBuilder {
  start(): void;
  stop(): Promise<void>;
  /** 跑一輪(測試與手動用);同時只會有一輪 */
  runOnce(): Promise<void>;
  status(): ChSummaryStatus;
  /** 每小時彙總最早的小時(上一輪查到的;沒有資料或還沒跑過為 null) */
  earliest(): number | null;
  /**
   * 期間 [fromMs, toMs) 內已建好的摘要;missing = 已結束、有資料但摘要還沒建好(或過期)的小時數;
   * until = 已結束小時的上限(之後的小時還沒有摘要,排行只到這裡)
   */
  summaries(kind: ChKind, fromMs: number, toMs: number): { list: unknown[]; missing: number; until: number | null };
}

export function createChSummaryBuilder({
  reader,
  store,
  log,
  days,
  minutes,
  now: nowOpt,
}: {
  reader: ClickHouseReader;
  store: PaStore;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
  days: number;
  minutes: number;
  now?: () => number;
}): ChSummaryBuilder {
  const now = nowOpt ?? Date.now;
  const loaded = store.loadChSummaryIndex<Index>();
  const index: Index = loaded?.version === INDEX_VERSION ? loaded : { version: INDEX_VERSION, kinds: {} };
  for (const k of CH_KINDS) index.kinds[k] ??= {};
  /** 上一輪查到的每小時筆數(kind → 代號 → 筆數)與已結束小時的上限 */
  let counts = new Map<string, Map<string, number>>();
  let until: number | null = null;
  let earliest: number | null = null;
  const cache = new Map<string, unknown>();
  const st: ChSummaryStatus = { busy: false, lastRunAt: null, lastError: null, pending: 0 };
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const stopper = new AbortController();

  const cacheKey = (kind: string, id: string) => `${kind}/${id}`;

  async function build(kind: ChKind, hour: number, count: number) {
    const id = hourId(hour);
    let rows: number;
    let summary: unknown;
    if (kind === 'traffic') {
      const s = createSummary();
      rows = await reader.trafficRecords(hour, hour + HOUR_MS, (r) => s.add(r as never), stopper.signal);
      summary = s.result();
    } else {
      const s = createEventSummary(kind);
      rows = await reader.threatRecords(kind, hour, hour + HOUR_MS, (r) => s.add(r as never), stopper.signal);
      summary = s.result();
    }
    store.saveChSummary(kind, id, summary);
    cache.delete(cacheKey(kind, id));
    index.kinds[kind]![id] = { count, rows, builtAt: new Date(now()).toISOString() };
    store.saveChSummaryIndex(index);
  }

  async function run() {
    const t0 = now();
    const since = hourStartMs(t0 - days * 86_400_000);
    const end = hourStartMs(t0 - GRACE_MS);
    earliest = await reader.earliestTrafficHour();
    const next = new Map<string, Map<string, number>>(CH_KINDS.map((k) => [k, new Map()]));
    const hours = new Map<number, number>();
    for (const r of await reader.trafficHours(since, end)) hours.set(r.hour, (hours.get(r.hour) ?? 0) + r.n);
    for (const [h, n] of hours) next.get('traffic')!.set(hourId(h), n);
    for (const r of await reader.threatHourCounts(since, end)) next.get(r.type)!.set(hourId(r.hour), r.n);
    counts = next;
    until = end;

    // 要建的:有資料、沒有摘要或筆數變了;新的小時先建
    const todo: { kind: ChKind; hour: number; count: number }[] = [];
    for (const kind of CH_KINDS)
      for (const [id, n] of next.get(kind)!) if (n > 0 && index.kinds[kind]![id]?.count !== n) todo.push({ kind, hour: idToMs(id), count: n });
    todo.sort((a, b) => b.hour - a.hour);

    // 清除:超出保留範圍,或範圍內已經沒有資料(TTL、去重後刪除)
    const sinceId = hourId(since);
    for (const kind of CH_KINDS)
      for (const id of Object.keys(index.kinds[kind]!))
        if (id < sinceId || (id < hourId(end) && !next.get(kind)!.has(id))) {
          store.removeChSummary(kind, id);
          cache.delete(cacheKey(kind, id));
          delete index.kinds[kind]![id];
        }
    store.saveChSummaryIndex(index);

    let done = 0;
    for (const j of todo) {
      if (stopper.signal.aborted || now() - t0 > BUDGET_MS) break;
      await build(j.kind, j.hour, j.count);
      done++;
    }
    st.pending = todo.length - done;
    if (done) log.info({ built: done, pending: st.pending, ms: now() - t0 }, 'ClickHouse 每小時摘要已更新');
  }

  function runOnce(): Promise<void> {
    running ??= (async () => {
      st.busy = true;
      try {
        await run();
        st.lastError = null;
      } catch (err) {
        // 失敗只記錄,下一輪重試;總覽依 missing 標示不完整(AGENT.md §5)
        st.lastError = (err as Error).message.slice(0, 200);
        if (!stopper.signal.aborted) log.warn({ err: st.lastError }, 'ClickHouse 每小時摘要更新失敗');
      } finally {
        st.busy = false;
        st.lastRunAt = new Date(now()).toISOString();
        running = null;
      }
    })();
    return running;
  }

  return {
    start() {
      if (!minutes || timer) return;
      void runOnce();
      timer = setInterval(() => void runOnce(), minutes * 60_000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      stopper.abort();
      await running?.catch(() => undefined);
    },
    runOnce,
    status: () => ({ ...st }),
    earliest: () => earliest,
    summaries(kind, fromMs, toMs) {
      const metas = index.kinds[kind] ?? {};
      const known = counts.get(kind) ?? new Map<string, number>();
      const list: unknown[] = [];
      let missing = 0;
      for (let h = hourStartMs(fromMs); h < toMs; h += HOUR_MS) {
        const id = hourId(h);
        const meta = metas[id];
        const n = known.get(id);
        if (meta) {
          const key = cacheKey(kind, id);
          let s = cache.get(key);
          if (s === undefined) {
            s = store.readChSummary(kind, id);
            if (s) {
              if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
              cache.set(key, s);
            }
          }
          if (s) list.push(s);
          else missing++;
          if (n !== undefined && meta.count !== n) missing++;
        } else if (n) missing++;
      }
      return { list, missing, until };
    },
  };
}

/** 'YYYYMMDDHH'(台灣時間)→ UTC 毫秒 */
function idToMs(id: string): number {
  return Date.parse(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(8, 10)}:00:00+08:00`);
}
