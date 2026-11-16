<script setup lang="ts">
/**
 * Top 10 頻寬 IP 橫向堆疊長條圖(V-b2;HANDOFF-GEMINI-VIZ §3.3、§4.2):
 *   - 顯示上傳(sent)與下載(recv)堆疊長條
 *   - 點擊長條 emit('pick', { chart: 'topIp', name: item.ip, ... })
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fmtNum, fmtSize } from '@/api/format';
import GEChart from './GEChart.vue';
import type { ChartPick, GTopBarsProps } from './viz-types';

const props = defineProps<GTopBarsProps>();
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

const ordered = computed(() => [...props.items].slice(0, 10).reverse());

const option = computed<Record<string, unknown>>(() => {
  const sentColor = token('--chart-3', '#f5a524');
  const recvColor = token('--chart-1', '#0369a1');
  const list = ordered.value;

  return {
    grid: { top: 32, right: 24, bottom: 24, left: 118, containLabel: false },
    legend: { top: 2, data: ['下載 (Recv)', '上傳 (Sent)'] },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : [params];
        const first = arr[0] as { dataIndex?: number } | undefined;
        const item = list[first?.dataIndex ?? 0];
        if (!item) return '';
        return [
          `<div><strong>${esc(item.ip)}</strong></div>`,
          `<div>總流量：<strong>${esc(fmtSize(item.bytes))}</strong></div>`,
          `<div>下載：<strong>${esc(fmtSize(item.recv))}</strong> · 上傳：<strong>${esc(fmtSize(item.sent))}</strong></div>`,
          `<div>連線數：<strong>${esc(fmtNum(item.sessions))}</strong></div>`,
        ].join('');
      },
    },
    xAxis: {
      type: 'value',
      axisLabel: { formatter: (v: number) => fmtSize(v) },
    },
    yAxis: {
      type: 'category',
      data: list.map((x) => x.ip),
    },
    series: [
      {
        name: '下載 (Recv)',
        type: 'bar',
        stack: 'bw',
        barMaxWidth: 18,
        itemStyle: { color: recvColor },
        data: list.map((x) => ({ name: x.ip, value: x.recv })),
      },
      {
        name: '上傳 (Sent)',
        type: 'bar',
        stack: 'bw',
        barMaxWidth: 18,
        itemStyle: { color: sentColor, borderRadius: [0, 4, 4, 0] },
        data: list.map((x) => ({ name: x.ip, value: x.sent })),
      },
    ],
  };
});

function onPick(p: ChartPick) {
  emit('pick', { ...p, chart: 'topIp' });
}
</script>

<template>
  <GEChart chart="topIp" :option="option" ariaLabel="Top 10 頻寬來源 IP 上傳與下載堆疊長條圖" @pick="onPick" />
</template>
