<script setup lang="ts">
/**
 * GitHub 風格熱力圖(V-b1 樸素版;介面見 viz-types.ts GHeatmapProps / GHeatmapEmits)。
 * **介面與排版邏輯由 Claude 定;畫面、tooltip、動畫由 Gemini 在 V-b2 改寫**(HANDOFF-GEMINI-VIZ §4.1、§5),props / emits 不變。
 *   版面:年 = 53 欄(週)× 7 列(週一在第一列);月 = 天數欄 × 24 列(小時);日 = 12 欄(5 分鐘)× 24 列(小時)
 *   色階:level 1–4 → --heat-<metric>-1..4;level 0 → --heat-empty;v === null(沒有資料)加斜線底紋,和 0 分開
 *   鍵盤:方向鍵移動、Enter = select、Shift+Enter = drill;雙擊 = drill
 */
import { computed, ref } from 'vue';
import { fmtShort, fmtSize } from '@/api/format';
import type { HeatCell } from '@/api/heatmap';
import type { GHeatmapProps } from './viz-types';

const props = withDefaults(defineProps<GHeatmapProps>(), { loading: false, selected: null, weekStart: 1, animate: true });
const emit = defineEmits<{ (e: 'select', cell: HeatCell): void; (e: 'drill', cell: HeatCell): void; (e: 'hover', cell: HeatCell | null): void }>();

const OFFSET_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;
/** 台灣時間的欄位 */
const local = (iso: string) => {
  const d = new Date(Date.parse(iso) + OFFSET_MS);
  return { day: d.getUTCDate(), dow: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
};

const shape = computed(() => {
  if (props.granularity === 'year') return { cols: 53, rows: 7 };
  if (props.granularity === 'month') return { cols: Math.round((Date.parse(props.to) - Date.parse(props.from)) / DAY_MS), rows: 24 };
  return { cols: 12, rows: 24 };
});

/** 每格的欄 / 列(從 0 開始) */
function place(c: HeatCell): { col: number; row: number } {
  const l = local(c.t);
  if (props.granularity === 'year') return { col: Math.floor((Date.parse(c.t) - Date.parse(props.from)) / (7 * DAY_MS)), row: (l.dow - props.weekStart + 7) % 7 };
  if (props.granularity === 'month') return { col: l.day - 1, row: l.hour };
  return { col: Math.floor(l.minute / 5), row: l.hour };
}

const placed = computed(() => props.cells.map((c, i) => ({ c, i, ...place(c) })));
const byPos = computed(() => new Map(placed.value.map((p) => [`${p.col}:${p.row}`, p.i])));

const metricLabel = computed(() => ({ traffic: '流量', deny: '阻擋', threat: '威脅分數', ad: 'AD 異常' })[props.metric]);
function label(c: HeatCell): string {
  const l = local(c.t);
  const t = c.t.slice(0, 10) + (props.granularity === 'year' ? '' : ` ${String(l.hour).padStart(2, '0')}:${String(l.minute).padStart(2, '0')}`);
  if (c.v === null) return `${t},沒有資料`;
  const v = props.metric === 'traffic' ? fmtSize(c.v) : fmtShort(c.v);
  const th = c.tip.threats;
  return `${t},${metricLabel.value} ${v},威脅 ${th.critical + th.high + th.medium + th.low}${c.partial ? ',資料不完整' : ''}`;
}

const focusIndex = ref(0);
const btns = ref<HTMLButtonElement[]>([]);
function move(i: number, dc: number, dr: number) {
  const p = placed.value[i];
  if (!p) return;
  const j = byPos.value.get(`${p.col + dc}:${p.row + dr}`);
  if (j === undefined) return;
  focusIndex.value = j;
  btns.value[j]?.focus();
}
function onKey(e: KeyboardEvent, i: number, c: HeatCell) {
  const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (d[e.key]) {
    e.preventDefault();
    move(i, d[e.key]![0], d[e.key]![1]);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) emit('drill', c);
    else emit('select', c);
  }
}
</script>

<template>
  <div class="g-heatmap" :class="[`is-${granularity}`, { 'is-loading': loading }]" role="grid" :aria-busy="loading" :style="{ '--cols': shape.cols, '--rows': shape.rows }">
    <button
      v-for="p in placed"
      :key="p.c.t"
      ref="btns"
      type="button"
      role="gridcell"
      class="g-heatmap__cell"
      :class="[`lv-${p.c.level}`, { 'is-null': p.c.v === null, 'is-partial': p.c.partial, 'is-selected': selected === p.c.t }]"
      :style="{ gridColumn: p.col + 1, gridRow: p.row + 1, '--heat': p.c.level ? `var(--heat-${metric}-${p.c.level})` : 'var(--heat-empty)' }"
      :tabindex="p.i === focusIndex ? 0 : -1"
      :aria-label="label(p.c)"
      :title="label(p.c)"
      @click="emit('select', p.c)"
      @dblclick="emit('drill', p.c)"
      @keydown="onKey($event, p.i, p.c)"
      @focus="focusIndex = p.i"
      @mouseenter="emit('hover', p.c)"
      @mouseleave="emit('hover', null)"
    />
  </div>
</template>

<style scoped>
.g-heatmap {
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(10px, 1fr));
  grid-template-rows: repeat(var(--rows), 12px);
  gap: 2px;
  overflow-x: auto;
}
.g-heatmap.is-loading {
  opacity: 0.5;
}
.g-heatmap__cell {
  border: 0;
  padding: 0;
  border-radius: 2px;
  background: var(--heat);
  cursor: pointer;
}
.g-heatmap__cell.is-null {
  background: repeating-linear-gradient(45deg, var(--heat-empty) 0 2px, transparent 2px 4px);
}
.g-heatmap__cell.is-partial {
  outline: 1px dashed var(--text-3);
  outline-offset: -1px;
}
.g-heatmap__cell.is-selected,
.g-heatmap__cell:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 0;
}
</style>
