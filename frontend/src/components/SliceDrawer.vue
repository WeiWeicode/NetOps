<script setup lang="ts">
/**
 * 時段明細抽屜(V-b2;HANDOFF-GEMINI-VIZ §3.2、§5、§7):熱力圖與儀表板共用。
 *   - 標題顯示時段 + GSourceBadge(⚡ 即時熱資料 / 🧊 歷史冷歸檔 / mixed)
 *   - isCold 為真時顯示冷資料掃描線過場(GSkeleton + 1.6s 掃描線 + 「讀取歷史冷歸檔中…」)
 *   - waiting-job(202)顯示「查詢較久,已轉為背景查詢」與取消按鈕
 *   - busy(429)顯示中性提示與倒數重試按鈕
 *   - 409 / 404 冷歸檔未提供時顯示中性 GAlert(info),並保留熱力圖格子的彙總數字(從 cell 帶入)
 *   - 其他錯誤顯示 GAlert(danger)含 message 與 requestId
 *   - 結果顯示摘要卡、嚴重度威脅、Top 10 排行、明細表(最多 200 列;rowsTruncated 時提示)與操作按鈕
 */
import { computed, ref, watch } from 'vue';
import { fmtNum, fmtSize, fmtTime } from '@/api/format';
import { ApiError, describeError } from '@/api/gateway';
import type { HeatCell } from '@/api/heatmap';
import type { SliceSeverity, SliceTopItem } from '@/api/slice';
import { useLivePaQuery } from '@/composables/useLivePaQuery';
import type { SearchExtra, useSlice } from '@/composables/useSlice';
import { formatRange } from '@/composables/vizTime';
import type { Column } from '@/ui/components/GTable.vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    slice: ReturnType<typeof useSlice>;
    cell?: HeatCell | null;
    canDrill?: boolean;
  }>(),
  {
    cell: null,
    canDrill: false,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'drill'): void;
}>();

const livePa = useLivePaQuery();

const title = computed(() => {
  const q = props.slice.query.value;
  if (q) return formatRange(q.start, q.end);
  if (props.cell) return props.cell.t.slice(0, 16).replace('T', ' ');
  return '時段明細';
});

const NEUTRAL_ERROR_CODES = new Set([
  'NETOPS_COLD_DETAIL_UNAVAILABLE',
  'NETOPS_COLD_ARCHIVE_DISABLED',
  'NETOPS_ARCHIVE_NOT_FOUND',
]);

const isNeutralError = computed(() => {
  const err = props.slice.error.value;
  return err instanceof ApiError && NEUTRAL_ERROR_CODES.has(err.code);
});

const errorText = computed(() => {
  const err = props.slice.error.value;
  if (!err) return '';
  if (isNeutralError.value && err instanceof ApiError) return err.message;
  return describeError(err);
});

/** 嚴重度 chip 點選切換(U4:點選篩選、再點一次取消;C4:useSlice.setSeverity 依嚴重度重查 Top 10 與明細) */
type SeverityKey = SliceSeverity;
const SEVERITY_DEFS: readonly { key: SeverityKey; label: string }[] = [
  { key: 'critical', label: '嚴重' },
  { key: 'high', label: '高' },
  { key: 'medium', label: '中' },
  { key: 'low', label: '低' },
  { key: 'info', label: '資訊' },
];
const selectedSeverity = ref<SeverityKey | null>(null);

watch(
  () => props.slice.query.value,
  (q) => {
    selectedSeverity.value = (q?.severity as SeverityKey | undefined) ?? null;
  },
  { immediate: true },
);

function toggleSeverity(sev: SeverityKey | null) {
  void props.slice.setSeverity(selectedSeverity.value === sev ? null : sev);
}

/** 篩選條件標籤 */
const filterChips = computed(() => {
  const q = props.slice.query.value;
  if (!q) return [];
  const sevValue = selectedSeverity.value ?? q.severity;
  const labels: Record<string, string> = {
    type: q.type === 'threat' ? '類型: 威脅' : '類型: 流量',
    ip: `IP: ${q.ip}`,
    src: `來源 IP: ${q.src}`,
    dst: `目的 IP: ${q.dst}`,
    app: `App: ${q.app}`,
    fromZone: `來源區域: ${q.fromZone}`,
    toZone: `目的區域: ${q.toZone}`,
    dport: `Port: ${q.dport}`,
    action: q.action === 'block' ? '動作: 阻擋' : `動作: ${q.action}`,
    country: `國家: ${q.country}`,
    severity: `嚴重度: ${sevValue}`,
    threatName: `威脅: ${q.threatName}`,
  };
  const out: string[] = [labels.type!];
  for (const k of ['ip', 'src', 'dst', 'app', 'fromZone', 'toZone', 'dport', 'action', 'country', 'threatName'] as const) {
    if (q[k] !== undefined && q[k] !== '') out.push(labels[k]!);
  }
  if (sevValue) out.push(labels.severity!);
  return out;
});

const activeIp = computed(() => {
  const q = props.slice.query.value;
  return q?.ip ?? q?.src ?? q?.dst ?? null;
});

/** Top 10 分頁切換 */
const TOP_LABELS: Record<string, string> = {
  src: '來源 IP',
  dst: '目的 IP',
  app: '應用程式',
  dport: '目的 Port',
  dstCountry: '目的國家',
  name: '威脅名稱',
  srcCountry: '來源國家',
};

const topKeys = computed(() => {
  const r = props.slice.result.value;
  if (!r) return [];
  const order = r.type === 'threat' ? ['name', 'src', 'dst', 'srcCountry'] : ['src', 'dst', 'app', 'dport', 'dstCountry'];
  return order.filter((k) => Array.isArray(r.top[k]));
});

const activeTopKey = ref<string>('src');
watch(
  topKeys,
  (keys) => {
    if (keys.length && !keys.includes(activeTopKey.value)) {
      activeTopKey.value = keys[0]!;
    }
  },
  { immediate: true },
);

const activeTopItems = computed(() => {
  const r = props.slice.result.value;
  if (!r) return [];
  const list: SliceTopItem[] = r.top[activeTopKey.value] ?? [];
  const isTraffic = r.type === 'traffic';
  return list.slice(0, 10).map((item) => ({
    label: item.key,
    value: isTraffic ? (item.bytes ?? item.sessions ?? 0) : (item.count ?? 0),
    hint: isTraffic
      ? `${fmtSize(item.bytes ?? 0)} · ${fmtNum(item.sessions ?? 0)} 次`
      : item.severity
        ? `嚴重度 ${item.severity}`
        : undefined,
  }));
});

/** U5 / C7:點選 Top 10 項目或明細表 IP,以該項目開啟 Log 明細查詢 */
function openItemInSearch(dimKey: string, rawVal: string) {
  const val = rawVal.replace(/^約\s+/, '').trim();
  if (!val || val === '—') return;
  const extra: SearchExtra = {};
  // 來源 / 目的 IP 對應 Log 明細查詢的來源 / 目的欄位(C7 第二輪)
  if (dimKey === 'src') extra.filterSrc = val;
  else if (dimKey === 'dst') extra.filterDst = val;
  else if (dimKey === 'ip') extra.filterIp = val;
  else if (dimKey === 'srcCountry' || dimKey === 'dstCountry') extra.filterCountry = val;
  else if (dimKey === 'app') extra.filterApp = val;
  else if (dimKey === 'dport') extra.filterPort = val;
  else if (dimKey === 'name') extra.filterThreat = val;
  void props.slice.openInSearch(extra);
}

/** 明細表欄位(U8:時間欄加寬並搭配 nowrap 不換行) */
const tableColumns = computed<Column[]>(() => {
  const r = props.slice.result.value;
  if (r?.type === 'threat') {
    return [
      { key: 'time', label: '時間', width: '164px', mono: true },
      { key: 'severity', label: '嚴重度', width: '84px' },
      { key: 'name', label: '威脅名稱' },
      { key: 'src', label: '來源 IP', mono: true },
      { key: 'dst', label: '目的 IP', mono: true },
      { key: 'action', label: '動作', width: '76px' },
    ];
  }
  return [
    { key: 'time', label: '時間', width: '164px', mono: true },
    { key: 'action', label: '動作', width: '76px' },
    { key: 'src', label: '來源 IP', mono: true },
    { key: 'dst', label: '目的 IP', mono: true },
    { key: 'dport', label: 'Port', width: '72px', align: 'right', mono: true },
    { key: 'app', label: 'App' },
    { key: 'bytes', label: '流量', width: '96px', align: 'right', sortable: true },
  ];
});

const tableRows = computed(() => {
  const rows = props.slice.result.value?.rows ?? [];
  return rows.map((row, idx) => ({
    _id: `${idx}-${row.time ?? ''}`,
    ...row,
  }));
});

function onDrawerToggle(v: boolean) {
  emit('update:modelValue', v);
  if (!v) void props.slice.close();
}
</script>

<template>
  <GDrawer :model-value="modelValue" :title="title" @update:model-value="onDrawerToggle">
    <template #actions>
      <GSourceBadge v-if="slice.source.value" :source="slice.source.value" />
    </template>

    <!-- 篩選條件與操作列 -->
    <div v-if="filterChips.length || canDrill || slice.searchLink.value || (livePa.canQuery.value && activeIp)" class="slice-drawer__bar">
      <div class="slice-drawer__chips">
        <GBadge v-for="chip in filterChips" :key="chip" tone="primary" variant="soft" mono>{{ chip }}</GBadge>
      </div>
      <div class="slice-drawer__btns">
        <GButton v-if="canDrill" size="sm" variant="secondary" icon="calendar" @click="emit('drill')">下鑽至日視圖</GButton>
        <GButton v-if="slice.searchLink.value" size="sm" variant="secondary" icon="external" @click="slice.openInSearch()">
          在 Log 明細查詢開啟
        </GButton>
        <GButton v-if="livePa.canQuery.value && activeIp" size="sm" variant="primary" icon="zap" @click="livePa.query(activeIp)">
          查詢該 IP 當下 PA 即時連線
        </GButton>
      </div>
    </div>

    <!-- 狀態 1:載入中 / 202 背景工作(含冷資料掃描線過場 §5) -->
    <div
      v-if="slice.state.value === 'loading' || slice.state.value === 'waiting-job'"
      class="slice-drawer__loading"
      :class="{ 'is-cold': slice.isCold.value }"
      role="status"
      aria-live="polite"
    >
      <div v-if="slice.isCold.value" class="slice-drawer__scanline" aria-hidden="true" />
      <div class="slice-drawer__loading-head">
        <span class="slice-drawer__loading-title">
          {{ slice.isCold.value ? '🧊 讀取歷史冷歸檔中…' : '⚡ 查詢時段明細中…' }}
        </span>
        <div v-if="slice.state.value === 'waiting-job'" class="slice-drawer__job-bar">
          <span class="muted small">查詢較久，已轉為背景查詢</span>
          <GButton size="sm" variant="secondary" @click="slice.cancel()">取消查詢</GButton>
        </div>
      </div>
      <GSkeleton :lines="4" />
      <GSkeleton height="120px" />
    </div>

    <!-- 狀態 2:429 冷查詢忙碌(中性提示 + 倒數重試,不是錯誤樣式 §3.2、§7) -->
    <div v-else-if="slice.state.value === 'busy'" class="slice-drawer__busy" role="status" aria-live="polite">
      <GAlert tone="info" title="歷史冷歸檔查詢忙碌中">
        <div class="slice-drawer__busy-row">
          <span>目前有其他歷史查詢進行中，{{ slice.retryAfter.value }} 秒後可重試</span>
          <GButton size="sm" variant="primary" :disabled="slice.retryAfter.value > 0" @click="slice.retry()">
            {{ slice.retryAfter.value > 0 ? `重試 (${slice.retryAfter.value}s)` : '立即重試' }}
          </GButton>
        </div>
      </GAlert>
    </div>

    <!-- 狀態 3:錯誤(409/404 用中性 info 並保留 cell 彙總;其他用 danger 含 requestId §3.2、§7) -->
    <div v-else-if="slice.state.value === 'error' && slice.error.value" class="stack">
      <GAlert :tone="isNeutralError ? 'info' : 'danger'" :title="isNeutralError ? '歷史明細尚未提供' : '查詢失敗'">
        {{ errorText }}
      </GAlert>

      <!-- 409 / 404 時保留熱力圖格子的彙總數字(§3.2) -->
      <GCard v-if="isNeutralError && cell && cell.v !== null" title="此時段熱力圖彙總（保留自彙總表）" padding="sm">
        <div class="slice-drawer__kpis">
          <div class="slice-kpi">
            <span class="slice-kpi__lbl">總流量</span>
            <strong class="slice-kpi__val num">{{ fmtSize(cell.tip.bytes) }}</strong>
          </div>
          <div class="slice-kpi">
            <span class="slice-kpi__lbl">連線數 (Session)</span>
            <strong class="slice-kpi__val num">{{ fmtNum(cell.tip.sessions) }}</strong>
          </div>
          <div class="slice-kpi">
            <span class="slice-kpi__lbl">阻擋數</span>
            <strong class="slice-kpi__val num">{{ fmtNum(cell.tip.deny) }}</strong>
          </div>
        </div>
        <div class="slice-drawer__threats">
          <span class="slice-sev is-critical" :class="{ 'is-glow': cell.tip.threats.critical > 0 }">
            嚴重 <strong>{{ fmtNum(cell.tip.threats.critical) }}</strong>
          </span>
          <span class="slice-sev is-high" :class="{ 'is-glow': cell.tip.threats.high > 0 }">
            高 <strong>{{ fmtNum(cell.tip.threats.high) }}</strong>
          </span>
          <span class="slice-sev is-medium">中 <strong>{{ fmtNum(cell.tip.threats.medium) }}</strong></span>
          <span class="slice-sev is-low">低 <strong>{{ fmtNum(cell.tip.threats.low) }}</strong></span>
          <span class="slice-sev is-info">資訊 <strong>{{ fmtNum(cell.tip.threats.info) }}</strong></span>
        </div>
        <div class="slice-drawer__approx muted small">
          <span>Top 1 流量 IP：<code>{{ cell.tip.topIp.traffic ? `約 ${cell.tip.topIp.traffic}` : '—' }}</code></span>
          <span>Top 1 阻擋 IP：<code>{{ cell.tip.topIp.deny ? `約 ${cell.tip.topIp.deny}` : '—' }}</code></span>
          <span>Top 1 威脅 IP：<code>{{ cell.tip.topIp.threat ? `約 ${cell.tip.topIp.threat}` : '—' }}</code></span>
        </div>
      </GCard>
    </div>

    <!-- 狀態 4:完成(淡入 200ms §5) -->
    <div v-else-if="slice.result.value" class="slice-drawer__content">
      <GAlert v-if="slice.result.value.coverage.partial" tone="warning">
        此時段資料不完整（落在已知缺口內，統計與明細可能少於實際發生數量）。
      </GAlert>
      <GAlert v-else-if="!slice.result.value.coverage.gapsKnown" tone="info">
        此時段尚未完成每日 FTP 對帳檢查。
      </GAlert>

      <!-- 摘要卡 -->
      <div class="slice-drawer__kpis">
        <div class="slice-kpi">
          <span class="slice-kpi__lbl">總流量</span>
          <!-- C3:威脅類沒有流量欄位,顯示「不適用」(不是 0 B) -->
          <strong v-if="slice.summary.value?.bytes == null" class="slice-kpi__val">不適用</strong>
          <strong v-else class="slice-kpi__val num">{{ fmtSize(slice.summary.value.bytes) }}</strong>
          <span v-if="slice.summary.value?.bytes != null" class="slice-kpi__sub num">
            ↑ {{ fmtSize(slice.summary.value.sent ?? 0) }} · ↓ {{ fmtSize(slice.summary.value.recv ?? 0) }}
          </span>
        </div>
        <div class="slice-kpi">
          <span class="slice-kpi__lbl">連線數 (Session)</span>
          <strong class="slice-kpi__val num">{{ fmtNum(slice.result.value.summary.sessions) }}</strong>
          <span class="slice-kpi__sub">耗時 {{ slice.result.value.seconds.toFixed(2) }} 秒</span>
        </div>
        <div class="slice-kpi">
          <span class="slice-kpi__lbl">阻擋數 (Deny)</span>
          <strong class="slice-kpi__val num c-danger">{{ fmtNum(slice.result.value.summary.deny) }}</strong>
        </div>
      </div>

      <!-- 各嚴重度威脅統計:可點選與取消選取(U4;critical / high 呼吸光暈 §5) -->
      <div class="slice-drawer__threats" role="group" aria-label="各嚴重度威脅數量（點擊可篩選或取消）">
        <button
          v-for="sev in SEVERITY_DEFS"
          :key="sev.key"
          type="button"
          class="slice-sev is-interactive"
          :class="[
            `is-${sev.key}`,
            {
              'is-glow': (sev.key === 'critical' || sev.key === 'high') && slice.result.value.summary.threats[sev.key] > 0,
              'is-active': selectedSeverity === sev.key,
              'is-dimmed': selectedSeverity !== null && selectedSeverity !== sev.key,
            },
          ]"
          :aria-pressed="selectedSeverity === sev.key"
          :title="selectedSeverity === sev.key ? `取消「${sev.label}」嚴重度篩選` : `依「${sev.label}」嚴重度篩選`"
          @click="toggleSeverity(sev.key)"
        >
          <span class="slice-sev__dot" aria-hidden="true" />
          <span>{{ sev.label }}</span>
          <strong class="num">{{ fmtNum(slice.result.value.summary.threats[sev.key]) }}</strong>
        </button>
        <button
          v-if="selectedSeverity"
          type="button"
          class="slice-sev__clear xs"
          @click="toggleSeverity(null)"
        >
          清除篩選
        </button>
      </div>

      <!-- Top 10 排行(U5:點項目直接開 Log 明細查詢) -->
      <GCard v-if="topKeys.length" title="Top 10 排行" padding="sm">
        <template #actions>
          <div class="slice-drawer__top-tabs" role="tablist" aria-label="Top 10 維度">
            <button
              v-for="k in topKeys"
              :key="k"
              type="button"
              role="tab"
              class="slice-drawer__top-tab"
              :class="{ active: activeTopKey === k }"
              :aria-selected="activeTopKey === k"
              @click="activeTopKey = k"
            >
              {{ TOP_LABELS[k] ?? k }}
            </button>
          </div>
        </template>
        <GBarList
          v-if="activeTopItems.length"
          :items="activeTopItems"
          colorful
          clickable
          pick-hint="點擊在 Log 明細查詢開啟"
          @pick="(item) => openItemInSearch(activeTopKey, item.label)"
        />
        <GEmpty v-else compact :title="selectedSeverity ? '此嚴重度下無排行資料' : '此時段無排行資料'" />
      </GCard>

      <!-- 明細表(最多 200 列;rowsTruncated 提示;U8 時間欄不換行;U5 點 IP 開 Log 明細查詢) -->
      <GCard title="時段明細紀錄" padding="none">
        <template #actions>
          <span v-if="slice.result.value.rowsTruncated" class="faint xs">
            只顯示前 {{ slice.result.value.rowsLimit }} 筆
          </span>
          <span v-else class="faint xs">共 {{ tableRows.length }} 筆</span>
        </template>
        <GTable :columns="tableColumns" :rows="tableRows" row-key="_id" :page-size="10" dense empty-title="此時段查無明細紀錄">
          <template #cell-time="{ value }">
            <span class="mono xs nowrap">{{ fmtTime(String(value ?? '')) }}</span>
          </template>
          <template #cell-src="{ value }">
            <button
              v-if="value"
              type="button"
              class="slice-ip-btn mono xs nowrap"
              :title="`在 Log 明細查詢來源 IP ${value}`"
              @click.stop="openItemInSearch('src', String(value))"
            >
              {{ value }}
            </button>
            <span v-else class="mono xs nowrap">—</span>
          </template>
          <template #cell-dst="{ value }">
            <button
              v-if="value"
              type="button"
              class="slice-ip-btn mono xs nowrap"
              :title="`在 Log 明細查詢目的 IP ${value}`"
              @click.stop="openItemInSearch('dst', String(value))"
            >
              {{ value }}
            </button>
            <span v-else class="mono xs nowrap">—</span>
          </template>
          <template #cell-action="{ value }">
            <GBadge :tone="value === 'allow' ? 'success' : 'danger'">{{ value }}</GBadge>
          </template>
          <template #cell-severity="{ value }">
            <GBadge v-if="value" :tone="value === 'critical' ? 'danger' : value === 'high' ? 'warning' : 'info'">{{ value }}</GBadge>
            <span v-else class="faint xs">—</span>
          </template>
          <template #cell-bytes="{ value }">
            <span class="num nowrap">{{ fmtSize(typeof value === 'number' ? value : Number(value ?? 0)) }}</span>
          </template>
        </GTable>
      </GCard>
    </div>
  </GDrawer>
</template>

<style scoped>
.slice-drawer__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.slice-drawer__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.slice-drawer__btns {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 冷資料過場:GSkeleton + 由上往下掃描線 1.6s 循環(§5) */
.slice-drawer__loading {
  position: relative;
  overflow: hidden;
  padding: 16px;
  border-radius: var(--radius-md);
  background: var(--glass-soft);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.slice-drawer__scanline {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    180deg,
    transparent 0%,
    color-mix(in srgb, var(--badge-cold) 18%, transparent) 50%,
    transparent 100%
  );
  animation: coldScan 1.6s linear infinite;
  pointer-events: none;
}
@keyframes coldScan {
  from {
    transform: translateY(-100%);
  }
  to {
    transform: translateY(100%);
  }
}
.slice-drawer__loading-head {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.slice-drawer__loading-title {
  font-weight: 650;
  color: var(--text);
}
.slice-drawer__job-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.slice-drawer__busy-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

/* 結果淡入 200ms(§5) */
.slice-drawer__content {
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: sliceFadeIn 200ms var(--ease);
}
@keyframes sliceFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.slice-drawer__kpis {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 540px) {
  .slice-drawer__kpis {
    grid-template-columns: minmax(0, 1fr);
  }
}
.slice-kpi {
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.slice-kpi__lbl {
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-weight: 600;
}
.slice-kpi__val {
  font-size: var(--fs-xl);
  font-weight: 750;
}
.slice-kpi__sub {
  font-size: 11px;
  color: var(--text-3);
}

.slice-drawer__threats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.slice-sev {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border-radius: 999px;
  font: inherit;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text);
  background: var(--glass-soft);
  border: 1px solid var(--line);
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}
.slice-sev.is-interactive {
  cursor: pointer;
}
.slice-sev.is-interactive:hover {
  background: var(--glass-hover);
  border-color: var(--line-strong);
}
.slice-sev__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
}
.slice-sev.is-critical {
  color: color-mix(in srgb, var(--c-danger) 70%, var(--text));
  border-color: color-mix(in srgb, var(--c-danger) 40%, transparent);
}
.slice-sev.is-critical .slice-sev__dot {
  background: var(--c-danger);
}
.slice-sev.is-high {
  color: color-mix(in srgb, var(--c-warning) 65%, var(--text));
  border-color: color-mix(in srgb, var(--c-warning) 40%, transparent);
}
.slice-sev.is-high .slice-sev__dot {
  background: var(--c-warning);
}
.slice-sev.is-medium .slice-sev__dot {
  background: var(--c-info);
}
.slice-sev.is-low .slice-sev__dot {
  background: var(--c-cyan);
}
.slice-sev.is-active {
  background: color-mix(in srgb, var(--c-primary) 16%, var(--glass-strong));
  border-color: var(--c-primary);
  box-shadow: 0 0 0 2px var(--focus-ring);
}
.slice-sev.is-critical.is-active {
  background: color-mix(in srgb, var(--c-danger) 18%, var(--glass-strong));
  border-color: var(--c-danger);
}
.slice-sev.is-high.is-active {
  background: color-mix(in srgb, var(--c-warning) 18%, var(--glass-strong));
  border-color: var(--c-warning);
}
.slice-sev.is-dimmed {
  opacity: 0.52;
}
.slice-sev__clear {
  border: 0;
  background: transparent;
  padding: 4px 8px;
  border-radius: 6px;
  font: inherit;
  color: var(--c-primary-text);
  font-weight: 600;
  cursor: pointer;
}
.slice-sev__clear:hover {
  text-decoration: underline;
}
.slice-ip-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--c-primary-text);
  cursor: pointer;
  text-align: left;
}
.slice-ip-btn:hover {
  text-decoration: underline;
}
.slice-sev.is-critical.is-glow {
  animation: pulseCritical 2.4s ease-in-out infinite;
}
.slice-sev.is-high.is-glow {
  animation: pulseHigh 2.4s ease-in-out infinite;
}
@keyframes pulseCritical {
  0%,
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
  50% {
    box-shadow: 0 0 12px 2px var(--glow-critical);
  }
}
@keyframes pulseHigh {
  0%,
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
  50% {
    box-shadow: 0 0 12px 2px var(--glow-high);
  }
}

.slice-drawer__approx {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}

.slice-drawer__top-tabs {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-xs);
  background: var(--glass-soft);
  border: 1px solid var(--line);
}
.slice-drawer__top-tab {
  border: 0;
  background: transparent;
  padding: 4px 8px;
  border-radius: 5px;
  font: inherit;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
}
.slice-drawer__top-tab.active {
  background: var(--glass-strong);
  color: var(--c-primary-text);
  box-shadow: var(--shadow-sm);
}

@media (prefers-reduced-motion: reduce) {
  .slice-drawer__scanline {
    display: none !important;
  }
  .slice-drawer__content,
  .slice-sev.is-critical.is-glow,
  .slice-sev.is-high.is-glow {
    animation: none !important;
  }
}
</style>
