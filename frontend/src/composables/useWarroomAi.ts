/**
 * 戰情室上方「AI 每小時分析」(docs/WARROOM-PLAN.md §3 WR-3、§6 Q4):
 *   - 讀最新一筆(不留歷史);每 5 分鐘再讀一次,整點自動分析完成後畫面會更新
 *   - 對齊 WR-3(!116):GET 回 { enabled, status(none/done/failed), running, hour, until, text, model, trigger, partial, statsMinutes, at, error, cooldownUntil }
 *   - 立即分析:POST .../run 逐字串流(meta 先帶 hour/model/trigger,content 逐字);同時一個(409)、冷卻 5 分鐘(429,details[{ field: 'retryAfterSec' }] 秒數優先)、未啟用 503
 *   - 按鈕權限 netops.pa-live.ai(UI.paLiveAi);canRun 已含權限、執行中、冷卻判斷,畫面只綁 :disabled="!canRun"
 *   - mock 模式同 useWarroom(假逐字輸出,不呼叫 API)
 */
import { ApiError } from '@giganexus/web-kit';
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import { AiStreamError } from '@/api/ai';
import { can, describeError } from '@/api/gateway';
import { UI } from '@/api/perms';
import { warroom as api, type HourlyInsight, type HourlyInsightMeta } from '@/api/warroom';
import { usePolling } from './usePolling';
import { createWarroomMock, resolveMock } from './warroomMock';

export const INSIGHT_POLL_MS = 5 * 60_000;
export const COOLDOWN_MS = 5 * 60_000;
/** 分析執行中(自動或別人手動)時,短間隔追結果 */
export const RUNNING_POLL_MS = 5_000;

/** 429 回應的冷卻結束時間:details 是 [{ field: 'retryAfterSec', message: '秒數' }](!116),沒有時用預設 5 分鐘 */
export function cooldownFromError(e: unknown, now = Date.now()): number | null {
  if (!(e instanceof ApiError) || e.status !== 429) return null;
  const list = Array.isArray(e.details) ? (e.details as { field?: unknown; message?: unknown }[]) : [];
  const sec = Number(list.find((d) => d?.field === 'retryAfterSec')?.message);
  return now + (Number.isFinite(sec) && sec > 0 ? sec * 1000 : COOLDOWN_MS);
}

const EMPTY_INSIGHT: HourlyInsight = {
  enabled: true,
  status: 'none',
  running: false,
  hour: null,
  until: null,
  text: null,
  model: null,
  trigger: null,
  partial: false,
  statsMinutes: null,
  at: null,
  error: null,
  cooldownUntil: null,
};

function metaFields(m: HourlyInsightMeta | null): Partial<HourlyInsight> {
  return m ? { hour: m.hour, until: m.until, model: m.model, partial: m.partial, statsMinutes: m.statsMinutes } : {};
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
        if (r.running) follow = setTimeout(() => void poll.run(), RUNNING_POLL_MS);
      }
      return true;
    },
    INSIGHT_POLL_MS,
  );

  const allowed = computed(() => mock || check(UI.paLiveAi));
  const cooldownSec = computed(() => (cooldownUntil.value && cooldownUntil.value > now.value ? Math.ceil((cooldownUntil.value - now.value) / 1000) : 0));
  /** 後端未啟用(沒有 LLM_URL 或 NETOPS_AI_HOURLY=0);尚未讀到時視為啟用 */
  const enabled = computed(() => mock || insight.value?.enabled !== false);
  /** 分析中:自己的串流,或後端回報 running(整點自動 / 別人手動) */
  const busy = computed(() => running.value || !!insight.value?.running);
  const canRun = computed(() => allowed.value && enabled.value && !busy.value && cooldownSec.value === 0);
  /** 顯示中的文字:執行中顯示逐字內容,否則最新一筆 */
  const text = computed(() => (running.value ? streamText.value : (insight.value?.text ?? '')));
  const failed = computed(() => !busy.value && insight.value?.status === 'failed');
  /** 失敗原因(後端分類過的訊息) */
  const failReason = computed(() => (failed.value ? (insight.value?.error?.message ?? '') : ''));

  async function runMock() {
    const full = mockSrc!.insight('manual');
    for (const ch of full.text ?? '') {
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
    let streamMeta: HourlyInsightMeta | null = null;
    try {
      const meta = (): HourlyInsightMeta | null => streamMeta;
      if (mockSrc) await runMock();
      else
        await api.runInsight((e) => {
          if (e.event === 'content') streamText.value += String((e.data as { text?: unknown })?.text ?? '');
          else if (e.event === 'meta') streamMeta = e.data as HourlyInsightMeta;
        }, abort.signal);
      if (abort.signal.aborted) return;
      cooldownUntil.value = Date.now() + COOLDOWN_MS;
      if (!mockSrc) {
        // 先保留串流結果,重新讀取失敗時文字不會消失
        insight.value = {
          ...(insight.value ?? EMPTY_INSIGHT),
          ...metaFields(meta()),
          text: streamText.value,
          trigger: 'manual',
          status: 'done',
          running: false,
          error: null,
          at: new Date().toISOString(),
        };
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

  return { mock, insight, loadError, running, busy, enabled, streamText, runError, text, failed, failReason, allowed, canRun, cooldownSec, run, reload: poll.run };
}
