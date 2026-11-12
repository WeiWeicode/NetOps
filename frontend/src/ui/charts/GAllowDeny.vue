<script setup lang="ts">
/**
 * Allow vs Deny 堆疊柱狀圖(V-b2;HANDOFF-GEMINI-VIZ §3.3、§4.2):
 *   - 顯示每小時或每天的允許(allow)與阻擋(deny)堆疊柱
 *   - 點擊阻擋柱時 series 正規化為 'deny',使 useChartPick 自動帶入 action: 'block'
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fmtNum, fmtShort } from '@/api/format';
import { taipeiLocal } from '@/composables/vizTime';
import GEChart from './GEChart.vue';
import type { ChartPick, GAllowDenyProps } from './viz-types';

const props = defineProps<GAllowDenyProps>();
const emit = defineEmits<{ (e: 'pick', p: ChartPick): void }>();

const themeTick = ref(0);
let mo: MutationObserver | null = null;

onMounted(() => {
  if (typeof document !== 'undefined') {
    mo = new MutationObserver(() => {
      themeTick.value++;
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-style'] });
  }
});

onBeforeUnmount(() => mo?.disconnect());

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function token(name: string, fallback: string): string {
  void themeTick.value;
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function formatAxisTime(iso: string): string {
  const local = taipeiLocal(iso);
  if (props.bucketSeconds >= 86400) return local.slice(5, 10);
  return local.slice(5).replace('T', ' ');
}

const option = computed<Record<string, unknown>>(() => {
  const allowColor = token('--c-success', '#12a150');
  const denyColor = token('--c-danger', '#e0483e');
  const times = props.points.map((p) => p.t);

  return {
    grid: { top: 36, right: 20, bottom: 28, left: 56, containLabel: false },
    legend: {
      top: 4,
      formatter: (name: string) => (name === 'deny' ? '阻擋 (Deny)' : '允許 (Allow)'),
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const first = list[0] as { dataIndex?: number } | undefined;
        const pt = props.points[first?.dataIndex ?? 0];
        if (!pt) return '';
        const timeStr = esc(taipeiLocal(pt.t).replace('T', ' '));
        if (pt.allow === null && pt.deny === null) {
          return `<div><strong>${timeStr}</strong><br/>沒有資料</div>`;
        }
        return [
          `<div><strong>${timeStr}</strong></div>`,
          `<div>允許 (Allow)：<strong>${esc(pt.allow === null ? '沒有資料' : fmtNum(pt.allow))}</strong></div>`,
          `<div>阻擋 (Deny)：<strong>${esc(pt.deny === null ? '沒有資料' : fmtNum(pt.deny))}</strong></div>`,
        ].join('');
      },
    },
    xAxis: {
      type: 'category',
      data: times,
      axisLabel: {
        formatter: (v: string) => formatAxisTime(v),
        hideOverlap: true,
      },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: (v: number) => fmtShort(v) },
    },
    series: [
      {
        name: 'allow',
        type: 'bar',
        stack: 'ad',
        barMaxWidth: 22,
        itemStyle: { color: allowColor },
        data: props.points.map((p) => ({ name: p.t, value: p.allow })),
      },
      {
        name: 'deny',
        type: 'bar',
        stack: 'ad',
        barMaxWidth: 22,
        itemStyle: { color: denyColor, borderRadius: [3, 3, 0, 0] },
        data: props.points.map((p) => ({ name: p.t, value: p.deny })),
      },
    ],
  };
});

function onPick(p: ChartPick) {
  const series = p.series === 'deny' || p.series === '阻擋 (Deny)' ? 'deny' : 'allow';
  emit('pick', { ...p, chart: 'allowDeny', series });
}
</script>

<template>
  <GEChart chart="allowDeny" :option="option" ariaLabel="允許與阻擋連線堆疊柱狀圖" @pick="onPick" />
</template>
