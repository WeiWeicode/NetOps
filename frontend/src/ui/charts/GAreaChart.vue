<script setup lang="ts">
/**
 * 面積 / 折線圖:多條 series,x 軸 labels;滑鼠移動顯示該點所有 series 的數值。
 * 寬度隨容器縮放(ResizeObserver),文字不被 viewBox 拉伸。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { chartColor, uid } from './palette';

const props = withDefaults(
  defineProps<{ labels: string[]; series: { name: string; values: number[]; color?: string; area?: boolean }[]; height?: number; unit?: string }>(),
  { height: 240, unit: '' },
);

const el = ref<HTMLElement>();
const width = ref(600);
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(([e]) => (width.value = Math.max(240, e!.contentRect.width)));
  ro.observe(el.value!);
});
onBeforeUnmount(() => ro?.disconnect());

const PAD = { l: 44, r: 12, t: 12, b: 26 };
const ids = props.series.map(() => uid('area'));
const max = computed(() => {
  const m = Math.max(1, ...props.series.flatMap((s) => s.values));
  const mag = 10 ** Math.floor(Math.log10(m));
  return Math.ceil(m / mag) * mag;
});
const innerW = computed(() => width.value - PAD.l - PAD.r);
const innerH = computed(() => props.height - PAD.t - PAD.b);
const x = (i: number) => PAD.l + (i / Math.max(1, props.labels.length - 1)) * innerW.value;
const y = (v: number) => PAD.t + innerH.value - (v / max.value) * innerH.value;
const ticks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((t) => ({ y: y(max.value * t), label: fmt(max.value * t) })));
const xTicks = computed(() => {
  const step = Math.ceil(props.labels.length / Math.max(2, Math.floor(innerW.value / 70)));
  return props.labels.map((l, i) => ({ l, i })).filter(({ i }) => i % step === 0);
});

function fmt(v: number) {
  return v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(Math.round(v));
}
function path(values: number[]) {
  return values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
}
const colors = computed(() => props.series.map((s, i) => s.color ?? chartColor(i)));

const hover = ref<number | null>(null);
function onMove(e: MouseEvent) {
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
  const rel = (e.clientX - rect.left - PAD.l) / innerW.value;
  hover.value = Math.max(0, Math.min(props.labels.length - 1, Math.round(rel * (props.labels.length - 1))));
}
</script>

<template>
  <div ref="el" class="g-area">
    <div class="legend">
      <span v-for="(s, i) in series" :key="s.name" class="lg"><i :style="{ background: colors[i] }" />{{ s.name }}</span>
    </div>
    <svg :width="width" :height="height" role="img" :aria-label="series.map((s) => s.name).join('、')" @mousemove="onMove" @mouseleave="hover = null">
      <defs>
        <linearGradient v-for="(s, i) in series" :id="ids[i]" :key="s.name" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" :stop-color="colors[i]" stop-opacity="0.32" />
          <stop offset="1" :stop-color="colors[i]" stop-opacity="0" />
        </linearGradient>
      </defs>
      <g class="grid">
        <line v-for="t in ticks" :key="t.y" :x1="PAD.l" :x2="width - PAD.r" :y1="t.y" :y2="t.y" />
        <text v-for="t in ticks" :key="`t${t.y}`" :x="PAD.l - 8" :y="t.y + 4" text-anchor="end">{{ t.label }}</text>
        <text v-for="t in xTicks" :key="`x${t.i}`" :x="x(t.i)" :y="height - 6" text-anchor="middle">{{ t.l }}</text>
      </g>
      <g v-for="(s, i) in series" :key="s.name">
        <path v-if="s.area !== false" :d="`${path(s.values)} L${x(s.values.length - 1)},${y(0)} L${x(0)},${y(0)} Z`" :fill="`url(#${ids[i]})`" />
        <path :d="path(s.values)" fill="none" :stroke="colors[i]" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />
      </g>
      <g v-if="hover !== null">
        <line class="cursor" :x1="x(hover)" :x2="x(hover)" :y1="PAD.t" :y2="PAD.t + innerH" />
        <circle v-for="(s, i) in series" :key="s.name" :cx="x(hover)" :cy="y(s.values[hover] ?? 0)" r="4.5" :fill="colors[i]" class="dot" />
      </g>
    </svg>
    <div v-if="hover !== null" class="tip glass" :style="{ left: `${Math.min(x(hover) + 12, width - 170)}px` }">
      <strong>{{ labels[hover] }}</strong>
      <span v-for="(s, i) in series" :key="s.name" class="row"
        ><i :style="{ background: colors[i] }" />{{ s.name }}<b class="num">{{ (s.values[hover] ?? 0).toLocaleString() }}{{ unit }}</b></span
      >
    </div>
  </div>
</template>

<style scoped>
.g-area {
  position: relative;
  width: 100%;
}
svg {
  display: block;
}
.legend {
  display: flex;
  gap: 16px;
  margin-bottom: 8px;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.lg i,
.row i {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}
.grid line {
  stroke: var(--line);
  stroke-dasharray: 3 4;
}
.grid text {
  fill: var(--text-3);
  font-size: 11px;
}
.cursor {
  stroke: var(--line-strong);
}
.dot {
  stroke: var(--bg);
  stroke-width: 2;
}
.tip {
  position: absolute;
  top: 34px;
  min-width: 150px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--glass-strong);
  font-size: var(--fs-sm);
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: none;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
}
.row b {
  margin-left: auto;
  color: var(--text);
}
</style>
