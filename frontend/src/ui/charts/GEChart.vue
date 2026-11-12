<script setup lang="ts">
/**
 * ECharts 基底元件(V-b1;VIZ-RULES-DESIGN §6.4、§6.5)。**Claude 負責,Gemini 只使用**:圖表元件內部都用這個,傳 option、收 pick。
 *   - 第一次掛載時才動態載入 ECharts(echarts.ts),不進首頁 bundle
 *   - 主題從 CSS 變數讀;<html data-theme / data-style> 改變時重建(明暗、玻璃 / 扁平)
 *   - prefers-reduced-motion 時關閉 ECharts 動畫(option.animation = false)
 *   - 容器大小改變時 resize(ResizeObserver);卸載時 dispose
 *   - click 正規化成 ChartPick:{ chart, series, name, value, data }
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useReducedMotion } from '@/composables/useReducedMotion';
import type { ChartPick, GEChartProps } from './viz-types';

type Lib = typeof import('./echarts');
type Chart = ReturnType<Lib['echarts']['init']>;

const props = withDefaults(defineProps<GEChartProps>(), { height: '320px', loading: false, chart: '' });
const emit = defineEmits<{ (e: 'pick', p: ChartPick): void; (e: 'ready'): void }>();

const el = ref<HTMLDivElement | null>(null);
const failed = ref(false);
const chart = shallowRef<Chart | null>(null);
const { reduced } = useReducedMotion();
let lib: Lib | null = null;
let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;
let key = '';

function render() {
  if (!chart.value) return;
  chart.value.setOption({ ...props.option, animation: reduced.value ? false : props.option.animation !== false, aria: { enabled: true, label: { description: props.ariaLabel } } }, { notMerge: true });
  if (props.loading) chart.value.showLoading('default', { text: '' });
  else chart.value.hideLoading();
}

function create() {
  if (!lib || !el.value) return;
  chart.value?.dispose();
  key = lib.themeKey();
  const c = lib.echarts.init(el.value, lib.buildTheme(), { renderer: 'svg' });
  c.on('click', (e) => {
    const p = e as { seriesName?: string; name?: string; value?: unknown; data?: unknown; dataType?: string };
    const data = p.data as { source?: string; target?: string } | undefined;
    // 桑基圖的連線:name = 「source>target」
    const name = p.dataType === 'edge' && data?.source ? `${data.source}>${data.target}` : String(p.name ?? '');
    emit('pick', { chart: props.chart, series: p.seriesName, name, value: typeof p.value === 'number' ? p.value : undefined, data: p.data });
  });
  chart.value = c;
  render();
}

onMounted(async () => {
  try {
    lib = await import('./echarts');
  } catch {
    failed.value = true;
    return;
  }
  create();
  emit('ready');
  if (typeof ResizeObserver !== 'undefined' && el.value) {
    ro = new ResizeObserver(() => chart.value?.resize());
    ro.observe(el.value);
  }
  // 明暗 / 風格切換:CSS 變數變了,主題要重建
  mo = new MutationObserver(() => {
    if (lib && lib.themeKey() !== key) create();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-style'] });
});

watch(() => [props.option, props.loading, reduced.value], render, { deep: false });

onBeforeUnmount(() => {
  ro?.disconnect();
  mo?.disconnect();
  chart.value?.dispose();
  chart.value = null;
});

defineExpose({ chart });
</script>

<template>
  <div class="g-echart" :style="{ height }">
    <div v-if="failed" class="g-echart__fail" role="alert">圖表載入失敗,請重新整理頁面</div>
    <div v-else ref="el" class="g-echart__canvas" role="img" :aria-label="ariaLabel" />
  </div>
</template>

<style scoped>
.g-echart {
  position: relative;
  width: 100%;
}
.g-echart__canvas {
  width: 100%;
  height: 100%;
}
.g-echart__fail {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--text-3);
  font-size: 13px;
}
</style>
