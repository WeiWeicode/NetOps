/**
 * PA 精準查詢的狀態(C5;docs/API.md §3.3)。即時監控頁、熱力圖 / 儀表板的「查詢該 IP 當下 PA 即時連線」共用。
 *   const q = usePaQuery()
 *   q.canQuery    有按鈕權限(netops.pa-live.query,只給 netops-admin)才 true;沒有權限時不呼叫任何 API
 *   q.refreshState() → q.ready(執行者啟用、名額空、沒有冷卻)、q.waitSec(還要等幾秒)、q.mgmtCpu
 *   q.session(ip, 'src' | 'dst') / q.recentLog(ip, minutes ≤ 15, 'traffic' | 'threat')
 *   q.state:idle → submitting → waiting(每 2 秒輪詢,最多 90 秒)→ done / failed / rejected / busy(429,retryAfter 倒數)/ error
 * 一次只追蹤一個工作;離開頁面時停止輪詢(PA 上的工作由 netops-pa 依 60 秒上限結束)。
 */
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import { ApiError, can } from '@/api/gateway';
import { paQuery, type PaQueryBody, type PaQueryJob, type PaQueryState } from '@/api/paQuery';
import { UI } from '@/api/perms';

export type PaQueryUiState = 'idle' | 'submitting' | 'waiting' | 'done' | 'failed' | 'rejected' | 'busy' | 'error';
export const POLL_MS = 2000;
/** 輪詢上限:工作 60 秒 + 排隊與收尾 */
export const WAIT_MAX_MS = 90_000;
export const MAX_MINUTES = 15;

export function usePaQuery(opts: { pollMs?: number; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? POLL_MS;
  const canQuery = computed(() => can(UI.paLiveQuery));
  const server = shallowRef<PaQueryState | null>(null);
  const job = shallowRef<PaQueryJob | null>(null);
  const error = ref<Error | null>(null);
  const submitting = ref(false);
  const retryAfter = ref(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let countdown: ReturnType<typeof setInterval> | undefined;
  let seq = 0;
  let deadline = 0;

  const waitSec = computed(() => Math.max(retryAfter.value, server.value ? Math.max(server.value.activeSec, server.value.globalCoolSec, server.value.userCoolSec) : 0));
  const ready = computed(() => canQuery.value && !!server.value?.enabled && waitSec.value === 0 && !submitting.value && state.value !== 'waiting');
  const state = computed<PaQueryUiState>(() => {
    if (submitting.value) return 'submitting';
    if (retryAfter.value > 0) return 'busy';
    if (error.value) return 'error';
    const s = job.value?.status;
    if (s === 'queued' || s === 'running') return 'waiting';
    if (s === 'done' || s === 'failed' || s === 'rejected') return s;
    return 'idle';
  });

  function stopCountdown() {
    clearInterval(countdown);
    countdown = undefined;
  }
  function startCountdown(sec: number) {
    stopCountdown();
    retryAfter.value = sec;
    countdown = setInterval(() => {
      retryAfter.value = Math.max(0, retryAfter.value - 1);
      if (!retryAfter.value) stopCountdown();
    }, 1000);
  }

  async function refreshState(): Promise<void> {
    if (!canQuery.value) return;
    try {
      server.value = await paQuery.status();
    } catch (e) {
      error.value = e as Error;
    }
  }

  async function poll(my: number) {
    if (my !== seq || !job.value) return;
    try {
      const j = await paQuery.job(job.value.id);
      if (my !== seq) return;
      job.value = j;
      if ((j.status === 'queued' || j.status === 'running') && now() < deadline) timer = setTimeout(() => void poll(my), pollMs);
      else if (j.status === 'queued' || j.status === 'running') error.value = new Error('PA 查詢等候逾時,請稍後再看結果或重新送出');
      else void refreshState();
    } catch (e) {
      if (my === seq) error.value = e as Error;
    }
  }

  async function submit(b: PaQueryBody): Promise<void> {
    if (!canQuery.value) return;
    clearTimeout(timer);
    const my = ++seq;
    error.value = null;
    job.value = null;
    submitting.value = true;
    try {
      const j = await paQuery.submit(b);
      if (my !== seq) return;
      job.value = j;
      deadline = now() + WAIT_MAX_MS;
      timer = setTimeout(() => void poll(my), pollMs);
    } catch (e) {
      if (my !== seq) return;
      if (e instanceof ApiError && e.status === 429) startCountdown(Number((e.details as { retryAfter?: number } | undefined)?.retryAfter) || 10);
      error.value = e as Error;
    } finally {
      if (my === seq) submitting.value = false;
    }
  }

  /** Session Browser:這個 IP 當下的連線 */
  const session = (ip: string, direction: 'src' | 'dst' = 'src') => submit({ kind: 'session', ip, direction });
  /** 最近 minutes 分鐘(≤ 15)的 log,到現在為止 */
  function recentLog(ip: string, minutes = MAX_MINUTES, logType: 'traffic' | 'threat' = 'traffic') {
    const to = now();
    const m = Math.min(Math.max(1, Math.floor(minutes)), MAX_MINUTES);
    return submit({ kind: 'log', ip, logType, from: new Date(to - m * 60_000).toISOString(), to: new Date(to).toISOString() });
  }

  function reset() {
    seq++;
    clearTimeout(timer);
    job.value = null;
    error.value = null;
  }

  if (getCurrentScope())
    onScopeDispose(() => {
      seq++;
      clearTimeout(timer);
      stopCountdown();
    });

  return { canQuery, server, job, error, state, ready, waitSec, retryAfter, refreshState, submit, session, recentLog, reset };
}
