<script setup lang="ts">
/**
 * Top 10 App 佔比圖(V-b2;HANDOFF-GEMINI-VIZ §3.3、§4.2):
 *   - 依 mode 切換甜甜圈(donut)或矩形樹圖(treemap),共用同一份 items 資料
 *   - 點擊項目 emit('pick', { chart: 'topApp', name: item.app, ... })
 */
import { computed } from 'vue';
import { fmtNum, fmtSize } from '@/api/format';
import GEChart from './GEChart.vue';
import type { ChartPick, GAppShareProps } from './viz-types';

const props = defineProps<GAppShareProps>();
const emit = defineEmits<{ (e: 'pick', p: ChartPick): void }>();

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const option = computed<Record<string, unknown>>(() => {
  const data = props.items.map((x) => ({
    name: x.app,
    value: x.bytes,
    sessions: x.sessions,
  }));

  const tooltip = {
    trigger: 'item',
    formatter: (p: unknown) => {
      const d = p as { name?: string; value?: number; percent?: number; data?: { sessions?: number } };
      const pct = d.percent !== undefined ? ` (${d.percent.toFixed(1)}%)` : '';
      return [
        `<div><strong>${esc(d.name)}</strong>${esc(pct)}</div>`,
        `<div>流量：<strong>${esc(fmtSize(d.value ?? 0))}</strong></div>`,
        `<div>連線數：<strong>${esc(fmtNum(d.data?.sessions ?? 0))}</strong></div>`,
      ].join('');
    },
  };

  if (props.mode === 'treemap') {
    return {
      tooltip,
      series: [
        {
          name: 'Top App',
          type: 'treemap',
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          itemStyle: { borderColor: 'transparent', gapWidth: 2, borderRadius: 6 },
          label: {
            show: true,
            formatter: '{b}',
          },
          data,
        },
      ],
    };
  }

  return {
    tooltip,
    legend: {
      orient: 'vertical',
      right: 8,
      top: 'middle',
      type: 'scroll',
    },
    series: [
      {
        name: 'Top App',
        type: 'pie',
        radius: ['46%', '74%'],
        center: ['36%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderWidth: 2 },
        label: { show: false },
        emphasis: {
          label: { show: true, fontWeight: 'bold', formatter: '{b}\n{d}%' },
        },
        data,
      },
    ],
  };
});

function onPick(p: ChartPick) {
  emit('pick', { ...p, chart: 'topApp' });
}
</script>

<template>
  <GEChart chart="topApp" :option="option" :ariaLabel="`Top 10 應用程式流量佔比(${mode === 'treemap' ? 'Treemap' : '甜甜圈圖'})`" @pick="onPick" />
</template>
