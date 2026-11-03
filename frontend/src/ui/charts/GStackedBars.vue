<script setup lang="ts">
/**
 * 堆疊長條圖(NetOps 新增;流量總覽每小時允許 / 阻擋):labels 為 x 軸,series 依序由下往上堆疊。
 * 滑鼠移到長條顯示該點所有 series 與 extra 補充;clickable 時點長條送出 pick(索引),鍵盤可用 Tab / Enter / Space
 * (長條超過 48 根時不逐根停駐,避免上千個 Tab;仍可用滑鼠點選)。titles 為提示框標題(預設用 labels),integer 時刻度至少 1。
 * 寬度隨容器縮放(ResizeObserver),樣式與 GAreaChart 一致;數值格式由 format 決定(預設千分位)。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { toneColor } from './palette';

const props = withDefaults(
  defineProps<{
    labels: string[];
    /** 提示框標題(例如完整日期時間);沒有時用 labels */
    titles?: string[];
    /** 計數類:刻度不出現小數 */
    integer?: boolean;
    series: { name: string; values: number[]; tone: string }[];
    /** 提示框額外列(例如流量);每個 x 一組 */
    extra?: { label: string; value: string }[][];
    height?: number;
    format?: (v: number) => string;
    clickable?: boolean;
    /** 點選說明(滑鼠提示的最後一行) */
    pickHint?: string;
  }>(),
  { height: 220, format: (v: number) => v.toLocaleString(), pickHint: '' },
);
const emit = defineEmits<{ pick: [number] }>();

const el = ref<HTMLElement>();
const width = ref(600);
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(([e]) => (width.value = Math.max(240, e!.contentRect.width)));
  ro.observe(el.value!);
});
onBeforeUnmount(() => ro?.disconnect());

const PAD = { l: 56, r: 8, t: 12, b: 26 };
const totals = computed(() => props.labels.map((_, i) => props.series.reduce((a, s) => a + (s.values[i] ?? 0), 0)));
/** 刻度取 1、2、5 × 10^n */
const scale = computed(() => {
  const max = Math.max(1, ...totals.value);
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const step = props.integer ? Math.max(1, nice) : nice;
  return { step, top: Math.ceil(max / step) * step };
});
const innerW = computed(() => width.value - PAD.l - PAD.r);
const innerH = computed(() => props.height - PAD.t - PAD.b);
const y = (v: number) => PAD.t + innerH.value * (1 - v / scale.value.top);
const slot = computed(() => innerW.value / Math.max(1, props.labels.length));
const barW = computed(() => Math.max(2, Math.min(24, slot.value * 0.7)));
const ticks = computed(() => {
  const out: { v: number; y: number }[] = [];
  // 用 i × step 產生,避免小數累加誤差
  const n = Math.round(scale.value.top / scale.value.step);
  for (let i = 0; i <= n; i++) {
    const v = +(i * scale.value.step).toPrecision(12);
    out.push({ v, y: y(v) });
  }
  return out;
});
const xTicks = computed(() => {
  // 標籤越長間距越大(「MM-DD HH」約 70px)
  const gap = Math.max(...props.labels.map((l) => l.length), 2) > 5 ? 84 : 56;
  const every = Math.ceil(props.labels.length / Math.max(2, Math.floor(innerW.value / gap)));
  return props.labels.map((l, i) => ({ l, i })).filter(({ i }) => i % every === 0);
});
const bars = computed(() =>
  props.labels.map((_, i) => {
    let base = 0;
    const segs = props.series.map((s) => {
      const v = s.values[i] ?? 0;
      const seg = { y: y(base + v), h: Math.max(0, y(base) - y(base + v)), color: toneColor(s.tone) };
      base += v;
      return seg;
    });
    return { x: PAD.l + slot.value * i + (slot.value - barW.value) / 2, segs };
  }),
);

const hover = ref<number | null>(null);
/** 長條太多時不逐根放進 Tab 順序 */
const focusable = computed(() => props.clickable && props.labels.length <= 48);
const tipLeft = computed(() => (hover.value === null ? 0 : Math.min(PAD.l + slot.value * hover.value + slot.value, width.value - 190)));
</script>

<template>
  <div ref="el" class="g-bars">
    <div class="legend">
      <span v-for="s in series" :key="s.name" class="lg"><i :style="{ background: toneColor(s.tone) }" />{{ s.name }}</span>
      <span v-if="clickable && pickHint" class="faint">{{ pickHint }}</span>
    </div>
    <svg :width="width" :height="height" role="group" :aria-label="series.map((s) => s.name).join('、')" @mouseleave="hover = null">
      <g class="grid">
        <line v-for="t in ticks" :key="t.v" :x1="PAD.l" :x2="width - PAD.r" :y1="t.y" :y2="t.y" />
        <text v-for="t in ticks" :key="`t${t.v}`" :x="PAD.l - 8" :y="t.y + 4" text-anchor="end">{{ format(t.v) }}</text>
        <text v-for="t in xTicks" :key="`x${t.i}`" :x="PAD.l + slot * t.i + slot / 2" :y="height - 6" text-anchor="middle">{{ t.l }}</text>
      </g>
      <g v-for="(b, i) in bars" :key="i">
        <rect
          v-for="(s, k) in b.segs"
          :key="k"
          :x="b.x"
          :y="s.y"
          :width="barW"
          :height="s.h"
          :fill="s.color"
          rx="2"
          :opacity="hover === null || hover === i ? 1 : 0.55"
        />
        <rect
          class="hit"
          :class="{ clickable }"
          :x="PAD.l + slot * i"
          :y="PAD.t"
          :width="slot"
          :height="innerH"
          fill="transparent"
          :tabindex="focusable ? 0 : undefined"
          :role="clickable ? 'button' : undefined"
          :aria-label="clickable ? `${labels[i]}:${series.map((s) => `${s.name} ${format(s.values[i] ?? 0)}`).join(',')}` : undefined"
          @mouseenter="hover = i"
          @focus="hover = i"
          @blur="hover = null"
          @click="clickable && emit('pick', i)"
          @keydown.enter="clickable && emit('pick', i)"
          @keydown.space.prevent="clickable && emit('pick', i)"
        />
      </g>
    </svg>
    <div v-if="hover !== null" class="tip glass" :style="{ left: `${tipLeft}px` }">
      <strong>{{ titles?.[hover] ?? labels[hover] }}</strong>
      <span v-for="s in series" :key="s.name" class="row"
        ><i :style="{ background: toneColor(s.tone) }" />{{ s.name }}<b class="num">{{ format(s.values[hover] ?? 0) }}</b></span
      >
      <span v-for="x in extra?.[hover] ?? []" :key="x.label" class="row"
        ><i />{{ x.label }}<b class="num">{{ x.value }}</b></span
      >
    </div>
  </div>
</template>

<style scoped>
.g-bars {
  position: relative;
  width: 100%;
  min-width: 0;
  overflow: hidden;
}
svg {
  display: block;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
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
.hit {
  outline: none;
}
.hit.clickable {
  cursor: pointer;
}
.hit.clickable:focus-visible {
  stroke: var(--focus-ring);
  stroke-width: 2;
}
.tip {
  position: absolute;
  top: 34px;
  min-width: 170px;
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
