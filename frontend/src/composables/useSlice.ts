/**
 * 時段明細抽屜的狀態(V-b1;VIZ-RULES-DESIGN §6.3、HANDOFF-GEMINI-VIZ §3.2)。熱力圖、儀表板、告警共用。
 *   const s = useSlice()
 *   s.open(q)  → state:loading → done;後端 30 秒內沒完成回 202 時 state = 'waiting-job' 並自動輪詢(useJob)
 *   429(冷查詢忙碌)→ state = 'busy',retryAfter 每秒倒數,到 0 後可 s.retry()
 *   409 / 404(冷歸檔未提供、沒有歸檔檔案)→ state = 'error',error.code 給畫面顯示中性提示
 *   s.isCold:開查前就依時間判斷(畫面先放冷資料過場);s.source:結果的 hot / cold / mixed
 *   s.searchLink / s.openInSearch():在 Log 明細查詢開啟同樣條件(只限 TRAFFIC)
 * 離開頁面時自動取消進行中的工作(不佔每人 2 個的名額)。
 */
import { computed, getCurrentInstance, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { ApiError } from '@/api/gateway';
import { slice, type SliceJob, type SliceQuery, type SliceResult, type SliceSource } from '@/api/slice';
import { useJob } from './useJob';
import { dayStartMs, taipeiDay, taipeiLocal } from './vizTime';

export type SliceState = 'idle' | 'loading' | 'waiting-job' | 'done' | 'error' | 'busy';

/** 熱 / 冷分界:預設正式區 TRAFFIC 保留 30 天(29 天內查熱表);收到 409 的 details.hotFrom 後以後端為準 */
const DEFAULT_HOT_DAYS = 29;
const learnedHotFrom = ref<{ hotFrom: string; day: string } | null>(null);
/** 冷查詢忙碌時預設幾秒後重試(後端 details.retryAfter 優先) */
export const DEFAULT_RETRY_SEC = 10;

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

  async function open(q: SliceQuery): Promise<void> {
    await job.cancel();
    stopCountdown();
    retryAfter.value = 0;
    query.value = q;
    direct.value = null;
    failure.value = null;
    loading.value = true;
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
  const retry = (): Promise<void> => (query.value && retryAfter.value === 0 ? open(query.value) : Promise.resolve());

  async function close(): Promise<void> {
    stopCountdown();
    retryAfter.value = 0;
    query.value = null;
    direct.value = null;
    failure.value = null;
    loading.value = false;
    await job.cancel();
  }

  /** Log 明細查詢頁的連結(只限 TRAFFIC;條件格式見 composables/searchQuery.ts,to 含該分鐘) */
  const searchLink = computed<RouteLocationRaw | null>(() => {
    const q = query.value;
    if (!q || (q.type ?? 'traffic') !== 'traffic') return null;
    const cond: Record<string, string> = { from: taipeiLocal(q.start), to: taipeiLocal(new Date(Date.parse(q.end) - 60_000).toISOString()) };
    for (const k of ['ip', 'src', 'dst', 'app', 'fromZone', 'toZone', 'action', 'country'] as const) if (q[k]) cond[k] = String(q[k]);
    if (q.dport !== undefined) cond.port = String(q.dport);
    return { path: '/firewall/search', query: cond };
  });
  const openInSearch = async (): Promise<void> => {
    if (searchLink.value && router) await router.push(searchLink.value);
  };

  if (getCurrentScope()) onScopeDispose(stopCountdown);

  return { query, state, source, isCold, result, error, retryAfter, open, retry, close, cancel: () => job.cancel(), searchLink, openInSearch, job: job.job };
}
