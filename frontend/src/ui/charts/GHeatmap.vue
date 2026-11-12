<script setup lang="ts">
/**
 * GitHub 風格活動熱力圖(V-b2;HANDOFF-GEMINI-VIZ §3.1、§4.1、§5):
 *   - 版面:年 = 53 欄(週)× 7 列(週一在第一列,上方標月份);月 = 28–31 欄(日)× 24 列(小時);日 = 12 欄(5 分鐘)× 24 列(小時)
 *   - 色階:level 1–4 → --heat-<metric>-1..4;level 0 → --heat-empty;v === null(沒有資料)加斜線底紋,和 0 分開;partial 加小標記
 *   - 鍵盤:方向鍵移動、Enter = select、Shift+Enter = drill;雙擊 = drill
 *   - 觸控:點一下顯示毛玻璃 tooltip、再點同一格開抽屜
 *   - 動畫:第一次載入與切換粒度時 stagger 進場(240ms + min(i*4, 360)ms ≤ 600ms),自動刷新不重播;hover / focus 放大 1.25x(reduced-motion 時關閉)
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { fmtNum, fmtShort, fmtSize } from '@/api/format';
import type { HeatCell, HeatGranularity } from '@/api/heatmap';
import { useReducedMotion } from '@/composables/useReducedMotion';
import { formatRange, plusSeconds } from '@/composables/vizTime';
import type { GHeatmapProps } from './viz-types';

const props = withDefaults(defineProps<GHeatmapProps>(), {
  loading: false,
  selected: null,
  weekStart: 1,
  animate: true,
});
const emit = defineEmits<{
  (e: 'select', cell: HeatCell): void;
  (e: 'drill', cell: HeatCell): void;
  (e: 'hover', cell: HeatCell | null): void;
}>();

const { reduced } = useReducedMotion();

const OFFSET_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;

/** 台灣時間欄位 */
function local(iso: string) {
  const d = new Date(Date.parse(iso) + OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    dow: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

const bucketSec = computed(() => (props.granularity === 'year' ? 86400 : props.granularity === 'month' ? 3600 : 300));

const shape = computed(() => {
  if (props.granularity === 'year') return { cols: 53, rows: 7 };
  if (props.granularity === 'month') {
    const days = Math.max(1, Math.round((Date.parse(props.to) - Date.parse(props.from)) / DAY_MS));
    return { cols: days, rows: 24 };
  }
  return { cols: 12, rows: 24 };
});

/** 每格的欄 / 列(從 0 開始) */
function place(c: HeatCell): { col: number; row: number } {
  const l = local(c.t);
  if (props.granularity === 'year') {
    return {
      col: Math.max(0, Math.min(52, Math.floor((Date.parse(c.t) - Date.parse(props.from)) / (7 * DAY_MS)))),
      row: (l.dow - props.weekStart + 7) % 7,
    };
  }
  if (props.granularity === 'month') return { col: l.day - 1, row: l.hour };
  return { col: Math.floor(l.minute / 5), row: l.hour };
}

const placed = computed(() => props.cells.map((c, i) => ({ c, i, ...place(c) })));
const byPos = computed(() => new Map(placed.value.map((p) => [`${p.col}:${p.row}`, p.i])));

/** 上方欄標頭(年=月份、月=日期、日=5分鐘刻度) */
const colHeaders = computed(() => {
  if (props.granularity === 'year') {
    const headers: { col: number; text: string }[] = [];
    const fromMs = Date.parse(props.from);
    if (Number.isNaN(fromMs)) return headers;
    let prevMonth = -1;
    for (let col = 0; col < 53; col++) {
      const d = new Date(fromMs + col * 7 * DAY_MS + OFFSET_MS);
      const m = d.getUTCMonth() + 1;
      if (m !== prevMonth) {
        if (headers.length === 0 || col - headers[headers.length - 1]!.col >= 3) {
          headers.push({ col, text: `${m}月` });
        }
        prevMonth = m;
      }
    }
    return headers;
  }
  if (props.granularity === 'month') {
    return Array.from({ length: shape.value.cols }, (_, col) => ({
      col,
      text: String(col + 1),
    }));
  }
  return Array.from({ length: 12 }, (_, col) => ({
    col,
    text: `:${String(col * 5).padStart(2, '0')}`,
  }));
});

/** 左側列標頭(年=星期、月/日=小時) */
const rowHeaders = computed(() => {
  if (props.granularity === 'year') {
    const names = props.weekStart === 1 ? ['週一', '週二', '週三', '週四', '週五', '週六', '週日'] : ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    return names.map((text, row) => ({ row, text }));
  }
  return Array.from({ length: 24 }, (_, row) => ({
    row,
    text: `${String(row).padStart(2, '0')}:00`,
  }));
});

const metricLabel = computed(() => ({ traffic: '流量', deny: '阻擋', threat: '威脅分數', ad: 'AD 異常' })[props.metric]);

function cellRangeText(c: HeatCell): string {
  return formatRange(c.t, plusSeconds(c.t, bucketSec.value));
}

function label(c: HeatCell): string {
  const t = cellRangeText(c);
  if (c.v === null) return `${t},沒有資料`;
  const v = props.metric === 'traffic' ? fmtSize(c.v) : fmtShort(c.v);
  const th = c.tip.threats;
  const totalThreats = th.critical + th.high + th.medium + th.low;
  return `${t},${metricLabel.value} ${v},威脅 ${totalThreats}${c.partial ? ',此時段資料不完整' : ''}`;
}

function topIpForMetric(c: HeatCell): string {
  if (c.v === null) return '—';
  const ip =
    props.metric === 'traffic'
      ? c.tip.topIp.traffic
      : props.metric === 'deny'
        ? c.tip.topIp.deny
        : c.tip.topIp.threat;
  return ip ? `約 ${ip}` : '—';
}

const topIpTitle = computed(() =>
  props.metric === 'traffic' ? 'Top 1 流量來源 IP' : props.metric === 'deny' ? 'Top 1 阻擋來源 IP' : 'Top 1 威脅來源 IP',
);

/* ───── Stagger 進場動畫:只在第一次載入與切換粒度時播放,自動刷新不播(§5) ───── */
const lastAnimatedGranularity = ref<HeatGranularity | null>(null);
const staggering = ref(false);
let staggerTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  [() => props.granularity, () => props.cells.length, () => props.animate, reduced],
  ([g, len, anim, red]) => {
    if (!anim || red) {
      staggering.value = false;
      lastAnimatedGranularity.value = g;
      return;
    }
    if (len > 0 && lastAnimatedGranularity.value !== g) {
      lastAnimatedGranularity.value = g;
      staggering.value = true;
      clearTimeout(staggerTimer);
      staggerTimer = setTimeout(() => {
        staggering.value = false;
      }, 620);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  clearTimeout(staggerTimer);
});

/* ───── 鍵盤導覽、Hover Tooltip 與觸控兩段點擊(§4.1) ───── */
const focusIndex = ref(0);
const root = ref<HTMLElement | null>(null);
const activeCell = ref<HeatCell | null>(null);
const tipPos = ref<{ x: number; y: number; alignRight: boolean; alignBottom: boolean }>({
  x: 0,
  y: 0,
  alignRight: false,
  alignBottom: false,
});
const lastTouchType = ref(false);
const touchArmedT = ref<string | null>(null);

watch(
  () => props.cells.length,
  (n) => {
    if (focusIndex.value >= n) focusIndex.value = Math.max(0, n - 1);
    activeCell.value = null;
    touchArmedT.value = null;
  },
);

function updateTipPosition(target: HTMLElement | null) {
  if (!target || !root.value) return;
  const rootRect = root.value.getBoundingClientRect();
  const cellRect = target.getBoundingClientRect();
  const x = cellRect.left - rootRect.left + cellRect.width / 2;
  const y = cellRect.top - rootRect.top;
  tipPos.value = {
    x,
    y,
    alignRight: x > rootRect.width - 150,
    alignBottom: y < 140,
  };
}

function showTip(c: HeatCell, target: EventTarget | null) {
  activeCell.value = c;
  updateTipPosition(target as HTMLElement | null);
  emit('hover', c);
}

function hideTip() {
  activeCell.value = null;
  emit('hover', null);
}

function onPointerDown(e: PointerEvent) {
  lastTouchType.value = e.pointerType === 'touch';
}

function onCellClick(e: MouseEvent, c: HeatCell) {
  if (lastTouchType.value) {
    if (touchArmedT.value !== c.t) {
      touchArmedT.value = c.t;
      showTip(c, e.currentTarget);
      return;
    }
    touchArmedT.value = null;
  }
  emit('select', c);
}

function move(i: number, dc: number, dr: number) {
  const p = placed.value[i];
  if (!p) return;
  const j = byPos.value.get(`${p.col + dc}:${p.row + dr}`);
  if (j === undefined) return;
  focusIndex.value = j;
  const btn = root.value?.querySelector<HTMLButtonElement>(`[data-i="${j}"]`);
  btn?.focus();
  if (btn && placed.value[j]) showTip(placed.value[j]!.c, btn);
}

function onKey(e: KeyboardEvent, i: number, c: HeatCell) {
  const d: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  if (d[e.key]) {
    e.preventDefault();
    move(i, d[e.key]![0], d[e.key]![1]);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) emit('drill', c);
    else emit('select', c);
  } else if (e.key === 'Escape') {
    hideTip();
  }
}
</script>

<template>
  <div
    ref="root"
    class="g-heatmap-wrap"
    :class="[`is-${granularity}`, { 'is-loading': loading, 'is-stagger': staggering }]"
    role="group"
    aria-label="熱力圖(方向鍵移動、Enter 開明細、Shift+Enter 下鑽)"
    :aria-busy="loading"
    @mouseleave="hideTip"
  >
    <div class="g-heatmap__scroll">
      <div class="g-heatmap__frame" :style="{ '--cols': shape.cols, '--rows': shape.rows }">
        <div class="g-heatmap__corner" aria-hidden="true" />
        <div class="g-heatmap__cols" aria-hidden="true">
          <span
            v-for="ch in colHeaders"
            :key="ch.col"
            class="g-heatmap__col-lbl"
            :style="{ gridColumn: ch.col + 1 }"
          >
            {{ ch.text }}
          </span>
        </div>

        <div class="g-heatmap__rows" aria-hidden="true">
          <span
            v-for="rh in rowHeaders"
            :key="rh.row"
            class="g-heatmap__row-lbl"
            :class="{ 'is-Subtle': granularity !== 'year' && rh.row % 3 !== 0 }"
            :style="{ gridRow: rh.row + 1 }"
          >
            {{ granularity === 'year' || rh.row % 2 === 0 ? rh.text : '' }}
          </span>
        </div>

        <div class="g-heatmap" :style="{ '--cols': shape.cols, '--rows': shape.rows }">
          <button
            v-for="p in placed"
            :key="p.c.t"
            type="button"
            :data-i="p.i"
            class="g-heatmap__cell"
            :class="[
              `lv-${p.c.level}`,
              {
                'is-null': p.c.v === null,
                'is-partial': p.c.partial,
                'is-selected': selected === p.c.t,
              },
            ]"
            :style="{
              gridColumn: p.col + 1,
              gridRow: p.row + 1,
              '--heat': p.c.level ? `var(--heat-${metric}-${p.c.level})` : 'var(--heat-empty)',
              '--delay': `${Math.min(p.i * 4, 360)}ms`,
            }"
            :tabindex="p.i === focusIndex ? 0 : -1"
            :aria-label="label(p.c)"
            @pointerdown="onPointerDown"
            @click="onCellClick($event, p.c)"
            @dblclick="emit('drill', p.c)"
            @keydown="onKey($event, p.i, p.c)"
            @focus="
              focusIndex = p.i;
              showTip(p.c, $event.currentTarget);
            "
            @blur="hideTip"
            @mouseenter="showTip(p.c, $event.currentTarget)"
          />
        </div>
      </div>
    </div>

    <Transition name="g-heat-tip">
      <div
        v-if="activeCell"
        class="g-heatmap__tip"
        :class="{ 'is-right': tipPos.alignRight, 'is-bottom': tipPos.alignBottom }"
        :style="{ left: `${tipPos.x}px`, top: `${tipPos.y}px` }"
        role="tooltip"
      >
        <div class="g-heatmap__tip-head">
          <strong class="mono">{{ cellRangeText(activeCell) }}</strong>
          <span v-if="activeCell.partial" class="g-heatmap__tip-tag">此時段資料不完整</span>
        </div>
        <div v-if="activeCell.v === null" class="g-heatmap__tip-null">沒有資料（彙總表起點之前）</div>
        <template v-else>
          <div class="g-heatmap__tip-grid">
            <span>總流量</span>
            <strong class="num">{{ fmtSize(activeCell.tip.bytes) }}</strong>
            <span>連線數</span>
            <strong class="num">{{ fmtNum(activeCell.tip.sessions) }}</strong>
            <span>阻擋數</span>
            <strong class="num">{{ fmtNum(activeCell.tip.deny) }}</strong>
            <span>威脅事件</span>
            <strong class="num">
              嚴重 {{ activeCell.tip.threats.critical }} · 高 {{ activeCell.tip.threats.high }} · 中 {{ activeCell.tip.threats.medium }} · 低 {{ activeCell.tip.threats.low }}
            </strong>
            <span>{{ topIpTitle }}</span>
            <strong class="mono">{{ topIpForMetric(activeCell) }}</strong>
          </div>
          <div v-if="lastTouchType && touchArmedT === activeCell.t" class="g-heatmap__tip-hint">再次點擊開啟時段明細</div>
        </template>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.g-heatmap-wrap {
  position: relative;
  min-width: 0;
  max-width: 100%;
}
.g-heatmap-wrap.is-loading {
  opacity: 0.55;
  transition: opacity 150ms var(--ease);
}
/* 375px 時橫向捲動熱力圖區塊本身,不是整頁(§3.1) */
.g-heatmap__scroll {
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 6px;
}
.g-heatmap__frame {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto 1fr;
  gap: 6px 8px;
  min-width: max-content;
}
.g-heatmap__cols {
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(var(--cell-w, 13px), 1fr));
  gap: 3px;
  align-items: end;
  min-height: 16px;
}
.g-heatmap__col-lbl {
  font-size: 11px;
  line-height: 1;
  color: var(--text-3);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.g-heatmap__rows {
  display: grid;
  grid-template-rows: repeat(var(--rows), var(--cell-h, 13px));
  gap: 3px;
  align-items: center;
  padding-right: 4px;
}
.g-heatmap__row-lbl {
  font-size: 11px;
  line-height: 1;
  color: var(--text-3);
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.g-heatmap {
  --cell-w: 13px;
  --cell-h: 13px;
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(var(--cell-w), 1fr));
  grid-template-rows: repeat(var(--rows), var(--cell-h));
  gap: 3px;
  padding: 2px;
}
.is-month .g-heatmap,
.is-month .g-heatmap__cols {
  --cell-w: 18px;
  --cell-h: 14px;
}
.is-month .g-heatmap__rows {
  --cell-h: 14px;
}
.is-day .g-heatmap,
.is-day .g-heatmap__cols {
  --cell-w: 36px;
  --cell-h: 15px;
}
.is-day .g-heatmap__rows {
  --cell-h: 15px;
}

.g-heatmap__cell {
  position: relative;
  border: 0;
  padding: 0;
  border-radius: 3px;
  background: var(--heat);
  cursor: pointer;
  transition:
    transform 120ms ease-out,
    box-shadow 120ms ease-out,
    outline-color 120ms ease-out;
}
/* v === null(沒有資料):斜線底紋,與 level 0 淺色空格區分(§3.1、§7) */
.g-heatmap__cell.is-null {
  background: repeating-linear-gradient(
    -45deg,
    var(--heat-empty) 0 2.5px,
    transparent 2.5px 5px
  );
  border: 1px solid var(--line-strong);
}
/* partial 格子:小標記 + 虛線外框(§3.1、§7) */
.g-heatmap__cell.is-partial {
  outline: 1px dashed var(--c-warning);
  outline-offset: -1px;
}
.g-heatmap__cell.is-partial::after {
  content: '';
  position: absolute;
  top: 1px;
  right: 1px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--c-warning);
}
/* hover 與鍵盤焦點放大 1.25x、提高 z-index、加 1px 外框(§5) */
.g-heatmap__cell:hover,
.g-heatmap__cell:focus-visible {
  transform: scale(1.25);
  z-index: 5;
  outline: 1px solid var(--text);
  outline-offset: 0;
  box-shadow: var(--shadow-sm);
}
.g-heatmap__cell.is-selected {
  z-index: 4;
  outline: 2px solid var(--c-primary);
  outline-offset: 0;
}

/* Stagger 進場動畫:opacity 0→1 + scale .6→1,240ms ease-out,延遲 ≤ 360ms(總長 ≤ 600ms)(§5) */
.is-stagger .g-heatmap__cell {
  animation: heatCellIn 240ms ease-out both;
  animation-delay: var(--delay, 0ms);
}
@keyframes heatCellIn {
  from {
    opacity: 0;
    transform: scale(0.6);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* 毛玻璃 tooltip(§5) */
.g-heatmap__tip {
  position: absolute;
  z-index: 30;
  width: max-content;
  max-width: 280px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--glass-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-md);
  color: var(--text);
  font-size: var(--fs-xs);
  pointer-events: none;
  transform: translate(-50%, calc(-100% - 10px));
}
.g-heatmap__tip.is-right {
  transform: translate(-90%, calc(-100% - 10px));
}
.g-heatmap__tip.is-bottom {
  transform: translate(-50%, 22px);
}
.g-heatmap__tip.is-right.is-bottom {
  transform: translate(-90%, 22px);
}
.g-heatmap__tip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--line);
}
.g-heatmap__tip-tag {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: var(--badge-hot);
  background: color-mix(in srgb, var(--c-warning) 15%, transparent);
}
.g-heatmap__tip-null {
  color: var(--text-2);
}
.g-heatmap__tip-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 10px;
  align-items: baseline;
}
.g-heatmap__tip-grid > span {
  color: var(--text-2);
}
.g-heatmap__tip-grid > strong {
  text-align: right;
}
.g-heatmap__tip-hint {
  margin-top: 6px;
  padding-top: 4px;
  border-top: 1px dashed var(--line);
  color: var(--c-primary-text);
  font-weight: 600;
  text-align: center;
}

.g-heat-tip-enter-active,
.g-heat-tip-leave-active {
  transition: opacity 120ms ease-out;
}
.g-heat-tip-enter-from,
.g-heat-tip-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .is-stagger .g-heatmap__cell {
    animation: none !important;
  }
  .g-heatmap__cell:hover,
  .g-heatmap__cell:focus-visible {
    transform: none !important;
  }
  .g-heat-tip-enter-active,
  .g-heat-tip-leave-active {
    transition-duration: 0ms !important;
  }
}
</style>
