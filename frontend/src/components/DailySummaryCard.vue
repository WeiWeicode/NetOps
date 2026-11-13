<script setup lang="ts">
/**
 * AI 每日摘要(IMPL-PLAN AC7;docs/API.md §10.4):流量總覽上方的卡片。
 *   - 每天對帳與每日同步之後,後端自動產生前一天的摘要(流量 + 四類安全事件);這裡只讀,不觸發 AI
 *   - 狀態標籤、今天的摘要產生失敗 / 重試中 / 等待中的提示;可選以前的日子
 *   - 回答一律經 AiMarkdown(DOMPurify);預設收合(顯示前幾行),按「展開全文」看全部(aria-expanded)
 *   - 前一天還沒產生時每 5 分鐘再看一次;收合沒有動畫(prefers-reduced-motion 也不受影響)
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { describeError } from '@/api/gateway';
import { fmtNum, fmtTime } from '@/api/format';
import { DAILY_SUMMARY_STATE, summaryDayLabel, useDailySummary } from '@/composables/useDailySummary';
import AiMarkdown from './AiMarkdown.vue';

const POLL_MS = 5 * 60_000;

const x = useDailySummary();
const expanded = ref(false);
const uid = `daily-summary-${Math.random().toString(36).slice(2, 8)}`;
const badge = computed(() => (x.status.value ? DAILY_SUMMARY_STATE[x.status.value.state] : null));
const result = computed(() => x.summary.value?.result ?? null);
const counts = computed(() => {
  const c = result.value?.counts;
  if (!c) return [];
  return [
    { key: 'sessions', label: '連線數', v: c.sessions },
    { key: 'threat', label: '威脅', v: c.threat },
    { key: 'url', label: 'URL 過濾', v: c.url },
    { key: 'data', label: '資料過濾', v: c.data },
    { key: 'wildfire', label: 'WildFire', v: c.wildfire },
  ].filter((i) => i.v !== null);
});
const selected = computed({
  get: () => x.day.value ?? x.summary.value?.day ?? '',
  set: (d: string) => void x.load(d && d !== x.status.value?.days[0]?.day ? d : null),
});

let timer: ReturnType<typeof setInterval> | undefined;
watch(
  () => x.pending.value && !x.day.value,
  (on) => {
    clearInterval(timer);
    timer = on ? setInterval(() => void x.load(null), POLL_MS) : undefined;
  },
);
onMounted(() => void x.load(null));
onBeforeUnmount(() => clearInterval(timer));
// 換日子時收合
watch(() => x.summary.value?.day, () => (expanded.value = false));
</script>

<template>
  <GCard title="AI 每日摘要" icon="sparkles" padding="sm" class="daily-summary" :subtitle="x.status.value?.at ? `每天 ${x.status.value.at} 對帳與每日同步後,自動摘要前一天的流量與安全事件` : '自動摘要前一天的流量與安全事件'">
    <template #actions>
      <GBadge v-if="badge" :tone="badge.tone" dot>{{ badge.label }}</GBadge>
      <div v-if="x.dayOptions.value.length > 1" class="day-pick">
        <GSelect v-model="selected" label="摘要日期" :options="x.dayOptions.value" />
      </div>
    </template>

    <GSkeleton v-if="!x.status.value && x.loading.value" :lines="3" />
    <GAlert v-else-if="x.error.value && !x.status.value" tone="danger">
      無法取得每日摘要:{{ describeError(x.error.value) }}
      <GButton size="sm" icon="refresh" class="retry" @click="() => void x.load()">重試</GButton>
    </GAlert>
    <template v-else-if="x.status.value">
      <GAlert v-if="x.error.value" tone="danger">重新載入失敗,以下是上次的結果:{{ describeError(x.error.value) }}</GAlert>
      <GAlert v-if="x.notice.value && !x.day.value" :tone="x.notice.value.tone" :title="x.notice.value.title">{{ x.notice.value.text }}</GAlert>

      <template v-if="x.summary.value">
        <GAlert v-if="x.summary.value.state === 'failed'" tone="danger" :title="`${summaryDayLabel(x.summary.value.day)} 的摘要產生失敗`">
          {{ x.summary.value.error?.message ?? '重試後仍失敗' }}
        </GAlert>
        <template v-else-if="result">
          <div class="meta small">
            <strong class="num">{{ summaryDayLabel(x.summary.value.day) }}</strong>
            <span class="faint">產生於 {{ fmtTime(x.summary.value.at) }}</span>
            <span class="faint hide-sm">模型 {{ result.model }}</span>
            <GBadge v-if="result.partial" tone="warning" icon="alert">資料不完整</GBadge>
          </div>
          <ul v-if="counts.length" class="counts" aria-label="前一天的筆數">
            <li v-for="c in counts" :key="c.key">
              <span class="faint">{{ c.label }}</span> <strong class="num">{{ fmtNum(c.v!) }}</strong>
            </li>
          </ul>
          <p v-if="result.partial" class="small c-warning">部分資料不完整(對帳缺口、尚未對帳或某類統計取不到),摘要內已說明;數字可能少算。</p>
          <div :id="uid" class="summary-body" :class="{ collapsed: !expanded }">
            <AiMarkdown :text="result.text" />
          </div>
          <div class="foot">
            <GButton size="sm" variant="ghost" :icon="expanded ? 'chevron-down' : 'chevron-right'" :aria-expanded="expanded" :aria-controls="uid" @click="expanded = !expanded">
              {{ expanded ? '收合' : '展開全文' }}
            </GButton>
            <span class="small faint">只送統計與排行到公司內部 AI 主機;AI 可能判斷錯誤,請以明細確認。</span>
          </div>
        </template>
      </template>
      <p v-else-if="!x.notice.value" class="small muted">還沒有每日摘要。</p>
    </template>
  </GCard>
</template>

<style scoped>
.day-pick {
  min-width: 9.5rem;
}
.retry {
  margin-left: 8px;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin-bottom: 8px;
}
.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
  font-size: var(--fs-sm, 0.875rem);
}
.summary-body.collapsed {
  max-height: 11.5em;
  overflow: hidden;
  /* 玻璃 / 平面風格的底色不同,用遮罩淡出(不依賴底色) */
  mask-image: linear-gradient(to bottom, #000 70%, transparent);
}
/* 標籤只給螢幕閱讀器(版面放不下) */
.day-pick :deep(.lbl) {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-top: 6px;
}
@media (max-width: 640px) {
  .hide-sm {
    display: none;
  }
  .day-pick {
    min-width: 8rem;
  }
}
</style>
