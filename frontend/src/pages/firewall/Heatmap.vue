<script setup lang="ts">
/**
 * 防火牆 › 活動熱力圖(V-b2;HANDOFF-GEMINI-VIZ §3.1、§3.2、§7):
 *   - 上方工具列:粒度(年/月/日)、指標(威脅等級/總流量/阻擋數/AD 異常停用並顯示「AD 階段開放」)、前後期、日期選擇、圖例(4 階 + 0 + 沒有資料 + 資料不完整)
 *   - 日視圖超過 1 年(NETOPS_HEATMAP_OUT_OF_RETENTION):顯示「每 5 分鐘資料只保留 1 年,最早可查 {earliest}」
 *   - coverage.since 之前顯示「此日期前沒有資料」;partial 標示「此時段資料不完整」
 *   - 點格子 → 開 SliceDrawer(useSlice.open);雙擊或抽屜「下鑽」→ useHeatmap.drill
 */
import { computed, ref } from 'vue';
import { fmtNum, fmtShort, fmtSize } from '@/api/format';
import { ApiError, describeError } from '@/api/gateway';
import type { HeatCell, HeatMetric } from '@/api/heatmap';
import SliceDrawer from '@/components/SliceDrawer.vue';
import { useHeatmap } from '@/composables/useHeatmap';
import { useSlice } from '@/composables/useSlice';
import { formatRange, taipeiDay, taipeiLocal } from '@/composables/vizTime';

const h = useHeatmap();
const s = useSlice();

const drawer = ref(false);
const selectedCell = ref<HeatCell | null>(null);

const granularityOptions = h.granularityOptions.map((g) => ({ label: g.label, value: g.value }));

function selectMetric(m: HeatMetric, disabled?: boolean) {
  if (disabled) return;
  h.metric.value = m;
}

const isOutOfRetention = computed(
  () => h.error.value instanceof ApiError && h.error.value.code === 'NETOPS_HEATMAP_OUT_OF_RETENTION',
);

const earliestDay = computed(() => {
  if (h.error.value instanceof ApiError) {
    const d = h.error.value.details as { earliest?: string } | undefined;
    if (d?.earliest) return d.earliest;
  }
  return h.retention.value.dayEarliest;
});

const periodLabel = computed(() => {
  const d = h.data.value;
  if (!d) return h.date.value;
  return formatRange(d.from, d.to);
});

const hasNullBeforeSince = computed(() => {
  const d = h.data.value;
  if (!d) return false;
  if (d.coverage.since && Date.parse(d.coverage.since) > Date.parse(d.from)) return true;
  return h.cells.value.some((c) => c.v === null);
});

const sinceLabel = computed(() => {
  const since = h.data.value?.coverage.since;
  if (!since) return '';
  return taipeiLocal(since).replace('T', ' ');
});

const partialCount = computed(() => h.cells.value.filter((c) => c.partial).length);

const periodSummary = computed(() => {
  let bytes = 0;
  let sessions = 0;
  let deny = 0;
  let critical = 0;
  let high = 0;
  let activeCells = 0;
  for (const c of h.cells.value) {
    if (c.v === null) continue;
    activeCells++;
    bytes += c.tip.bytes;
    sessions += c.tip.sessions;
    deny += c.tip.deny;
    critical += c.tip.threats.critical;
    high += c.tip.threats.high;
  }
  return { bytes, sessions, deny, critical, high, activeCells };
});

const levelHints = computed(() => {
  const d = h.data.value;
  if (!d) return ['0', '低', '中', '高', '極高'];
  if (d.metric === 'threat') return ['0 (無)', '低 / 資訊', '中 (Medium)', '高 (High)', '嚴重 (Critical)'];
  const th = d.levels.thresholds;
  const fmt = d.metric === 'traffic' ? fmtSize : fmtShort;
  if (th.length >= 3) {
    return ['0', `< ${fmt(th[0]!)}`, `≥ ${fmt(th[0]!)}`, `≥ ${fmt(th[1]!)}`, `≥ ${fmt(th[2]!)}`];
  }
  return ['0', '第 1 階', '第 2 階', '第 3 階', '第 4 階'];
});

const canDrillSelected = computed(() => {
  const c = selectedCell.value;
  if (!c || h.granularity.value === 'day') return false;
  const d = taipeiDay(Date.parse(c.t));
  return d >= h.retention.value.dayEarliest;
});

function onSelect(cell: HeatCell) {
  selectedCell.value = cell;
  if (!h.canSlice.value) return;
  const q = h.sliceQuery(cell);
  drawer.value = true;
  void s.open(q);
}

function onDrill(cell: HeatCell) {
  if (h.drill(cell)) {
    drawer.value = false;
    void s.close();
  }
}

function drillFromDrawer() {
  if (selectedCell.value) onDrill(selectedCell.value);
}
</script>

<template>
  <div class="viz-heatmap stack">
    <GPageHeader
      title="活動熱力圖"
      subtitle="GitHub 風格長期活動視圖（年 53 週 / 月 24 小時 / 日 5 分鐘）；點擊格子開啟時段明細，雙擊或按 Shift+Enter 下鑽至日視圖"
    >
      <GButton size="sm" variant="secondary" icon="refresh" :loading="h.loading.value" @click="h.refresh()">
        重新整理
      </GButton>
    </GPageHeader>

    <!-- 工具列卡片 -->
    <GCard padding="sm">
      <div class="viz-heatmap__toolbar">
        <div class="viz-heatmap__group">
          <span class="viz-heatmap__lbl">粒度</span>
          <GSegmented v-model="h.granularity.value" :options="granularityOptions" size="sm" />
        </div>

        <div class="viz-heatmap__group">
          <span class="viz-heatmap__lbl">指標</span>
          <div class="viz-metric-seg" role="radiogroup" aria-label="熱力圖指標">
            <button
              v-for="m in h.metricOptions"
              :key="m.value"
              type="button"
              role="radio"
              class="viz-metric-seg__btn"
              :class="{ active: h.metric.value === m.value, 'is-disabled': m.disabled }"
              :aria-checked="h.metric.value === m.value"
              :aria-disabled="m.disabled || undefined"
              :disabled="m.disabled"
              :title="m.hint ?? m.label"
              @click="selectMetric(m.value, m.disabled)"
            >
              <span>{{ m.label }}</span>
              <span v-if="m.hint" class="viz-metric-seg__hint">{{ m.hint }}</span>
            </button>
          </div>
        </div>

        <div class="viz-heatmap__group viz-heatmap__nav">
          <GButton size="sm" variant="ghost" icon="chevron-left" aria-label="上一期" @click="h.prev()">上一期</GButton>
          <input v-model="h.date.value" type="date" class="viz-heatmap__date" aria-label="選擇基準日期" />
          <GButton size="sm" variant="ghost" icon-right="chevron-right" :disabled="!h.canNext.value" aria-label="下一期" @click="h.next()">
            下一期
          </GButton>
        </div>

        <div class="spacer" />

        <!-- 圖例(4 階 + 0 + 沒有資料 + 資料不完整) -->
        <div class="viz-heatmap__legend" aria-label="熱力圖色階圖例">
          <span class="viz-legend__item" :title="levelHints[0]">
            <i class="viz-legend__swatch is-lv0" />
            <span>0</span>
          </span>
          <span
            v-for="lv in ([1, 2, 3, 4] as const)"
            :key="lv"
            class="viz-legend__item"
            :title="levelHints[lv]"
          >
            <i class="viz-legend__swatch" :style="{ background: `var(--heat-${h.metric.value}-${lv})` }" />
            <span>L{{ lv }}</span>
          </span>
          <span class="viz-legend__item" title="彙總表起點之前，沒有資料（不等於 0）">
            <i class="viz-legend__swatch is-null" />
            <span>沒有資料</span>
          </span>
          <span class="viz-legend__item" title="落在已知缺口內，此時段資料不完整">
            <i class="viz-legend__swatch is-partial" />
            <span>資料不完整</span>
          </span>
        </div>
      </div>
    </GCard>

    <!-- 狀態與錯誤提示(§3.1、§7) -->
    <GAlert v-if="isOutOfRetention" tone="warning" title="超過每 5 分鐘熱力圖保留範圍">
      <div class="row">
        <span>每 5 分鐘資料只保留 1 年，最早可查 {{ earliestDay }}</span>
        <GButton size="sm" variant="secondary" @click="h.date.value = earliestDay">跳至最早可查日</GButton>
        <GButton size="sm" variant="ghost" @click="h.granularity.value = 'month'">改看月視圖（保留 5 年）</GButton>
      </div>
    </GAlert>
    <GAlert v-else-if="h.error.value" tone="danger" title="熱力圖讀取失敗">
      {{ describeError(h.error.value) }}
    </GAlert>

    <GAlert v-if="h.data.value && h.data.value.coverage.since === null" tone="info">
      彙總表還沒有資料（此日期前沒有資料）。
    </GAlert>
    <GAlert v-else-if="hasNullBeforeSince" tone="info">
      此日期前沒有資料{{ sinceLabel ? `（彙總資料起點：${sinceLabel}）` : '' }}；斜線底紋代表尚未建立彙總，不等於 0。
    </GAlert>

    <!-- 期間摘要列 -->
    <div v-if="h.data.value" class="viz-heatmap__summary">
      <div class="viz-sum-pill glass">
        <span class="faint xs">顯示期間</span>
        <strong class="mono small">{{ periodLabel }}</strong>
      </div>
      <div class="viz-sum-pill glass">
        <span class="faint xs">期間總流量</span>
        <strong class="num small">{{ fmtSize(periodSummary.bytes) }}</strong>
      </div>
      <div class="viz-sum-pill glass">
        <span class="faint xs">總連線數</span>
        <strong class="num small">{{ fmtNum(periodSummary.sessions) }}</strong>
      </div>
      <div class="viz-sum-pill glass">
        <span class="faint xs">總阻擋數</span>
        <strong class="num small c-warning">{{ fmtNum(periodSummary.deny) }}</strong>
      </div>
      <div class="viz-sum-pill glass" :class="{ 'is-glow-crit': periodSummary.critical > 0 }">
        <span class="faint xs">嚴重 / 高風險威脅</span>
        <strong class="num small" :class="{ 'c-danger': periodSummary.critical + periodSummary.high > 0 }">
          {{ fmtNum(periodSummary.critical) }} / {{ fmtNum(periodSummary.high) }}
        </strong>
      </div>
      <div v-if="partialCount > 0" class="viz-sum-pill glass">
        <span class="faint xs">資料不完整時段</span>
        <strong class="num small c-warning">{{ fmtNum(partialCount) }} 格</strong>
      </div>
    </div>

    <!-- 熱力圖本體 -->
    <GCard :title="`PA-560 活動熱力圖（${periodLabel}）`" padding="md">
      <template #actions>
        <span class="faint xs">方向鍵移動 · Enter 開明細 · 雙擊或 Shift+Enter 下鑽日視圖</span>
      </template>

      <div v-if="h.loading.value && !h.data.value" class="stack">
        <GSkeleton height="180px" />
      </div>
      <GHeatmap
        v-else-if="h.data.value"
        :granularity="h.data.value.granularity"
        :metric="h.data.value.metric"
        :cells="h.cells.value"
        :from="h.data.value.from"
        :to="h.data.value.to"
        :loading="h.loading.value"
        :selected="selectedCell?.t ?? null"
        @select="onSelect"
        @drill="onDrill"
      />
    </GCard>

    <!-- 時段明細抽屜 -->
    <SliceDrawer
      v-model="drawer"
      :slice="s"
      :cell="selectedCell"
      :can-drill="canDrillSelected"
      @drill="drillFromDrawer"
    />
  </div>
</template>

<style scoped>
.viz-heatmap__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
}
.viz-heatmap__group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.viz-heatmap__lbl {
  font-size: var(--fs-xs);
  font-weight: 700;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.viz-metric-seg {
  display: inline-flex;
  flex-wrap: wrap;
  padding: 3px;
  gap: 2px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
}
.viz-metric-seg__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  font: inherit;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.viz-metric-seg__btn:hover:not(:disabled) {
  color: var(--text);
}
.viz-metric-seg__btn.active {
  color: var(--text);
  background: var(--glass-strong);
  box-shadow: var(--shadow-sm);
}
.viz-metric-seg__btn.is-disabled {
  cursor: not-allowed;
  opacity: 0.58;
}
.viz-metric-seg__hint {
  padding: 1px 5px;
  border-radius: 99px;
  font-size: 10px;
  background: var(--line);
  color: var(--text-3);
}

.viz-heatmap__date {
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--field-border);
  background: var(--field);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sm);
}
.viz-heatmap__date:focus {
  outline: 2px solid var(--field-focus);
  outline-offset: 1px;
}

.viz-heatmap__legend {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: var(--fs-xs);
  color: var(--text-2);
}
.viz-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.viz-legend__swatch {
  display: inline-block;
  width: 13px;
  height: 13px;
  border-radius: 3px;
}
.viz-legend__swatch.is-lv0 {
  background: var(--heat-empty);
}
.viz-legend__swatch.is-null {
  background: repeating-linear-gradient(
    -45deg,
    var(--heat-empty) 0 2.5px,
    transparent 2.5px 5px
  );
  border: 1px solid var(--line-strong);
}
.viz-legend__swatch.is-partial {
  position: relative;
  background: var(--heat-empty);
  outline: 1px dashed var(--c-warning);
  outline-offset: -1px;
}

.viz-heatmap__summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}
.viz-sum-pill {
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.viz-sum-pill.is-glow-crit {
  animation: pillGlowCrit 2.4s ease-in-out infinite;
}
@keyframes pillGlowCrit {
  0%,
  100% {
    box-shadow: var(--shadow-sm);
  }
  50% {
    box-shadow: 0 0 16px 2px var(--glow-critical);
  }
}
@media (prefers-reduced-motion: reduce) {
  .viz-sum-pill.is-glow-crit {
    animation: none !important;
  }
}
</style>
