/**
 * AI 每日摘要(IMPL-PLAN AC7;docs/API.md §10.4):流量總覽上方的「AI 每日摘要」卡片的狀態。
 *   GET /api/netops/ai/daily-summary(不帶 day = 最近一份完成的摘要);選了別的日子時帶 day。
 *   摘要由後端排程在每天對帳與每日同步之後產生,畫面只讀;前一天還沒產生時每 5 分鐘再看一次(呼叫端決定)。
 */
import { computed, ref, shallowRef } from 'vue';
import { ai, type DailySummaryState, type DailySummaryStatus } from '@/api/ai';

/** 今天(前一天的摘要)的狀態 → 標籤 */
export const DAILY_SUMMARY_STATE: Record<DailySummaryState, { label: string; tone: string }> = {
  disabled: { label: '未啟用', tone: 'neutral' },
  waiting: { label: '等待產生', tone: 'neutral' },
  running: { label: '產生中', tone: 'info' },
  retrying: { label: '稍後重試', tone: 'warning' },
  done: { label: '已產生', tone: 'success' },
  failed: { label: '產生失敗', tone: 'danger' },
};

/** 'YYYY-MM-DD' → '11/13(五)' */
export function summaryDayLabel(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const wd = '日一二三四五六'[new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))).getUTCDay()];
  return `${day.slice(5, 7)}/${day.slice(8, 10)}(${wd})`;
}

/**
 * 卡片上方的提示:失敗(今天的摘要產生失敗)、重試中、等待中、未啟用;
 * 顯示的摘要不是今天要產生的那一天(例如看到的是更早的)時也說明
 */
export function dailySummaryNotice(s: DailySummaryStatus | null, viewing: string | null): { tone: 'danger' | 'warning' | 'info' | 'neutral'; title?: string; text: string } | null {
  if (!s) return null;
  const target = s.target ? summaryDayLabel(s.target) : '前一天';
  const older = s.summary && s.summary.day !== s.target && !viewing ? `,以下是 ${summaryDayLabel(s.summary.day)} 的摘要` : '';
  if (s.state === 'failed') return { tone: 'danger', title: '今天的摘要產生失敗', text: `${target}的摘要重試後仍失敗${s.error ? `:${s.error.message}` : ''}${older}` };
  if (s.state === 'retrying') return { tone: 'warning', text: `${target}的摘要第一次產生失敗${s.error ? `(${s.error.message})` : ''},約 10 分鐘後自動重試一次${older}` };
  if (s.state === 'running') return { tone: 'info', text: `正在產生 ${target}的摘要${older}` };
  if (s.state === 'waiting') return { tone: 'neutral', text: `${target}的摘要會在每天 ${s.at ?? ''} 對帳與每日同步完成後自動產生${older}` };
  if (s.state === 'disabled') return { tone: 'neutral', text: `每日摘要未啟用(NETOPS_AI_DAILY_SUMMARY、AI 服務或自動對帳未設定)${s.summary ? ',以下是之前產生的摘要' : ''}` };
  return null;
}

export function useDailySummary() {
  const status = shallowRef<DailySummaryStatus | null>(null);
  const loading = ref(false);
  const error = ref<Error | null>(null);
  /** 使用者選的日子(null = 最近一份) */
  const day = ref<string | null>(null);
  let seq = 0;

  async function load(d: string | null = day.value) {
    const my = ++seq;
    loading.value = true;
    try {
      const r = await ai.dailySummary(d ?? undefined);
      if (my !== seq) return;
      status.value = r;
      day.value = d;
      error.value = null;
    } catch (e) {
      if (my === seq) error.value = e as Error;
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  const summary = computed(() => status.value?.summary ?? null);
  /** 日子選單:有存檔的日子(失敗的標示) */
  const dayOptions = computed(() => (status.value?.days ?? []).map((d) => ({ value: d.day, label: `${summaryDayLabel(d.day)}${d.state === 'failed' ? ' 失敗' : ''}` })));
  /** 前一天的摘要還沒產生(要再看一次) */
  const pending = computed(() => ['waiting', 'running', 'retrying'].includes(status.value?.state ?? ''));
  const notice = computed(() => dailySummaryNotice(status.value, day.value));

  return { status, loading, error, day, load, summary, dayOptions, pending, notice };
}
