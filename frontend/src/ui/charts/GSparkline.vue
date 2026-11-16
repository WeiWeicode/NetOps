<script setup lang="ts">
/** 迷你趨勢線(KPI 卡片用):平滑曲線 + 漸層填色,寬度撐滿容器 */
import { computed } from 'vue';
import { toneColor, uid } from './palette';

const props = withDefaults(defineProps<{ values: number[]; tone?: string; height?: number }>(), { tone: 'primary', height: 40 });
const W = 200;
const id = uid('spark');

const pts = computed(() => {
  const v = props.values;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || 1;
  return v.map((y, i) => [(i / Math.max(1, v.length - 1)) * W, props.height - 4 - ((y - min) / span) * (props.height - 10)] as const);
});

/** Catmull-Rom → Bézier 平滑曲線 */
const line = computed(() => {
  const p = pts.value;
  if (!p.length) return '';
  let d = `M${p[0]![0]},${p[0]![1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const [x0, y0] = p[i - 1] ?? p[i]!;
    const [x1, y1] = p[i]!;
    const [x2, y2] = p[i + 1]!;
    const [x3, y3] = p[i + 2] ?? p[i + 1]!;
    d += ` C${x1 + (x2 - x0) / 6},${y1 + (y2 - y0) / 6} ${x2 - (x3 - x1) / 6},${y2 - (y3 - y1) / 6} ${x2},${y2}`;
  }
  return d;
});
const area = computed(() => `${line.value} L${W},${props.height} L0,${props.height} Z`);
const color = computed(() => toneColor(props.tone));
</script>

<template>
  <svg class="g-spark" :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none" :style="{ height: `${height}px` }" aria-hidden="true">
    <defs>
      <linearGradient :id="id" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" :stop-color="color" stop-opacity="0.35" />
        <stop offset="1" :stop-color="color" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path :d="area" :fill="`url(#${id})`" />
    <path :d="line" fill="none" :stroke="color" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" />
  </svg>
</template>

<style scoped>
.g-spark {
  display: block;
  width: 100%;
}
</style>
