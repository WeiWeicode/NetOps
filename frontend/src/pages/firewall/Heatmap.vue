<script setup lang="ts">
/**
 * 防火牆 › 活動熱力圖(V-b1 樸素版:確認 composable 與元件串得起來)。
 * **頁面組裝、版面、tooltip、動畫、SliceDrawer 由 Gemini 在 V-b2 改寫**(HANDOFF-GEMINI-VIZ §3.1、§3.2);
 * 資料與狀態只用 useHeatmap / useSlice(不直接呼叫 api/)。
 */
import { computed, ref } from 'vue';
import { describeError } from '@/api/gateway';
import { fmtNum, fmtSize } from '@/api/format';
import type { HeatCell } from '@/api/heatmap';
import { useHeatmap } from '@/composables/useHeatmap';
import { useSlice } from '@/composables/useSlice';
import { formatRange } from '@/composables/vizTime';

const h = useHeatmap();
const s = useSlice();
const drawer = ref(false);
const selected = ref<string | null>(null);

const metricOptions = computed(() => h.metricOptions.filter((m) => !m.disabled).map((m) => ({ label: m.label, value: m.value })));
const granularityOptions = h.granularityOptions.map((g) => ({ label: g.label, value: g.value }));

function onSelect(cell: HeatCell) {
  selected.value = cell.t;
  if (!h.canSlice.value) return;
  const q = h.sliceQuery(cell);
  drawer.value = true;
  void s.open(q);
}
function onDrill(cell: HeatCell) {
  h.drill(cell);
}
const title = computed(() => (s.query.value ? formatRange(s.query.value.start, s.query.value.end) : '時段明細'));
</script>

<template>
  <div class="viz-heatmap">
    <div class="viz-heatmap__bar">
      <GSegmented v-model="h.granularity.value" :options="granularityOptions" size="sm" />
      <GSegmented v-model="h.metric.value" :options="metricOptions" size="sm" />
      <GButton size="sm" variant="ghost" @click="h.prev()">上一期</GButton>
      <input v-model="h.date.value" type="date" :max="undefined" aria-label="日期" />
      <GButton size="sm" variant="ghost" :disabled="!h.canNext.value" @click="h.next()">下一期</GButton>
    </div>
    <GAlert v-if="h.error.value" tone="danger">{{ describeError(h.error.value) }}</GAlert>
    <GAlert v-else-if="h.data.value?.coverage.since === null" tone="info">彙總表還沒有資料</GAlert>
    <GHeatmap
      v-if="h.data.value"
      :granularity="h.data.value.granularity"
      :metric="h.data.value.metric"
      :cells="h.cells.value"
      :from="h.data.value.from"
      :to="h.data.value.to"
      :loading="h.loading.value"
      :selected="selected"
      @select="onSelect"
      @drill="onDrill"
    />
    <GDrawer v-model="drawer" :title="title" @update:model-value="(v: boolean) => !v && s.close()">
      <GSourceBadge v-if="s.source.value" :source="s.source.value" />
      <p v-if="s.state.value === 'loading'">{{ s.isCold.value ? '讀取歷史冷歸檔中…' : '查詢中…' }}</p>
      <p v-else-if="s.state.value === 'waiting-job'">查詢較久,已轉為背景查詢 <GButton size="sm" @click="s.cancel()">取消</GButton></p>
      <p v-else-if="s.state.value === 'busy'">目前有其他歷史查詢進行中,{{ s.retryAfter.value }} 秒後可重試 <GButton size="sm" :disabled="s.retryAfter.value > 0" @click="s.retry()">重試</GButton></p>
      <GAlert v-else-if="s.state.value === 'error' && s.error.value" tone="info">{{ describeError(s.error.value) }}</GAlert>
      <template v-else-if="s.result.value">
        <p>
          Session {{ fmtNum(s.result.value.summary.sessions) }}・流量 {{ fmtSize(s.result.value.summary.bytes) }}・阻擋 {{ fmtNum(s.result.value.summary.deny) }}
        </p>
        <p v-if="s.result.value.rowsTruncated">只顯示前 {{ s.result.value.rowsLimit }} 筆</p>
        <GButton v-if="s.searchLink.value" size="sm" @click="s.openInSearch()">在 Log 明細查詢開啟</GButton>
      </template>
    </GDrawer>
  </div>
</template>

<style scoped>
.viz-heatmap {
  display: grid;
  gap: 12px;
}
.viz-heatmap__bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
</style>
