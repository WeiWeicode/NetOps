/**
 * 時段明細抽屜的狀態(V-b1;VIZ-RULES-DESIGN §6.3、HANDOFF-GEMINI-VIZ §3.2)。熱力圖、儀表板、告警共用。
 *   const s = useSlice()
 *   s.open(q)  → state:loading → done;後端 30 秒內沒完成回 202 時 state = 'waiting-job' 並自動輪詢(useJob)
 *   429(冷查詢忙碌)→ state = 'busy',retryAfter 每秒倒數,到 0 後可 s.retry()
 *   409 / 404(冷歸檔未提供、沒有歸檔檔案)→ state = 'error',error.code 給畫面顯示中性提示
 *   s.isCold:開查前就依時間判斷(畫面先放冷資料過場);s.source:結果的 hot / cold / mixed
 *   s.summary:摘要;威脅類(type=threat)的 bytes / sent / recv 為 null = 不適用(不是 0;C3)
 *   s.supportsSeverity:目前是威脅類(只有威脅類抽屜顯示嚴重度 chip;需求方 2026-11-13 決定)
 *   s.setSeverity(sev):威脅類依嚴重度重查(C4);setSeverity(null) 拿掉嚴重度。流量類不動作
 *   s.searchLink / s.openInSearch(extra?):在 Log 明細查詢開啟同樣條件,extra 為點選的項目(C7;威脅類帶 type=THREAT、threat、severity;
 *     來源 IP 用 filterSrc → src、目的 IP 用 filterDst → dst,不分方向才用 filterIp → ip;
 *     來源國家 filterSrcCountry → srcCountry、目的國家 filterDstCountry → dstCountry,不分方向 filterCountry → country)
 *   網路錯誤或 SLICE_TIMEOUT_MS 內沒有回應 → state = 'error'(逾時為 SliceTimeoutError);s.retryable 為 true 時畫面可給「重試」按鈕呼叫 s.retry()
 * 離開頁面時自動取消進行中的工作(不佔每人 2 個的名額)。
 */
import { computed, getCurrentInstance, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { ApiError } from '@/api/gateway';
import { slice, type SliceJob, type SliceQuery, type SliceResult, type SliceSeverity, type SliceSource } from '@/api/slice';
import { countryRange } from './searchQuery';
import { useJob } from './useJob';
import { dayStartMs, taipeiDay, taipeiLocal } from './vizTime';

export type SliceState = 'idle' | 'loading' | 'waiting-job' | 'done' | 'error' | 'busy';

/** 熱 / 冷分界:預設正式區 TRAFFIC 保留 30 天(29 天內查熱表);收到 409 的 details.hotFrom 後以後端為準 */
const DEFAULT_HOT_DAYS = 29;
const learnedHotFrom = ref<{ hotFrom: string; day: string } | null>(null);
/** 冷查詢忙碌時預設幾秒後重試(後端 details.retryAfter 優先) */
export const DEFAULT_RETRY_SEC = 10;
/** 第一個請求等多久算逾時:後端 30 秒內沒完成會回 202 工作(API.md §4.4),多留 15 秒給 Gateway 與網路 */
export const SLICE_TIMEOUT_MS = 45_000;

/** 時段明細請求逾時(瀏覽器自己的連線逾時可能要好幾分鐘,抽屜會一直停在查詢中) */
export class SliceTimeoutError extends Error {
  constructor() {
    super('查詢時段明細逾時,請重試');
    this.name = 'SliceTimeoutError';
  }
}

/** 摘要:bytes / sent / recv 為 null 表示不適用(威脅類沒有流量欄位;C3) */
export type SliceSummary = Omit<SliceResult['summary'], 'bytes' | 'sent' | 'recv'> & { bytes: number | null; sent: number | null; recv: number | null };

/** openInSearch 的點選項目(C7);和目前的時段明細條件合併,同名條件以點選的為準 */
export interface SearchExtra {
  /** 不分方向的 IP(Log 明細查詢的 ip;來源或目的任一方) */
  filterIp?: string;
  /** 來源 IP(Log 明細查詢的 src) */
  filterSrc?: string;
  /** 目的 IP(Log 明細查詢的 dst) */
  filterDst?: string;
  filterApp?: string;
  filterPort?: number | string;
  /** 不分方向的國家(Log 明細查詢的 country) */
  filterCountry?: string;
  /** 來源國家(srcCountry) */
  filterSrcCountry?: string;
  /** 目的國家(dstCountry) */
  filterDstCountry?: string;
  filterThreat?: string;
  severity?: SliceSeverity;
}

/**
 * 抽屜點選的項目(Top 10 維度或明細表欄位)→ openInSearch 的條件(C7 第二輪):
 *   來源 / 目的 IP → filterSrc / filterDst;來源 / 目的國家 → filterSrcCountry / filterDstCountry;
 *   國家欄位是 PA 填的私有 / 保留網段(例 10.0.0.0-10.255.255.255,C7b)→ 改帶來源 / 目的 IP 的 CIDR;不是單一 CIDR 時回 null(不可點)
 */
export function searchExtraOf(dimKey: string, rawVal: string): SearchExtra | null {
  const val = rawVal.replace(/^約\s+/, '').trim();
  if (!val || val === '—') return null;
  if (dimKey === 'src') return { filterSrc: val };
  if (dimKey === 'dst') return { filterDst: val };
  if (dimKey === 'ip') return { filterIp: val };
  if (dimKey === 'srcCountry' || dimKey === 'dstCountry') {
    const src = dimKey === 'srcCountry';
    const range = countryRange(val);
    if (range) return range.cidr ? (src ? { filterSrc: range.cidr } : { filterDst: range.cidr }) : null;
    return src ? { filterSrcCountry: val } : { filterDstCountry: val };
  }
  if (dimKey === 'app') return { filterApp: val };
  if (dimKey === 'dport') return { filterPort: val };
  if (dimKey === 'name') return { filterThreat: val };
  return null;
}

/** Top 10 項目的顯示文字:國家欄位是網段範圍時顯示「內部網路 10.0.0.0/8」(C7b) */
export const topLabelOf = (dimKey: string, key: string): string =>
  (dimKey === 'srcCountry' || dimKey === 'dstCountry' ? countryRange(key)?.label : undefined) ?? key;

export function useSlice(opts: { now?: () => number; pollMs?: number; timeoutMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? SLICE_TIMEOUT_MS;
  // 元件外(單元測試)沒有 router
  const router = getCurrentInstance() ? useRouter() : null;
  const query = shallowRef<SliceQuery | null>(null);
  const loading = ref(false);
  const direct = shallowRef<SliceResult | null>(null);
  const failure = ref<Error | null>(null);
  const retryAfter = ref(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  /** 進行中的第一個請求(逾時、換條件、關閉時中止) */
  let inflight: AbortController | null = null;
  let runSeq = 0;

  // 202 之後的輪詢:create 只把已拿到的工作交給 useJob
  let pending: SliceJob | null = null;
  const job = useJob<null, SliceResult, Record<string, unknown>>(
    { create: async () => pending!, get: (id) => slice.job(id), cancel: (id) => slice.cancel(id) },
    { pollMs: opts.pollMs },
  );

  const result = computed<SliceResult | null>(() => direct.value ?? job.result.value);
  const error = computed<Error | null>(() => failure.value ?? job.error.value);
  const busy = computed(() => failure.value instanceof ApiError && failure.value.status === 429);
  const state = computed<SliceState>(() => {
    if (loading.value) return 'loading';
    if (busy.value) return 'busy';
    if (result.value) return 'done';
    if (error.value) return 'error';
    if (job.running.value) return 'waiting-job';
    return 'idle';
  });
  const source = computed<SliceSource | null>(() => result.value?.source ?? null);
  /** 開查前依時間判斷是不是冷資料(畫面先放冷資料過場) */
  const isCold = computed(() => {
    const q = query.value;
    if (!q) return false;
    // 後端的分界是「台灣今天 00:00 −(保留天數 − 1)天」;學到的值只用當天的(過了午夜分界會往後移)
    const learned = learnedHotFrom.value && learnedHotFrom.value.day === taipeiDay(now()) ? Date.parse(learnedHotFrom.value.hotFrom) : null;
    const hotFrom = learned ?? dayStartMs(taipeiDay(now())) - DEFAULT_HOT_DAYS * 86_400_000;
    return Date.parse(q.start) < hotFrom;
  });

  function stopCountdown() {
    clearInterval(timer);
    timer = undefined;
  }
  function countdown(sec: number) {
    stopCountdown();
    retryAfter.value = sec;
    timer = setInterval(() => {
      retryAfter.value = Math.max(0, retryAfter.value - 1);
      if (retryAfter.value === 0) stopCountdown();
    }, 1000);
  }

  async function open(q: SliceQuery): Promise<void> {
    return run(q);
  }

  async function run(q: SliceQuery): Promise<void> {
    // 先同步換掉條件,取消舊工作的等待期間連點(例:setSeverity 再點同一個 chip 取消)才看得到新條件(程式碼審查)
    stopCountdown();
    retryAfter.value = 0;
    query.value = q;
    direct.value = null;
    failure.value = null;
    loading.value = true;
    // 每次 run 一個序號:同一個條件物件重跑(retry)時,舊的那次也要當成已被取代(程式碼審查)
    const my = ++runSeq;
    const stale = () => runSeq !== my || query.value !== q;
    await job.cancel();
    if (stale()) return;
    // 逾時或換條件時中止請求(換條件不算錯誤,由 stale() 略過)
    inflight?.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const r = await slice.get(q, { signal: ctrl.signal });
      if (stale()) {
        if (r.kind === 'job') void slice.cancel(r.job.id).catch(() => undefined);
        return;
      }
      if (r.kind === 'result') direct.value = r.result;
      else {
        pending = r.job;
        await job.start(null);
      }
    } catch (e) {
      if (stale()) return;
      failure.value = timedOut ? new SliceTimeoutError() : (e as Error);
      if (e instanceof ApiError) {
        const d = e.details as { retryAfter?: number; hotFrom?: string } | undefined;
        if (e.status === 429) countdown(Number(d?.retryAfter) || DEFAULT_RETRY_SEC);
        if (e.code === 'NETOPS_COLD_ARCHIVE_DISABLED' && typeof d?.hotFrom === 'string') learnedHotFrom.value = { hotFrom: d.hotFrom, day: taipeiDay(now()) };
      }
    } finally {
      clearTimeout(t);
      if (inflight === ctrl) inflight = null;
      if (!stale()) loading.value = false;
    }
  }

  /** 可以直接重試的錯誤:逾時、網路錯誤(fetch 的 TypeError)、5xx(含 202 工作失敗);429 走 busy 倒數,409 / 404 是中性提示不重試 */
  const retryable = computed(() => {
    const e = error.value;
    if (!e || busy.value) return false;
    if (e instanceof SliceTimeoutError || e instanceof TypeError) return true;
    return e instanceof ApiError && e.status >= 500;
  });

  /** 忙碌倒數結束後重試同一個條件(倒數中呼叫不會送出) */
  const retry = (): Promise<void> => (query.value && retryAfter.value === 0 ? run(query.value) : Promise.resolve());

  /** 只有威脅類可以依嚴重度篩選(流量類抽屜不顯示嚴重度 chip;需求方 2026-11-13 決定) */
  const supportsSeverity = computed(() => query.value?.type === 'threat');

  /** 威脅類依嚴重度重查(C4;Top 10 與明細都由後端依嚴重度計算)。null = 拿掉嚴重度;流量類不動作 */
  async function setSeverity(sev: SliceSeverity | null): Promise<void> {
    const q = query.value;
    if (!q || q.type !== 'threat' || (q.severity ?? null) === sev) return;
    const next: SliceQuery = { ...q, severity: sev ?? undefined };
    if (sev === null) delete next.severity;
    return run(next);
  }

  /** 摘要(威脅類的流量欄位為 null = 不適用;C3) */
  const summary = computed<SliceSummary | null>(() => {
    const r = result.value;
    if (!r) return null;
    return r.type === 'threat' ? { ...r.summary, bytes: null, sent: null, recv: null } : r.summary;
  });

  async function close(): Promise<void> {
    inflight?.abort();
    inflight = null;
    stopCountdown();
    retryAfter.value = 0;
    query.value = null;
    direct.value = null;
    failure.value = null;
    loading.value = false;
    await job.cancel();
  }

  /**
   * Log 明細查詢頁的連結(條件格式見 composables/searchQuery.ts,to 含該分鐘;C7):
   * 目前的時段明細條件 + extra(點選的項目);威脅類帶 type=THREAT、threat(威脅名稱)、severity
   */
  function searchTarget(extra: SearchExtra = {}): RouteLocationRaw | null {
    const q = query.value;
    if (!q) return null;
    const cond: Record<string, string> = { from: taipeiLocal(q.start), to: taipeiLocal(new Date(Date.parse(q.end) - 60_000).toISOString()) };
    for (const k of ['ip', 'src', 'dst', 'app', 'fromZone', 'toZone', 'action', 'country'] as const) if (q[k]) cond[k] = String(q[k]);
    if (q.dport !== undefined) cond.port = String(q.dport);
    if (q.type === 'threat') {
      cond.type = 'THREAT';
      if (q.threatName) cond.threat = q.threatName;
      if (q.severity) cond.severity = q.severity;
    }
    const pick: [keyof SearchExtra, string][] = [
      ['filterIp', 'ip'],
      ['filterSrc', 'src'],
      ['filterDst', 'dst'],
      ['filterApp', 'app'],
      ['filterPort', 'port'],
      ['filterCountry', 'country'],
      ['filterSrcCountry', 'srcCountry'],
      ['filterDstCountry', 'dstCountry'],
      ['filterThreat', 'threat'],
      ['severity', 'severity'],
    ];
    for (const [k, to] of pick) {
      const v = extra[k];
      if (v !== undefined && String(v).trim() !== '') cond[to] = String(v).trim();
    }
    // 點了 IP 時,和目前的來源 / 目的 IP 條件可能互相矛盾,以點選的為準
    if (extra.filterIp) {
      delete cond.src;
      delete cond.dst;
    }
    return { path: '/firewall/search', query: cond };
  }
  const searchLink = computed<RouteLocationRaw | null>(() => searchTarget());
  const openInSearch = async (extra?: SearchExtra): Promise<void> => {
    const to = searchTarget(extra);
    if (to && router) await router.push(to);
  };

  if (getCurrentScope())
    onScopeDispose(() => {
      inflight?.abort();
      stopCountdown();
    });

  return { query, state, source, isCold, result, summary, error, retryable, retryAfter, open, retry, close, supportsSeverity, setSeverity, cancel: () => job.cancel(), searchLink, searchTarget, openInSearch, job: job.job };
}
