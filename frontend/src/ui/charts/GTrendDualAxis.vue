<script setup lang="ts">
/**
 * 雙軸趨勢圖(V-b2;HANDOFF-GEMINI-VIZ §3.3、§4.2、§5):
 *   - 左軸:上傳(sent)與下載(recv)面積圖(位元組,fmtSize)
 *   - 右軸:Session 折線(次數,fmtShort / fmtNum)
 *   - v === null 時斷開(connectNulls: false),tooltip 寫「沒有資料」
 *   - 載入時 1.2s 流光掃過 + 每 6s 輕微流光(背景分頁暫停,reduced-motion 關閉)
 *   - 點擊 emit('pick', { chart: 'trend', name: point.t, ... })
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fmtNum, fmtShort, fmtSize } from '@/api/format';
import { useReducedMotion } from '@/composables/useReducedMotion';
import { taipeiLocal } from '@/composables/vizTime';
import GEChart from './GEChart.vue';
import type { ChartPick, GTrendDualAxisProps } from './viz-types';

const props = defineProps<GTrendDualAxisProps>();
const emit = defineEmits<{ (e: 'pick', p: ChartPick): void }>();

const { reduced } = useReducedMotion();
const pageHidden = ref(typeof document !== 'undefined' ? document.hidden : false);
const themeTick = ref(0);
let mo: MutationObserver | null = null;

function onVis() {
  pageHidden.value = document.hidden;
}

onMounted(() => {
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVis);
    mo = new MutationObserver(() => {
      themeTick.value++;
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-style'] });
  }
});

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
  mo?.disconnect();
});

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
  const sentColor = token('--chart-3', '#f5a524');
  const recvColor = token('--chart-1', '#0369a1');
  const sessColor = token('--chart-2', '#0891b2');
  const times = props.points.map((p) => p.t);

  return {
    animationDuration: 1200,
    animationEasing: 'cubicOut',
    grid: { top: 38, right: 56, bottom: 28, left: 64, containLabel: false },
    legend: {
      top: 4,
      data: ['上傳流量', '下載流量', '連線數 (Session)'],
    },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const first = list[0] as { axisValue?: string; dataIndex?: number } | undefined;
        const idx = first?.dataIndex ?? 0;
        const pt = props.points[idx];
        const timeStr = pt ? esc(taipeiLocal(pt.t).replace('T', ' ')) : esc(first?.axisValue ?? '');
        if (!pt || (pt.sent === null && pt.recv === null && pt.sessions === null)) {
          return `<div><strong>${timeStr}</strong><br/>沒有資料</div>`;
        }
        return [
          `<div><strong>${timeStr}</strong></div>`,
          `<div>下載流量：<strong>${esc(pt.recv === null ? '沒有資料' : fmtSize(pt.recv))}</strong></div>`,
          `<div>上傳流量：<strong>${esc(pt.sent === null ? '沒有資料' : fmtSize(pt.sent))}</strong></div>`,
          `<div>連線數：<strong>${esc(pt.sessions === null ? '沒有資料' : fmtNum(pt.sessions))}</strong></div>`,
        ].join('');
      },
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: times,
      axisLabel: {
        formatter: (v: string) => formatAxisTime(v),
        hideOverlap: true,
      },
    },
    yAxis: [
      {
        type: 'value',
        name: '流量',
        axisLabel: { formatter: (v: number) => fmtSize(v) },
      },
      {
        type: 'value',
        name: 'Session',
        splitLine: { show: false },
        axisLabel: { formatter: (v: number) => fmtShort(v) },
      },
    ],
    series: [
      {
        name: '下載流量',
        type: 'line',
        smooth: true,
        connectNulls: false,
        symbol: 'circle',
        symbolSize: 6,
        itemStyle: { color: recvColor },
        areaStyle: { opacity: 0.22 },
        data: props.points.map((p) => ({ name: p.t, value: p.recv })),
      },
      {
        name: '上傳流量',
        type: 'line',
        smooth: true,
        connectNulls: false,
        symbol: 'circle',
        symbolSize: 6,
        itemStyle: { color: sentColor },
        areaStyle: { opacity: 0.2 },
        data: props.points.map((p) => ({ name: p.t, value: p.sent })),
      },
      {
        name: '連線數 (Session)',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        connectNulls: false,
        symbol: 'emptyCircle',
        symbolSize: 5,
        lineStyle: { width: 2, type: 'dashed' },
        itemStyle: { color: sessColor },
        data: props.points.map((p) => ({ name: p.t, value: p.sessions })),
      },
    ],
  };
});

function onPick(p: ChartPick) {
  emit('pick', { ...p, chart: 'trend' });
}
</script>

<template>
  <div class="g-trend-dual" :class="{ 'is-flowing': !reduced && !pageHidden }">
    <GEChart chart="trend" :option="option" ariaLabel="上傳與下載流量及 Session 雙軸趨勢圖" @pick="onPick" />
    <div v-if="!reduced" class="g-trend-dual__flow" :class="{ 'is-paused': pageHidden }" aria-hidden="true" />
  </div>
</template>

<style scoped>
.g-trend-dual {
  position: relative;
  overflow: hidden;
  border-radius: var(--radius-sm);
}
/* 載入時一次 1.2s 漸層掃過,之後每 6s 一次輕微流光,背景分頁暫停(§5) */
.g-trend-dual__flow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    105deg,
    transparent 35%,
    color-mix(in srgb, var(--c-primary) 12%, transparent) 50%,
    transparent 65%
  );
  transform: translateX(-120%);
  animation: chartFlowSweep 6s ease-in-out infinite;
}
.g-trend-dual__flow.is-paused {
  animation-play-state: paused;
}
@keyframes chartFlowSweep {
  0% {
    transform: translateX(-120%);
  }
  20%,
  100% {
    transform: translateX(120%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .g-trend-dual__flow {
    display: none !important;
  }
}
</style>
