<script setup lang="ts">
/**
 * 威脅堆疊時序圖(V-b2;HANDOFF-GEMINI-VIZ §3.3、§4.2):
 *   - 顯示 critical / high / medium / low 四層嚴重度的時間序列堆疊柱狀圖
 *   - 顏色固定對應語意色(--c-danger、--c-warning、--c-info、--c-cyan)
 *   - 點擊時 emit('pick', { chart: 'timeline', name: pt.t, series: severity })
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fmtNum, fmtShort } from '@/api/format';
import { taipeiLocal } from '@/composables/vizTime';
import GEChart from './GEChart.vue';
import type { ChartPick, GThreatTimelineProps } from './viz-types';

const props = defineProps<GThreatTimelineProps>();
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

const SEV_LABELS: Record<string, string> = {
  critical: '嚴重 (Critical)',
  high: '高 (High)',
  medium: '中 (Medium)',
  low: '低 (Low)',
};

function formatAxisTime(iso: string): string {
  const local = taipeiLocal(iso);
  if (props.bucketSeconds >= 86400) return local.slice(5, 10);
  return local.slice(5).replace('T', ' ');
}

const option = computed<Record<string, unknown>>(() => {
  const colors = {
    critical: token('--c-danger', '#e0483e'),
    high: token('--c-warning', '#e0901a'),
    medium: token('--c-info', '#2f7de1'),
    low: token('--c-cyan', '#0891b2'),
  };
  const times = props.points.map((p) => p.t);

  return {
    grid: { top: 36, right: 20, bottom: 28, left: 52, containLabel: false },
    legend: {
      top: 4,
      formatter: (name: string) => SEV_LABELS[name] ?? name,
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
        if (pt.critical === null && pt.high === null && pt.medium === null && pt.low === null) {
          return `<div><strong>${timeStr}</strong><br/>沒有資料</div>`;
        }
        return [
          `<div><strong>${timeStr}</strong></div>`,
          `<div>嚴重 (Critical)：<strong>${esc(pt.critical === null ? '沒有資料' : fmtNum(pt.critical))}</strong></div>`,
          `<div>高 (High)：<strong>${esc(pt.high === null ? '沒有資料' : fmtNum(pt.high))}</strong></div>`,
          `<div>中 (Medium)：<strong>${esc(pt.medium === null ? '沒有資料' : fmtNum(pt.medium))}</strong></div>`,
          `<div>低 (Low)：<strong>${esc(pt.low === null ? '沒有資料' : fmtNum(pt.low))}</strong></div>`,
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
    series: (['critical', 'high', 'medium', 'low'] as const).map((sev, idx) => ({
      name: sev,
      type: 'bar',
      stack: 'threat',
      barMaxWidth: 22,
      itemStyle: {
        color: colors[sev],
        borderRadius: idx === 3 ? [3, 3, 0, 0] : 0,
      },
      data: props.points.map((p) => ({ name: p.t, value: p[sev] })),
    })),
  };
});

function onPick(p: ChartPick) {
  emit('pick', { ...p, chart: 'timeline' });
}
</script>

<template>
  <GEChart chart="timeline" :option="option" ariaLabel="威脅嚴重度堆疊時序圖" @pick="onPick" />
</template>
