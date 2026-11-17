<script lang="ts">
export const LOG_OPEN_KEY = 'wr-log';
export function readLogOpen(): boolean {
  try {
    return localStorage.getItem(LOG_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}
</script>

<script setup lang="ts">
/**
 * 戰情室底部 TRAFFIC LOG 表格(WR-5;WARROOM-GEMINI-HANDOFF §2、§3):
 *   - 篩選:全部(all) / 阻擋(deny) / 允許(allow) / 威脅(threat)
 *   - 暫停 / 繼續切換(w.paused)
 *   - 聚焦節點同步篩選提示與一鍵清除聚焦
 *   - 欄位:時間、動作、來源 IP、國家、目的 IP、區段、Port、App、規則、Bytes、Session(威脅顯示威脅名稱/嚴重度)
 *   - 支援 IP 對照表(GIpLabel)與連到 Log 明細查詢(/firewall/search)
 *   - 虛擬捲動(2026-11-17):固定列高 + table-layout: fixed,只渲染可見列;原本每秒整表 200 列重排 50–70ms,
 *     是真實流量下最後的掉幀來源(暫停 Log 表 95 fps、不暫停 23 fps)
 *   - 可收摺(v-model:open,狀態記在 localStorage 'wr-log');收摺時表身卸載,不再更新 DOM
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { fmtClock, fmtNum } from '@/api/format';
import type { LiveLog } from '@/api/paLive';
import type { WarroomSegment, WarroomSource } from '@/api/warroom';
import { classifyLog, type Focus, type LogFilterKind } from '@/composables/useWarroom';
import GIpLabel from '@/ui/components/GIpLabel.vue';

const props = withDefaults(defineProps<{
  logs: readonly LiveLog[];
  filter: LogFilterKind;
  /** 展開(預設);收摺時只留標題列 */
  open?: boolean;
  paused: boolean;
  focus: Focus | null;
  sources?: readonly WarroomSource[];
  segments?: readonly WarroomSegment[];
}>(), { open: true });

const emit = defineEmits<{
  (e: 'update:filter', v: LogFilterKind): void;
  (e: 'update:paused', v: boolean): void;
  (e: 'clearFocus'): void;
  (e: 'update:open', v: boolean): void;
}>();

const isOpen = computed(() => props.open !== false);

function toggleOpen() {
  const next = !isOpen.value;
  try {
    localStorage.setItem(LOG_OPEN_KEY, next ? '1' : '0');
  } catch {
    /* 無法寫入 localStorage 時僅影響重整後記憶 */
  }
  emit('update:open', next);
}

// ── 虛擬捲動 ──────────────────────────────────────────────────────────────
/** 每列固定高度(px):CSS td 高 24 + 上框線 1(border-collapse) */
const ROW_H = 25;
/** 可見範圍上下多渲染的列數 */
const OVERSCAN = 6;
const bodyEl = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewH = ref(200);
let resizeObs: ResizeObserver | null = null;
let scrollRaf = 0;

function onScroll() {
  if (typeof requestAnimationFrame !== 'function') {
    if (bodyEl.value) scrollTop.value = bodyEl.value.scrollTop;
    return;
  }
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (bodyEl.value) scrollTop.value = bodyEl.value.scrollTop;
  });
}

watch(bodyEl, (el, _old, onCleanup) => {
  if (!el) return;
  // 收摺後重新展開是新的元素(scrollTop 0),不能沿用舊值
  scrollTop.value = el.scrollTop;
  viewH.value = el.clientHeight || viewH.value;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(() => (viewH.value = el.clientHeight || viewH.value));
    resizeObs.observe(el);
  }
  onCleanup(() => {
    resizeObs?.disconnect();
    resizeObs = null;
  });
});
onBeforeUnmount(() => {
  if (scrollRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scrollRaf);
  resizeObs?.disconnect();
});

const range = computed(() => {
  const n = props.logs.length;
  // 篩選後筆數變少時 scrollTop 可能超出內容,先夾到範圍內
  const top = Math.min(scrollTop.value, Math.max(0, n * ROW_H - viewH.value));
  const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const end = Math.min(n, Math.ceil((top + viewH.value) / ROW_H) + OVERSCAN);
  return { start, end, padTop: start * ROW_H, padBottom: (n - end) * ROW_H };
});
const visible = computed(() => props.logs.slice(range.value.start, range.value.end));

/** 只有這一批新進的列才閃一下(捲動進入可見範圍的舊列不閃) */
const fresh = shallowRef<Set<string>>(new Set());
let seen = new Set<string>();
const keyOf = (l: LiveLog) => `${l.type}:${l.id}`;
watch(
  () => props.logs,
  (logs) => {
    const next = new Set(logs.map(keyOf));
    fresh.value = seen.size ? new Set([...next].filter((k) => !seen.has(k))) : new Set();
    seen = next;
  },
  { immediate: true },
);

const FILTERS: { key: LogFilterKind; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'deny', label: '阻擋' },
  { key: 'allow', label: '允許' },
  { key: 'threat', label: '威脅' },
];

const focusLabel = computed(() => {
  const f = props.focus;
  if (!f) return '';
  if (f.side === 'source') {
    const s = props.sources?.find((x) => x.id === f.id);
    return `來源：${s?.label ?? f.id}`;
  }
  const g = props.segments?.find((x) => x.id === f.id);
  return `網段：${g?.label ?? f.id}`;
});

function segmentLabel(segId: unknown): string {
  if (typeof segId !== 'string' || !segId) return '—';
  const g = props.segments?.find((x) => x.id === segId);
  return g?.label ?? segId;
}

function sessionOrThreat(l: LiveLog): string {
  const sid = l.sessionid ?? (l as Record<string, unknown>).sessionId;
  if (sid !== undefined && sid !== null && sid !== '') return String(sid);
  if (l.name) return String(l.name);
  if (l.severity) return String(l.severity);
  return '—';
}
</script>

<template>
  <section id="logbar" class="wr-logbar" :class="{ mini: !isOpen }" aria-label="即時流量與威脅紀錄">
    <div class="hd">
      <button
        type="button"
        class="chip wr-logbar__toggle"
        :aria-expanded="isOpen"
        :title="isOpen ? '收摺 Log 表' : '展開 Log 表'"
        aria-label="收摺或展開 Log 表"
        @click="toggleOpen"
      >
        {{ isOpen ? '▾' : '▸' }}
      </button>
      <h3>TRAFFIC LOG</h3>

      <button
        v-for="f in FILTERS"
        :key="f.key"
        type="button"
        class="chip"
        :class="{ on: filter === f.key }"
        :data-f="f.key"
        @click="emit('update:filter', f.key)"
      >
        {{ f.label }}
      </button>

      <button
        id="pause"
        type="button"
        class="chip"
        :class="{ on: paused }"
        @click="emit('update:paused', !paused)"
      >
        {{ paused ? '▶ 繼續' : '⏸ 暫停' }}
      </button>

      <button
        v-if="focus"
        type="button"
        class="chip on wr-logbar__focus"
        title="點擊取消節點聚焦"
        @click="emit('clearFocus')"
      >
        聚焦 {{ focusLabel }} ✕
      </button>

      <span class="note">
        最多顯示 200 筆 · 點上方節點會同步篩選此表 · 更早紀錄請至
        <RouterLink to="/firewall/search" class="wr-logbar__link">Log 明細查詢</RouterLink>
      </span>
    </div>

    <div v-if="isOpen" ref="bodyEl" class="bd" @scroll.passive="onScroll">
      <table>
        <colgroup>
          <col style="width: 72px" />
          <col style="width: 112px" />
          <col style="width: 150px" />
          <col style="width: 56px" />
          <col style="width: 150px" />
          <col style="width: 130px" />
          <col style="width: 60px" />
          <col style="width: 110px" />
          <col style="width: 150px" />
          <col style="width: 84px" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>時間</th>
            <th>動作</th>
            <th>來源 IP</th>
            <th>國家</th>
            <th>目的 IP</th>
            <th>區段</th>
            <th>Port</th>
            <th>App</th>
            <th>規則</th>
            <th>Bytes</th>
            <th>Session / 威脅</th>
          </tr>
        </thead>
        <tbody id="lb">
          <template v-if="logs.length">
            <tr v-if="range.padTop" class="pad" aria-hidden="true"><td colspan="11" :style="{ height: `${range.padTop}px` }" /></tr>
            <tr v-for="l in visible" :key="keyOf(l)" class="wr-vrow" :class="{ new: fresh.has(keyOf(l)) }">
              <td>{{ fmtClock(l.receivedAt) }}</td>
              <td :class="classifyLog(l)">
                {{ l.action ?? (l.type === 'threat' ? 'alert' : '—') }}
                <span v-if="l.severity" class="wr-logbar__sev">({{ l.severity }})</span>
              </td>
              <td><GIpLabel :ip="typeof l.src === 'string' ? l.src : null" inline /></td>
              <td>{{ typeof l.country === 'string' && l.country ? l.country : '—' }}</td>
              <td><GIpLabel :ip="typeof l.dst === 'string' ? l.dst : null" inline /></td>
              <td>{{ segmentLabel(l.segment) }}</td>
              <td>{{ l.dport ?? '—' }}</td>
              <td>{{ l.app ?? '—' }}</td>
              <td>{{ l.rule ?? '—' }}</td>
              <td>{{ typeof l.bytes === 'number' ? fmtNum(l.bytes) : '—' }}</td>
              <td>{{ sessionOrThreat(l) }}</td>
            </tr>
            <tr v-if="range.padBottom" class="pad" aria-hidden="true"><td colspan="11" :style="{ height: `${range.padBottom}px` }" /></tr>
          </template>
          <tr v-else>
            <td colspan="11" class="wr-logbar__empty">目前篩選條件下尚無即時紀錄</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.wr-logbar {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  height: 230px;
  background: rgba(12, 20, 36, 0.94);
  border: 1px solid #1c2a44;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: #cfe3ff;
  /* 不用 backdrop-filter:疊在動畫 Canvas 上每幀都要重算模糊 */
  z-index: 6;
}
.hd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #1c2a44;
  flex-wrap: wrap;
}
.hd h3 {
  margin: 0 4px 0 0;
  font-size: 12px;
  color: #6f86a8;
  letter-spacing: 1px;
}
.chip {
  padding: 2px 9px;
  border: 1px solid #1c2a44;
  border-radius: 10px;
  background: transparent;
  color: #6f86a8;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.2s,
    color 0.2s,
    background 0.2s;
}
.chip:hover {
  border-color: #3ea8ff;
  color: #cfe3ff;
}
.chip.on {
  border-color: #3ea8ff;
  background: rgba(62, 168, 255, 0.14);
  color: #cfe3ff;
}
.wr-logbar__focus {
  border-color: #f5b03a !important;
  color: #ffe0a6 !important;
}
.note {
  font-size: 11px;
  color: #6f86a8;
  margin-left: auto;
}
.wr-logbar__link {
  color: #3ea8ff;
  text-decoration: none;
}
.wr-logbar__link:hover {
  text-decoration: underline;
}
.bd {
  overflow: auto;
  flex: 1;
}
/* 收摺高度固定 46px:Live.vue 的 --wr-log-h(58px = 46 + 底距 12)依此計算 */
.wr-logbar.mini {
  height: 46px;
  overflow: hidden;
}
.wr-logbar__toggle {
  padding: 0 7px;
  line-height: 18px;
}
table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
th {
  position: sticky;
  top: 0;
  background: #0c1424;
  text-align: left;
  font-weight: normal;
  color: #6f86a8;
  padding: 5px 10px;
  z-index: 1;
}
td {
  padding: 0 10px;
  border-top: 1px solid #111d33;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 固定列高(24 + 框線 1 = ROW_H 25),虛擬捲動才能用 scrollTop 算出可見列 */
tr.wr-vrow td {
  height: 24px;
  box-sizing: border-box;
  line-height: 23px;
}
/* IP 對照名稱(GIpLabel)在窄欄會換行把列撐到 48px,虛擬捲動位置就會偏:表內強制單行、超出省略 */
tr.wr-vrow td :deep(.g-ip) {
  flex-wrap: nowrap;
  max-width: 100%;
  overflow: hidden;
}
tr.wr-vrow td :deep(.g-ip .name) {
  line-height: 18px;
  min-width: 0;
  flex-shrink: 1;
}
tr.pad td {
  padding: 0;
  border: 0;
}
tr.new td {
  animation: wr-flash 1.2s ease;
}
@keyframes wr-flash {
  from {
    background: rgba(62, 168, 255, 0.25);
  }
}
tr:hover td {
  background: rgba(62, 168, 255, 0.08);
}
.deny {
  color: #ff4d5e;
}
.allow {
  color: #22d3a6;
}
.threat {
  color: #f5b03a;
}
.wr-logbar__sev {
  font-size: 11px;
  opacity: 0.85;
}
.wr-logbar__empty {
  text-align: center;
  color: #6f86a8;
  padding: 24px 10px;
}
</style>
