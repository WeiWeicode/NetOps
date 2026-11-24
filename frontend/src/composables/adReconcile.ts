/**
 * AD FTP 與 ClickHouse 對帳與補漏(AD-3;docs/AD-AGENT-PLAN.md §5、§6.1):
 *   - 載入可對帳期間(GET /api/netops/ad/reconciliations),ClickHouse 不可用(503)時回報 unavailable 不擋 FTP 檔案頁
 *   - 立即對帳(POST /api/netops/ad/reconciliations)、送出補漏(POST /api/netops/ad/backfills)
 *   - 補漏工作輪詢(GET /api/netops/ad/backfills/{id},每 2 秒,頁面隱藏時停止、顯示時恢復、離開頁面時清除)
 */
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import { adRecon, type AdBackfillJob, type AdBackfillScope, type AdReconDay, type AdReconItemStatus, type AdReconList, type AdReconStatus } from '@/api/ad';
import { ApiError } from '@/api/gateway';
import { isClickHouseUnavailable } from '@/composables/adEvents';

export const BACKFILL_POLL_MS = 2_000;
const DAY_MS = 86_400_000;

export const AD_RECON_STATUS: Record<AdReconStatus, { label: string; tone: string }> = {
  ok: { label: '一致', tone: 'success' },
  gap: { label: '有缺口', tone: 'danger' },
  excess: { label: '多出', tone: 'warning' },
  pending: { label: '待匯入', tone: 'neutral' },
  'ftp-error': { label: 'FTP 失敗', tone: 'danger' },
};

export const AD_RECON_ITEM_STATUS: Record<AdReconItemStatus, { label: string; tone: string }> = {
  ok: { label: '一致', tone: 'success' },
  gap: { label: '缺口', tone: 'danger' },
  excess: { label: '多出', tone: 'warning' },
};

export const AD_BACKFILL_STATE: Record<AdBackfillJob['state'], { label: string; tone: string }> = {
  queued: { label: '排隊中', tone: 'neutral' },
  running: { label: '補漏中', tone: 'info' },
  done: { label: '完成', tone: 'success' },
  failed: { label: '失敗', tone: 'danger' },
};

/** 補漏 409 / 400 / 424 錯誤的友善標題 */
export function backfillErrorTitle(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'NETOPS_RECON_PENDING') return 'FTP 檔案尚未匯入';
    if (e.code === 'NETOPS_BACKFILL_NOTHING') return '沒有需要補漏的項目';
    if (e.code === 'NETOPS_BACKFILL_BUSY') return '補漏佇列已滿';
    if (e.code === 'NETOPS_REDIS_UNAVAILABLE' || e.status === 424) return 'Redis 暫時無法使用';
  }
  return '補漏送出失敗';
}

/** 預設查詢期間:今天往前 90 天到今天(後端自動裁切為保留期內、昨天以前的日子) */
export function defaultReconRange(now = Date.now()): { from: string; to: string } {
  const fmt = (ms: number) => {
    const d = new Date(ms + 8 * 3600_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  return { from: fmt(now - 90 * DAY_MS), to: fmt(now) };
}

export function useAdReconcile(pollMs = BACKFILL_POLL_MS) {
  const list = shallowRef<AdReconList | null>(null);
  const loading = ref(false);
  const error = ref<Error | null>(null);
  const unavailable = computed(() => isClickHouseUnavailable(error.value));
  /** 正在立即對帳的日期 */
  const runningDay = ref('');
  /** 正在送出補漏的鍵(day 或 day|computer|channel) */
  const submittingKey = ref('');
  /** 每個工作 id 的最新狀態 */
  const jobs = ref<Record<string, AdBackfillJob>>({});
  const jobError = ref<Record<string, Error | null>>({});
  /** 補漏完成後自動重新對帳失敗的錯誤(依日期顯示,不靜默吞掉;審查 M1) */
  const dayError = ref<Record<string, Error | null>>({});

  let timers = new Map<string, ReturnType<typeof setTimeout>>();
  let activeIds = new Set<string>();
  /** 本頁實際觀察到 queued / running 的工作:只有這些轉成 done 才自動重新對帳(審查 M1) */
  let observedInProgress = new Set<string>();
  /** 每個工作目前的輪詢序號與進行中旗標,防止頁面恢復可見時重疊請求(審查 Low 1) */
  let jobSeq = new Map<string, number>();
  let inFlightJobs = new Set<string>();
  let disposed = false;

  const isHidden = () => typeof document !== 'undefined' && document.hidden;

  function clearJobTimer(id: string) {
    const t = timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(id);
    }
  }

  function clearAllTimers() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  function updateDayRow(updated: AdReconDay) {
    if (!list.value) return;
    const idx = list.value.items.findIndex((d) => d.day === updated.day);
    if (idx < 0) return;
    const prev = list.value.items[idx]!;
    // 保留本頁已建立 / 追蹤中的補漏工作 id,避免重新對帳把剛完成的結果卡片蓋掉
    const backfills = [...new Set([...updated.backfills, ...prev.backfills])];
    const next = [...list.value.items];
    next[idx] = { ...updated, backfills };
    list.value = { ...list.value, items: next };
  }

  async function load() {
    loading.value = true;
    error.value = null;
    dayError.value = {};
    try {
      const { from, to } = defaultReconRange();
      const r = await adRecon.list(from, to);
      if (disposed) return;
      list.value = r;
      // 載入時只查一次最近工作狀態供顯示;若本來就是 done 不觸發重新對帳(審查 M1)
      for (const d of r.items) {
        const latest = d.backfills[0];
        if (latest && !jobs.value[latest]) void pollJob(latest, d.day);
      }
    } catch (e) {
      if (!disposed) error.value = e as Error;
    } finally {
      if (!disposed) loading.value = false;
    }
  }

  async function runDay(day: string): Promise<AdReconDay> {
    runningDay.value = day;
    dayError.value = { ...dayError.value, [day]: null };
    try {
      const updated = await adRecon.run(day);
      if (!disposed) updateDayRow(updated);
      return updated;
    } catch (e) {
      if (!disposed) dayError.value = { ...dayError.value, [day]: e as Error };
      throw e;
    } finally {
      if (runningDay.value === day) runningDay.value = '';
    }
  }

  async function pollJob(id: string, day: string): Promise<void> {
    if (disposed || inFlightJobs.has(id)) return;
    clearJobTimer(id);
    activeIds.add(id);
    inFlightJobs.add(id);
    const seq = (jobSeq.get(id) ?? 0) + 1;
    jobSeq.set(id, seq);
    try {
      const j = await adRecon.job(id);
      if (disposed || jobSeq.get(id) !== seq) return;
      jobs.value = { ...jobs.value, [id]: j };
      jobError.value = { ...jobError.value, [id]: null };
      if (j.state === 'done' || j.state === 'failed') {
        const wasObservedRunning = observedInProgress.has(id);
        observedInProgress.delete(id);
        activeIds.delete(id);
        // 只有本頁觀察到 queued / running → done 的工作且日期非空,才自動重新對帳;失敗顯示於該日(審查 M1、Low 1)
        const targetDay = day || j.day || '';
        if (j.state === 'done' && wasObservedRunning && targetDay) {
          void runDay(targetDay).catch(() => {
            // 錯誤已由 runDay 寫入 dayError[targetDay] 顯示於該日
          });
        }
      } else {
        observedInProgress.add(id);
        if (!isHidden()) {
          timers.set(
            id,
            setTimeout(() => void pollJob(id, day), pollMs),
          );
        }
      }
    } catch (e) {
      if (disposed || jobSeq.get(id) !== seq) return;
      jobError.value = { ...jobError.value, [id]: e as Error };
      // 404 工作已過期或不存在 → 停止輪詢
      if (e instanceof ApiError && e.status === 404) {
        activeIds.delete(id);
        observedInProgress.delete(id);
        return;
      }
      if (!isHidden()) {
        timers.set(
          id,
          setTimeout(() => void pollJob(id, day), pollMs),
        );
      }
    } finally {
      inFlightJobs.delete(id);
    }
  }

  async function startBackfill(day: string, scope?: AdBackfillScope[]): Promise<AdBackfillJob> {
    const key = scope?.length === 1 ? `${day}|${scope[0]!.computer}|${scope[0]!.channel}` : day;
    submittingKey.value = key;
    try {
      const j = await adRecon.backfill(day, scope);
      if (disposed) return j;
      jobs.value = { ...jobs.value, [j.id]: j };
      if (list.value) {
        const next = list.value.items.map((d) => (d.day === day ? { ...d, backfills: [j.id, ...d.backfills.filter((x) => x !== j.id)] } : d));
        list.value = { ...list.value, items: next };
      }
      if (j.state === 'queued' || j.state === 'running') {
        activeIds.add(j.id);
        observedInProgress.add(j.id);
        if (!isHidden()) {
          timers.set(
            j.id,
            setTimeout(() => void pollJob(j.id, day), pollMs),
          );
        }
      }
      return j;
    } finally {
      if (submittingKey.value === key) submittingKey.value = '';
    }
  }

  function onVisibilityChange() {
    if (disposed) return;
    if (isHidden()) {
      clearAllTimers();
    } else {
      for (const id of [...activeIds]) {
        const day = jobs.value[id]?.day ?? list.value?.items.find((d) => d.backfills.includes(id))?.day ?? '';
        void pollJob(id, day);
      }
    }
  }

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);

  function stop() {
    disposed = true;
    clearAllTimers();
    activeIds.clear();
    observedInProgress.clear();
    inFlightJobs.clear();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  if (getCurrentScope()) onScopeDispose(stop);

  return { list, loading, error, unavailable, runningDay, submittingKey, jobs, jobError, dayError, load, runDay, startBackfill, pollJob, stop };
}
