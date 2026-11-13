/**
 * 時段明細抽屜的狀態(V-b1;VIZ-RULES-DESIGN §6.3、HANDOFF-GEMINI-VIZ §3.2)。熱力圖、儀表板、告警共用。
 *   const s = useSlice()
 *   s.open(q)  → state:loading → done;後端 30 秒內沒完成回 202 時 state = 'waiting-job' 並自動輪詢(useJob)
 *   429(冷查詢忙碌)→ state = 'busy',retryAfter 每秒倒數,到 0 後可 s.retry()
 *   409 / 404(冷歸檔未提供、沒有歸檔檔案)→ state = 'error',error.code 給畫面顯示中性提示
 *   s.isCold:開查前就依時間判斷(畫面先放冷資料過場);s.source:結果的 hot / cold / mixed
 *   s.summary:摘要;威脅類(type=threat)的 bytes / sent / recv 為 null = 不適用(不是 0;C3)
 *   s.setSeverity(sev):依嚴重度重查(C4)。威脅類只加 severity;流量類切成威脅類,只保留 IP 條件(同摘要 threats 的計算範圍);
 *     setSeverity(null) 回到點嚴重度之前的條件
 *   s.searchLink / s.openInSearch(extra?):在 Log 明細查詢開啟同樣條件,extra 為點選的項目(C7;威脅類帶 type=THREAT、threat、severity)
 * 離開頁面時自動取消進行中的工作(不佔每人 2 個的名額)。
 */
import { computed, getCurrentInstance, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { ApiError } from '@/api/gateway';
import { slice, type SliceJob, type SliceQuery, type SliceResult, type SliceSeverity, type SliceSource } from '@/api/slice';
import { useJob } from './useJob';
import { dayStartMs, taipeiDay, taipeiLocal } from './vizTime';

export type SliceState = 'idle' | 'loading' | 'waiting-job' | 'done' | 'error' | 'busy';

/** 熱 / 冷分界:預設正式區 TRAFFIC 保留 30 天(29 天內查熱表);收到 409 的 details.hotFrom 後以後端為準 */
const DEFAULT_HOT_DAYS = 29;
const learnedHotFrom = ref<{ hotFrom: string; day: string } | null>(null);
/** 冷查詢忙碌時預設幾秒後重試(後端 details.retryAfter 優先) */
export const DEFAULT_RETRY_SEC = 10;

/** 摘要:bytes / sent / recv 為 null 表示不適用(威脅類沒有流量欄位;C3) */
export type SliceSummary = Omit<SliceResult['summary'], 'bytes' | 'sent' | 'recv'> & { bytes: number | null; sent: number | null; recv: number | null };

/** openInSearch 的點選項目(C7);和目前的時段明細條件合併,同名條件以點選的為準 */
export interface SearchExtra {
  filterIp?: string;
  filterApp?: string;
  filterPort?: number | string;
  filterCountry?: string;
  filterThreat?: string;
  severity?: SliceSeverity;
}

export function useSlice(opts: { now?: () => number; pollMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  // 元件外(單元測試)沒有 router
  const router = getCurrentInstance() ? useRouter() : null;
  const query = shallowRef<SliceQuery | null>(null);
  const loading = ref(false);
  const direct = shallowRef<SliceResult | null>(null);
  const failure = ref<Error | null>(null);
  const retryAfter = ref(0);
  let timer: ReturnType<typeof setInterval> | undefined;

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

  /** 點嚴重度之前的條件(setSeverity(null) 回到這裡;open 新條件時清掉) */
  let severityBase: SliceQuery | null = null;

  async function open(q: SliceQuery): Promise<void> {
    severityBase = null;
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
    await job.cancel();
    if (query.value !== q) return;
    const my = q;
    try {
      const r = await slice.get(q);
      if (query.value !== my) {
        if (r.kind === 'job') void slice.cancel(r.job.id).catch(() => undefined);
        return;
      }
      if (r.kind === 'result') direct.value = r.result;
      else {
        pending = r.job;
        await job.start(null);
      }
    } catch (e) {
      if (query.value !== my) return;
      failure.value = e as Error;
      if (e instanceof ApiError) {
        const d = e.details as { retryAfter?: number; hotFrom?: string } | undefined;
        if (e.status === 429) countdown(Number(d?.retryAfter) || DEFAULT_RETRY_SEC);
        if (e.code === 'NETOPS_COLD_ARCHIVE_DISABLED' && typeof d?.hotFrom === 'string') learnedHotFrom.value = { hotFrom: d.hotFrom, day: taipeiDay(now()) };
      }
    } finally {
      if (query.value === my) loading.value = false;
    }
  }

  /** 忙碌倒數結束後重試同一個條件(倒數中呼叫不會送出) */
  const retry = (): Promise<void> => (query.value && retryAfter.value === 0 ? run(query.value) : Promise.resolve());

  /** 依嚴重度重查(C4;Top 10 與明細都由後端依嚴重度計算)。null = 取消,回到點嚴重度之前的條件 */
  async function setSeverity(sev: SliceSeverity | null): Promise<void> {
    const q = query.value;
    if (!q || (q.severity ?? null) === sev) return;
    if (sev === null) {
      const base: SliceQuery = { ...(severityBase ?? q) };
      delete base.severity;
      severityBase = null;
      return run(base);
    }
    severityBase ??= q;
    const base = severityBase;
    const next: SliceQuery =
      (base.type ?? 'traffic') === 'threat'
        ? { ...base, severity: sev }
        : // 流量類的摘要 threats 只套用 IP 條件(API.md §4.4),切成威脅類時條件一致
          { start: base.start, end: base.end, type: 'threat', severity: sev, ip: base.ip, src: base.src, dst: base.dst, rows: base.rows };
    for (const k of Object.keys(next) as (keyof SliceQuery)[]) if (next[k] === undefined) delete next[k];
    return run(next);
  }

  /** 摘要(威脅類的流量欄位為 null = 不適用;C3) */
  const summary = computed<SliceSummary | null>(() => {
    const r = result.value;
    if (!r) return null;
    return r.type === 'threat' ? { ...r.summary, bytes: null, sent: null, recv: null } : r.summary;
  });

  async function close(): Promise<void> {
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
      ['filterApp', 'app'],
      ['filterPort', 'port'],
      ['filterCountry', 'country'],
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

  if (getCurrentScope()) onScopeDispose(stopCountdown);

  return { query, state, source, isCold, result, summary, error, retryAfter, open, retry, close, setSeverity, cancel: () => job.cancel(), searchLink, searchTarget, openInSearch, job: job.job };
}
