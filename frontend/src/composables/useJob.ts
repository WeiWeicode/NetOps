/**
 * 工作模式的共用寫法(docs/API.md §1.1):
 *   const j = useJob({ create: (body) => api.create(body), get: api.get, cancel: api.cancel })
 *   await j.start(body)  → 建立工作後每 1.5 秒查詢,結束(done / failed / cancelled)時停止
 *   j.job.value(最新狀態)、j.result.value(done 時)、j.error.value(建立或查詢失敗、工作失敗)
 * 離開頁面(scope 結束)時停止查詢並取消尚未結束的工作,不佔用每人 2 個的名額。
 */
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import { ApiError } from '@/api/gateway';
import { isFinished, JOB_ERROR, type Job } from '@/api/jobs';

export interface JobApi<B, R, P> {
  create: (body: B) => Promise<Job<R, P>>;
  get: (id: string) => Promise<Job<R, P>>;
  cancel: (id: string) => Promise<unknown>;
}

export const POLL_MS = 1500;

export function useJob<B, R, P = Record<string, number>>(api: JobApi<B, R, P>, opts: { pollMs?: number } = {}) {
  const job = shallowRef<Job<R, P> | null>(null);
  const error = ref<Error | null>(null);
  const starting = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 每次 start 遞增;舊的查詢結果回來時直接丟棄
  let seq = 0;

  const running = computed(() => starting.value || (!!job.value && !isFinished(job.value.status)));
  const result = computed(() => (job.value?.status === 'done' ? job.value.result : null));

  function stop() {
    clearTimeout(timer);
    timer = undefined;
  }

  /** 錯誤代碼有說明文字時換成說明(保留 requestId) */
  function explain(e: unknown): Error {
    if (!(e instanceof ApiError)) return e as Error;
    const text = JOB_ERROR[e.code];
    return text ? new ApiError(e.status, e.code, text, e.requestId, e.details) : e;
  }

  function fail(e: unknown) {
    error.value = explain(e);
  }

  /** 取消伺服器上的工作(冪等);失敗不影響畫面,工作會在逾時後自行結束 */
  const release = (id: string) => api.cancel(id).catch(() => undefined);

  async function poll(my: number, id: string) {
    try {
      const j = await api.get(id);
      if (my !== seq) return;
      job.value = j;
      if (j.status === 'failed' && j.error) fail(new ApiError(500, j.error.code, JOB_ERROR[j.error.code] ?? j.error.message, null));
      if (!isFinished(j.status)) timer = setTimeout(() => poll(my, id), opts.pollMs ?? POLL_MS);
    } catch (e) {
      if (my !== seq) return;
      fail(e);
      // 查不到(失效)或連線失敗:停止輪詢,畫面不再顯示進行中
      const j = job.value;
      if (j && !isFinished(j.status)) job.value = { ...j, status: 'failed' };
    }
  }

  async function start(body: B): Promise<void> {
    void cancel();
    const my = ++seq;
    error.value = null;
    job.value = null;
    starting.value = true;
    try {
      const j = await api.create(body);
      // 建立期間已取消或重新送出:這個工作沒人要了,取消它以免佔用名額
      if (my !== seq) {
        if (!isFinished(j.status)) void release(j.id);
        return;
      }
      job.value = j;
      if (!isFinished(j.status)) timer = setTimeout(() => poll(my, j.id), opts.pollMs ?? POLL_MS);
    } catch (e) {
      if (my === seq) fail(e);
    } finally {
      if (my === seq) starting.value = false;
    }
  }

  /** 取消進行中的工作(冪等);已結束的不呼叫 API */
  async function cancel(): Promise<void> {
    stop();
    seq++;
    starting.value = false;
    const j = job.value;
    if (!j || isFinished(j.status)) return;
    job.value = { ...j, status: 'cancelled' };
    await release(j.id);
  }

  if (getCurrentScope()) onScopeDispose(() => void cancel());

  return { job, result, error, running, start, cancel };
}
