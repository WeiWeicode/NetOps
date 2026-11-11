/**
 * ClickHouse 每小時摘要(C3;ARCHITECTURE D29、D42):總覽的 27 種排行、疑似掃描、安全事件的 KPI 與排行,
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
import { ClickHouseError } from '../../infra/clickhouse/index.js';
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
/** 某一小時建失敗後,多久內不再重試(避免同一小時每輪都重掃;資安審查 M1) */
const RETRY_MS = 30 * 60_000;
/** 多久沒成功跑完一輪就視為過期(查詢改走 FTP 或回 503;程式碼審查 #2) */
const staleMs = (minutes: number) => Math.max(3 * minutes, 15) * 60_000;

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
  /** 上一輪建失敗的小時數(RETRY_MS 後重試) */
  failed: number;
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
   * until = 已結束小時的上限(之後的小時還沒有排行)。
   * 還沒成功跑完一輪、或太久沒成功(ClickHouse 停止)時丟 ClickHouseError:不回看起來正常的空結果(AGENT.md §5),
   * 來源 auto 時呼叫端改用 FTP、指定 clickhouse 時回 503。每讀幾份就讓出事件迴圈
   */
  summaries(kind: ChKind, fromMs: number, toMs: number): Promise<{ list: unknown[]; missing: number; until: number }>;
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
  const st: ChSummaryStatus = { busy: false, lastRunAt: null, lastError: null, pending: 0, failed: 0 };
  /** 上一輪成功跑完的時間(null = 還沒有) */
  let lastOkAt: number | null = null;
  /** 建失敗的小時:kind/代號 → 可重試的時間 */
  const failedUntil = new Map<string, number>();
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
    const sig = stopper.signal;
    const first = await reader.earliestTrafficHour(sig);
    const next = new Map<string, Map<string, number>>(CH_KINDS.map((k) => [k, new Map()]));
    const hours = new Map<number, number>();
    for (const r of await reader.trafficHours(since, end, sig)) hours.set(r.hour, (hours.get(r.hour) ?? 0) + r.n);
    for (const [h, n] of hours) next.get('traffic')!.set(hourId(h), n);
    for (const r of await reader.threatHourCounts(since, end, sig)) next.get(r.type)!.set(hourId(r.hour), r.n);
    earliest = first;
    counts = next;
    until = end;

    // 要建的:有資料、沒有摘要或筆數變了;新的小時先建
    const todo: { kind: ChKind; hour: number; count: number }[] = [];
    for (const kind of CH_KINDS)
      for (const [id, n] of next.get(kind)!)
        if (n > 0 && index.kinds[kind]![id]?.count !== n && (failedUntil.get(cacheKey(kind, id)) ?? 0) <= t0) todo.push({ kind, hour: idToMs(id), count: n });
    todo.sort((a, b) => b.hour - a.hour);

    // 清除:超出保留範圍,或範圍內已經沒有資料(TTL、去重後刪除);
    // 這一輪該類型整個查不到資料時(彙總表暫時空等)只清超出範圍的,不清光(程式碼審查 #11)
    const sinceId = hourId(since);
    for (const kind of CH_KINDS) {
      const hasData = next.get(kind)!.size > 0;
      for (const id of Object.keys(index.kinds[kind]!))
        if (id < sinceId || (hasData && id < hourId(end) && !next.get(kind)!.has(id))) {
          store.removeChSummary(kind, id);
          cache.delete(cacheKey(kind, id));
          delete index.kinds[kind]![id];
        }
    }
    store.saveChSummaryIndex(index);

    // 一小時失敗(例如單一秒超過讀取上限)不中斷整輪,記下來 RETRY_MS 後再試(資安審查 M1、程式碼審查 #13)
    let done = 0;
    let failed = 0;
    let lastErr: unknown = null;
    for (const j of todo) {
      if (sig.aborted || now() - t0 > BUDGET_MS) break;
      try {
        await build(j.kind, j.hour, j.count);
        failedUntil.delete(cacheKey(j.kind, hourId(j.hour)));
        done++;
      } catch (err) {
        if (sig.aborted) throw err;
        failed++;
        lastErr = err;
        failedUntil.set(cacheKey(j.kind, hourId(j.hour)), now() + RETRY_MS);
        log.warn({ kind: j.kind, hour: hourId(j.hour), ...errInfo(err) }, 'ClickHouse 每小時摘要建立失敗');
      }
    }
    for (const [k, t] of failedUntil) if (t < t0 - RETRY_MS) failedUntil.delete(k);
    st.pending = todo.length - done;
    st.failed = failed;
    if (done) log.info({ built: done, pending: st.pending, failed, ms: now() - t0 }, 'ClickHouse 每小時摘要已更新');
    // 查詢都成功、只有個別小時失敗:這一輪仍算成功(那些小時在總覽算 missing)
    if (lastErr && !done && failed === todo.length) throw lastErr;
  }

  function runOnce(): Promise<void> {
    running ??= (async () => {
      st.busy = true;
      try {
        await run();
        st.lastError = null;
        lastOkAt = now();
      } catch (err) {
        // 失敗只記錄,下一輪重試;太久沒成功時 summaries() 丟錯(AGENT.md §5)。
        // 日誌只記錯誤代碼:ClickHouse 的錯誤原文可能帶 log 內容(資安審查 L2)
        const info = errInfo(err);
        st.lastError = `ClickHouse 每小時摘要更新失敗(${info.code ?? info.status ?? info.name})`;
        if (!stopper.signal.aborted) log.warn(info, 'ClickHouse 每小時摘要更新失敗');
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
    async summaries(kind, fromMs, toMs) {
      if (until === null || lastOkAt === null) throw new ClickHouseError('ClickHouse 每小時摘要尚未建立', undefined, undefined);
      if (minutes && now() - lastOkAt > staleMs(minutes)) throw new ClickHouseError('ClickHouse 每小時摘要已過期(資料庫可能停止)', undefined, undefined);
      const metas = index.kinds[kind] ?? {};
      const known = counts.get(kind) ?? new Map<string, number>();
      const list: unknown[] = [];
      let missing = 0;
      let reads = 0;
      for (let h = hourStartMs(fromMs); h < toMs; h += HOUR_MS) {
        const id = hourId(h);
        const meta = metas[id];
        const n = known.get(id);
        // 每小時最多算一次 missing(程式碼審查 #4)
        if (!meta) {
          if (n) missing++;
          continue;
        }
        const key = cacheKey(kind, id);
        let s = cache.get(key);
        if (s === undefined) {
          s = store.readChSummary(kind, id);
          if (s) {
            if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
            cache.set(key, s);
          }
          // 讀檔解壓是同步的:每讀 24 份讓出一次事件迴圈(程式碼審查 #3)
          if (++reads % 24 === 0) await new Promise((r) => setImmediate(r));
        }
        if (s) list.push(s);
        if (!s || (n !== undefined && meta.count !== n)) missing++;
      }
      return { list, missing, until };
    },
  };
}

/** 日誌用:只留錯誤代碼與分類,不留 ClickHouse 錯誤原文 */
function errInfo(err: unknown): { code?: number; status?: number; name: string } {
  const e = err as { code?: unknown; status?: unknown; name?: string };
  return { code: typeof e?.code === 'number' ? e.code : undefined, status: typeof e?.status === 'number' ? e.status : undefined, name: e?.name ?? 'Error' };
}

/** 'YYYYMMDDHH'(台灣時間)→ UTC 毫秒 */
function idToMs(id: string): number {
  return Date.parse(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(8, 10)}:00:00+08:00`);
}
