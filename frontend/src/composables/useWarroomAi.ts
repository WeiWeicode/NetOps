/**
 * 戰情室上方「AI 每小時分析」(docs/WARROOM-PLAN.md §3 WR-3、§6 Q4):
 *   - 讀最新一筆(不留歷史);每 5 分鐘再讀一次,整點自動分析完成後畫面會更新
 *   - 立即分析:POST .../run 逐字串流(streaming / streamText);同時一個(409)、冷卻 5 分鐘(429,details.retryAfter 秒數優先)
 *   - 按鈕權限 netops.pa-live.ai(UI.paLiveAi);canRun 已含權限、執行中、冷卻判斷,畫面只綁 :disabled="!canRun"
 *   - mock 模式同 useWarroom(假逐字輸出,不呼叫 API)
 */
import { ApiError } from '@giganexus/web-kit';
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import { AiStreamError } from '@/api/ai';
import { can, describeError } from '@/api/gateway';
import { UI } from '@/api/perms';
import { warroom as api, type HourlyInsight } from '@/api/warroom';
import { usePolling } from './usePolling';
import { createWarroomMock, resolveMock } from './warroomMock';

export const INSIGHT_POLL_MS = 5 * 60_000;
export const COOLDOWN_MS = 5 * 60_000;
/** 分析執行中(自動或別人手動)時,短間隔追結果 */
export const RUNNING_POLL_MS = 5_000;

/** 429 回應的冷卻秒數(details.retryAfter),沒有時用預設 5 分鐘 */
export function cooldownFromError(e: unknown, now = Date.now()): number | null {
  if (!(e instanceof ApiError) || e.status !== 429) return null;
  const sec = Number((e.details as { retryAfter?: unknown } | undefined)?.retryAfter);
  return now + (Number.isFinite(sec) && sec > 0 ? sec * 1000 : COOLDOWN_MS);
}

export function useWarroomAi(options: { mock?: boolean; can?: (code: string) => boolean } = {}) {
  const mock = resolveMock(options.mock);
  const check = options.can ?? can;
  const insight = shallowRef<HourlyInsight | null>(null);
  const loadError = ref<Error | null>(null);
  const running = ref(false);
  const streamText = ref('');
  const runError = ref('');
  const cooldownUntil = ref<number | null>(null);
  const now = ref(Date.now());
  const tick = setInterval(() => (now.value = Date.now()), 1000);
  let abort: AbortController | null = null;
  let follow: ReturnType<typeof setTimeout> | undefined;
  const mockSrc = mock ? createWarroomMock() : null;

  const poll = usePolling(
    () => (mockSrc ? Promise.resolve(mockSrc.insight()) : api.insight()),
    (r) => {
      if (r instanceof Error) loadError.value = r;
      else {
        insight.value = r;
        loadError.value = null;
        const until = r.cooldownUntil ? Date.parse(r.cooldownUntil) : NaN;
        if (Number.isFinite(until)) cooldownUntil.value = until;
        clearTimeout(follow);
        if (r.status === 'running') follow = setTimeout(() => void poll.run(), RUNNING_POLL_MS);
      }
      return true;
    },
    INSIGHT_POLL_MS,
  );

  const allowed = computed(() => mock || check(UI.paLiveAi));
  const cooldownSec = computed(() => (cooldownUntil.value && cooldownUntil.value > now.value ? Math.ceil((cooldownUntil.value - now.value) / 1000) : 0));
  const canRun = computed(() => allowed.value && !running.value && cooldownSec.value === 0 && insight.value?.status !== 'running');
  /** 顯示中的文字:執行中顯示逐字內容,否則最新一筆 */
  const text = computed(() => (running.value ? streamText.value : (insight.value?.text ?? '')));
  const failed = computed(() => !running.value && insight.value?.status === 'failed');

  async function runMock() {
    const full = mockSrc!.insight('manual');
    for (const ch of full.text) {
      if (abort?.signal.aborted) return;
      streamText.value += ch;
      await new Promise((r) => setTimeout(r, 15));
    }
    insight.value = full;
  }

  async function run(): Promise<void> {
    if (!canRun.value) return;
    running.value = true;
    streamText.value = '';
    runError.value = '';
    abort = new AbortController();
    try {
      if (mockSrc) await runMock();
      else
        await api.runInsight((e) => {
          const d = e.data as { text?: unknown };
          if (e.event === 'content') streamText.value += String(d?.text ?? '');
        }, abort.signal);
      if (abort.signal.aborted) return;
      cooldownUntil.value = Date.now() + COOLDOWN_MS;
      if (!mockSrc) {
        // 先保留串流結果,重新讀取失敗時文字不會消失
        insight.value = { ...(insight.value ?? { hour: null, model: '', partial: false }), text: streamText.value, trigger: 'manual', status: 'done' };
        await poll.run();
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      const cd = cooldownFromError(e);
      if (cd) cooldownUntil.value = cd;
      runError.value = e instanceof AiStreamError ? e.message : describeError(e);
      if (!mockSrc) void poll.run();
    } finally {
      running.value = false;
      abort = null;
    }
  }

  void poll.run();
  if (getCurrentScope())
    onScopeDispose(() => {
      clearTimeout(follow);
      clearInterval(tick);
      abort?.abort();
      poll.stop();
    });

  return { mock, insight, loadError, running, streamText, runError, text, failed, allowed, canRun, cooldownSec, run, reload: poll.run };
}
