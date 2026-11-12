<script setup lang="ts">
/**
 * 防火牆 › 分析儀表板(V-b1 空頁:只放一個趨勢圖,確認 ECharts 動態載入、主題與點擊聯動)。
 * **頁面組裝、各圖表元件(GTrendDualAxis、GSankey…)、Tab、動畫由 Gemini 在 V-b2 實作**(HANDOFF-GEMINI-VIZ §3.3、§4.2);
 * 資料只用 useInsight / useChartPick / useSlice,圖表元件介面見 ui/charts/viz-types.ts。
 */
import { computed } from 'vue';
import { describeError } from '@/api/gateway';
import { useChartPick } from '@/composables/useChartPick';
import { useInsight } from '@/composables/useInsight';
import { useSlice } from '@/composables/useSlice';
import type { ChartPick } from '@/ui/charts/viz-types';

const traffic = useInsight('traffic');
const { toSliceQuery } = useChartPick();
const s = useSlice();
const presets = traffic.presets.filter((p) => p.value !== 'custom').map((p) => ({ label: p.label, value: p.value }));

const option = computed(() => {
  const d = traffic.data.value;
  if (!d) return {};
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['上傳', '下載', 'Session'] },
    xAxis: { type: 'category', data: d.trend.map((p) => p.t) },
    yAxis: [{ type: 'value' }, { type: 'value' }],
    series: [
      { name: '上傳', type: 'line', data: d.trend.map((p) => p.sent) },
      { name: '下載', type: 'line', data: d.trend.map((p) => p.recv) },
      { name: 'Session', type: 'line', yAxisIndex: 1, data: d.trend.map((p) => p.sessions) },
    ],
  };
});

function onPick(p: ChartPick) {
  const q = toSliceQuery(p, traffic.range.value, { bucketSeconds: traffic.data.value?.bucketSeconds, allowDenyBucketSeconds: traffic.data.value?.allowDenyBucketSeconds });
  if (q) void s.open(q);
}
</script>

<template>
  <div class="viz-insight">
    <GSegmented :model-value="traffic.activePreset.value" :options="presets" size="sm" @update:model-value="(v: string) => traffic.preset(v as 'today' | '7d' | '30d' | '90d')" />
    <GAlert v-if="traffic.error.value" tone="danger">{{ describeError(traffic.error.value) }}</GAlert>
    <GEChart chart="trend" :option="option" :loading="traffic.loading.value" ariaLabel="上傳 / 下載與 Session 趨勢" @pick="onPick" />
    <p v-if="s.result.value">時段明細:Session {{ s.result.value.summary.sessions }}</p>
  </div>
</template>

<style scoped>
.viz-insight {
  display: grid;
  gap: 12px;
}
</style>
