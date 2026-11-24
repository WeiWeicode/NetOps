/**
 * DC Agent 即時狀態輪詢(AD-3;docs/AD-AGENT-PLAN.md §6.1):
 *   - 呼叫 GET /api/netops/ad/agents(30 秒輪詢)
 *   - 頁面隱藏(document.hidden)時停止排程,重新顯示時立刻再查一次;離開頁面(scope 結束)完全清除
 *   - 424 NETOPS_REDIS_UNAVAILABLE 標示為 redisUnavailable(不阻擋總覽頁)
 */
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { ad, type AdAgentsResponse, type AgentState } from '@/api/ad';
import { isRedisUnavailable } from '@/composables/adEvents';

export const AGENT_POLL_MS = 30_000;

export const AGENT_STATE_META: Record<AgentState, { label: string; tone: string }> = {
  ok: { label: '正常', tone: 'success' },
  stale: { label: '停止更新', tone: 'warning' },
  offline: { label: '離線', tone: 'danger' },
  unknown: { label: '未知', tone: 'neutral' },
};

export const AGENT_EVENT_LABELS: Record<string, string> = {
  agent_restarted: 'Agent 重啟',
  agent_service_stopped: '服務停止恢復',
  agent_start_failed: '啟動失敗',
  log_record_id_reset: 'RecordID 重設',
  bookmarks_corrupted: '水位檔損壞',
};

export function useAdAgents(enabled: Ref<boolean>, intervalMs = AGENT_POLL_MS) {
  const data = shallowRef<AdAgentsResponse | null>(null);
  const loading = ref(false);
  const error = ref<Error | null>(null);
  const redisUnavailable = computed(() => isRedisUnavailable(error.value));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let disposed = false;

  const isHidden = () => typeof document !== 'undefined' && document.hidden;

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function scheduleNext() {
    clearTimer();
    if (disposed || !enabled.value || isHidden()) return;
    timer = setTimeout(() => void refresh(), intervalMs);
  }

  async function refresh() {
    if (disposed || !enabled.value) return;
    clearTimer();
    const my = ++seq;
    loading.value = true;
    try {
      const r = await ad.agents();
      if (my !== seq || disposed) return;
      data.value = r;
      error.value = null;
    } catch (e) {
      if (my !== seq || disposed) return;
      error.value = e as Error;
    } finally {
      if (my === seq && !disposed) {
        loading.value = false;
        scheduleNext();
      }
    }
  }

  function onVisibilityChange() {
    if (disposed || !enabled.value) return;
    if (isHidden()) clearTimer();
    else void refresh();
  }

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);

  watch(
    enabled,
    (on) => {
      if (on) {
        if (!isHidden()) void refresh();
      } else {
        clearTimer();
        seq++;
      }
    },
    { immediate: true },
  );

  function stop() {
    disposed = true;
    seq++;
    clearTimer();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  if (getCurrentScope()) onScopeDispose(stop);

  return { data, loading, error, redisUnavailable, refresh, stop };
}
