<script setup lang="ts">
/**
 * 防火牆 › 安全規則 — 分頁 4:規則圖(PR-4;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.5,Q5)
 *   - 共用篩選:動作(allow / deny)、zone(v.zones)、長期未命中 N 天
 *   - ① Zone × Zone 矩陣(CSS Grid):count 深淺、tone(allow / deny / mixed)、tooltip 列 positions;旁註「格子數字是規則出現次數,多 zone 規則會出現在多格」
 *   - ② 規則順序條(GEChart 橫條圖 + yAxis dataZoom):logHits 長條、zeroHits 記號、hitCount null 無資料、disabled 淡色、isDefault 放最後標「預設規則」;checks 為 null 不顯示任何檢查標記也不顯示「無問題」
 *   - ③ Sankey(GEChart sankey):來源 zone → 動作 → 目的 zone,p:預設規則在第 0 層;estimated 為 true 時 tooltip 標「多 zone 規則平均分攤,為估算值」
 *   - 連動:點矩陣格 / Sankey 線 → 順序條強調 v.highlighted;點順序條規則 → 開詳細抽屜;規則圖不顯示 IP 名稱
 */
import { computed } from 'vue';
import { fmtNum, fmtTime } from '@/api/format';
import { describeError } from '@/api/gateway';
import type { CheckCode, CheckSeverity } from '@/api/paPolicy';
import { CHECK_LABELS, SEVERITY_LABELS } from '@/composables/usePaPolicyCheck';
import type { MatrixCell, OrderCheckMark, OrderRow } from '@/composables/usePaPolicyViz';
import GEChart from '@/ui/charts/GEChart.vue';
import type { ChartPick } from '@/ui/charts/viz-types';
import { escHtml, type PaPolicyStore, type PaPolicyVizStore } from './types';

const props = defineProps<{
  policy: PaPolicyStore;
  viz: PaPolicyVizStore;
}>();
const emit = defineEmits<{ (e: 'open-rule', name: string): void }>();

const ACTION_OPTIONS = [
  { label: '允許 (allow)', value: 'allow' },
  { label: '拒絕 / 阻擋 (deny)', value: 'deny' },
];

const actionModel = computed({
  get: () => props.viz.filters.action ?? '',
  set: (v: string) => {
    props.viz.filters.action = (v || null) as 'allow' | 'deny' | null;
  },
});
const zoneModel = computed({
  get: () => props.viz.filters.zone ?? '',
  set: (v: string) => {
    props.viz.filters.zone = v || null;
  },
});
const unusedDaysModel = computed({
  get: () => (props.viz.filters.unusedDays != null ? String(props.viz.filters.unusedDays) : ''),
  set: (v: string) => {
    const n = Number(v);
    props.viz.filters.unusedDays = v.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  },
});
const zoneOptions = computed(() => props.viz.zones.map((z) => ({ label: z, value: z })));

/* ───── ① Zone × Zone 矩陣 ───── */
const cellMap = computed(() => {
  const m = new Map<string, MatrixCell>();
  for (const c of props.viz.matrix.cells) m.set(`${c.from}\u0000${c.to}`, c);
  return m;
});

function cellOf(from: string, to: string): MatrixCell | null {
  return cellMap.value.get(`${from}\u0000${to}`) ?? null;
}

function isCellSelected(from: string, to: string): boolean {
  const s = props.viz.selection;
  return !!s && s.kind === 'cell' && s.from === from && s.to === to;
}

function onSelectCell(from: string, to: string) {
  if (isCellSelected(from, to)) props.viz.select(null);
  else props.viz.select({ kind: 'cell', from, to });
}

function cellBg(c: MatrixCell): string {
  const max = props.viz.matrix.max || 1;
  const pct = Math.round(14 + (c.count / max) * 46);
  const colorVar = c.tone === 'allow' ? 'var(--c-success)' : c.tone === 'deny' ? 'var(--c-danger)' : 'var(--c-warning)';
  return `color-mix(in srgb, ${colorVar} ${pct}%, var(--glass-soft))`;
}

function cellTitle(c: MatrixCell): string {
  const toneLabel = c.tone === 'allow' ? '全允許' : c.tone === 'deny' ? '全拒絕' : `混合(允許 ${c.allow} / 拒絕 ${c.deny})`;
  const posList = c.positions.slice(0, 20).map((p) => `#${p}`).join(', ');
  const more = c.positions.length > 20 ? ` …共 ${c.positions.length} 條` : '';
  return `${c.from} → ${c.to}\n${toneLabel},出現 ${c.count} 次\n規則編號：${posList}${more}`;
}

/* ───── ② 規則順序條(ECharts 橫條圖 + dataZoom) ───── */
const SEV_RANK: Record<CheckSeverity, number> = { high: 4, medium: 3, low: 2, info: 1 };
const SEV_COLOR: Record<CheckSeverity, string> = { high: '#e0483e', medium: '#e0901a', low: '#2f7de1', info: '#64748b' };

function topSeverity(checks: OrderCheckMark[] | null): CheckSeverity | null {
  if (!checks || !checks.length) return null;
  let best = checks[0]!.severity;
  for (const c of checks) if (SEV_RANK[c.severity] > SEV_RANK[best]) best = c.severity;
  return best;
}

const orderOption = computed<Record<string, unknown>>(() => {
  const rows = props.viz.order;
  const hl = props.viz.highlighted;
  const showZoom = rows.length > 24;
  const endPct = rows.length > 24 ? Math.min(100, Math.round((24 / rows.length) * 100)) : 100;

  const yLabels = rows.map((r) => {
    const prefix = r.isDefault ? '[預設]' : `#${r.position}`;
    const sev = topSeverity(r.checks);
    const mark = sev ? (sev === 'high' ? ' !' : sev === 'medium' ? ' ▲' : ' •') : '';
    return `${prefix} ${r.name}${mark}`;
  });

  const barData = rows.map((r) => {
    const dimmed = r.disabled || (hl !== null && (r.position === null || !hl.has(r.position)));
    const baseColor = r.isDefault ? '#64748b' : r.tone === 'allow' ? '#12a150' : '#e0483e';
    return {
      value: r.logHits,
      row: r,
      itemStyle: {
        color: baseColor,
        opacity: dimmed ? 0.25 : 0.88,
        borderRadius: [0, 4, 4, 0],
      },
    };
  });

  const zeroScatter = rows
    .map((r, idx) => {
      if (!r.zeroHits && r.hitCount !== null) return null;
      const dimmed = r.disabled || (hl !== null && (r.position === null || !hl.has(r.position)));
      return {
        value: [0.08, idx],
        row: r,
        symbol: r.zeroHits ? 'diamond' : 'circle',
        symbolSize: r.zeroHits ? 9 : 7,
        itemStyle: {
          color: r.zeroHits ? '#e0901a' : '#94a3b8',
          opacity: dimmed ? 0.3 : 0.95,
        },
      };
    })
    .filter(Boolean);

  const checkScatter = rows
    .map((r, idx) => {
      const sev = topSeverity(r.checks);
      if (!sev) return null;
      const dimmed = hl !== null && (r.position === null || !hl.has(r.position));
      return {
        value: [Math.max(r.logHits, 0.2) + 0.15, idx],
        row: r,
        symbol: 'pin',
        symbolSize: 16,
        itemStyle: {
          color: SEV_COLOR[sev],
          opacity: dimmed ? 0.3 : 1,
        },
      };
    })
    .filter(Boolean);

  return {
    grid: { left: 210, right: showZoom ? 44 : 20, top: 14, bottom: 32 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const first = list[0] as { data?: { row?: OrderRow } } | undefined;
        const r = first?.data?.row;
        if (!r) return '';
        const head = r.isDefault ? `預設規則：${escHtml(r.name)}` : `#${r.position} ${escHtml(r.name)}`;
        const hitLine =
          r.hitCount === null ? '命中數：無資料' : r.zeroHits ? '命中數：0 次(未命中)' : `命中數：${escHtml(fmtNum(r.hitCount))} 次`;
        const lastLine = r.lastHit ? `<br/>最後命中：${escHtml(fmtTime(r.lastHit))}` : '';
        const disLine = r.disabled ? '<br/>狀態：停用' : '';
        let chkLine = '';
        if (r.checks && r.checks.length) {
          const labels = r.checks
            .map((c) => `[${SEVERITY_LABELS[c.severity]}] ${CHECK_LABELS[c.code as CheckCode] ?? c.code}`)
            .join('、');
          chkLine = `<br/>排序檢查：${escHtml(labels)}`;
        }
        return `<div><strong>${head}</strong><br/>動作：${escHtml(r.action)}<br/>${hitLine}${lastLine}${disLine}${chkLine}</div>`;
      },
    },
    xAxis: {
      type: 'value',
      name: 'log10(命中數+1)',
      nameLocation: 'middle',
      nameGap: 20,
      min: 0,
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: yLabels,
      axisLabel: {
        width: 195,
        overflow: 'truncate',
        fontSize: 12,
      },
    },
    dataZoom: showZoom
      ? [
          { type: 'inside', yAxisIndex: 0, start: 0, end: endPct },
          { type: 'slider', yAxisIndex: 0, right: 6, width: 14, start: 0, end: endPct },
        ]
      : [],
    series: [
      {
        name: '命中數(log)',
        type: 'bar',
        barMaxWidth: 16,
        data: barData,
      },
      {
        name: '0次/無資料',
        type: 'scatter',
        data: zeroScatter,
        silent: true,
      },
      {
        name: '檢查標記',
        type: 'scatter',
        data: checkScatter,
        silent: true,
      },
    ],
  };
});

function onOrderPick(p: ChartPick) {
  const d = p.data as { row?: OrderRow } | undefined;
  const r = d?.row;
  if (!r || r.isDefault) return;
  emit('open-rule', r.name);
}

/* ───── ③ Sankey(GEChart sankey) ───── */
const nodeLabelMap = computed(() => new Map(props.viz.sankey.nodes.map((n) => [n.id, n.name])));

const sankeyOption = computed<Record<string, unknown>>(() => {
  const map = nodeLabelMap.value;
  return {
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => {
        const item = p as {
          dataType?: string;
          name?: string;
          value?: number;
          data?: { displayName?: string; source?: string; target?: string; value?: number; estimated?: boolean; positions?: number[] };
        };
        if (item.dataType === 'edge' && item.data?.source && item.data?.target) {
          const sName = escHtml(map.get(item.data.source) ?? item.data.source);
          const tName = escHtml(map.get(item.data.target) ?? item.data.target);
          const val = fmtNum(Math.round(item.data.value ?? item.value ?? 0));
          const est = item.data.estimated ? '<br/><em>※ 多 zone 規則平均分攤,為估算值</em>' : '';
          const pos = item.data.positions?.length
            ? `<br/>規則編號：${escHtml(item.data.positions.slice(0, 15).map((x) => `#${x}`).join(', '))}${item.data.positions.length > 15 ? '…' : ''}`
            : '';
          return `<div><strong>${sName} → ${tName}</strong><br/>命中數：${escHtml(val)}${est}${pos}</div>`;
        }
        const label = escHtml(item.data?.displayName ?? map.get(item.name ?? '') ?? item.name ?? '');
        return `<div><strong>${label}</strong><br/>命中數：${escHtml(fmtNum(Math.round(item.value ?? 0)))}</div>`;
      },
    },
    series: [
      {
        type: 'sankey',
        left: 16,
        right: 110,
        top: 16,
        bottom: 16,
        nodeWidth: 18,
        nodeGap: 10,
        emphasis: { focus: 'adjacency' },
        lineStyle: { color: 'gradient', curveness: 0.45, opacity: 0.4 },
        label: {
          formatter: (p: unknown) => (p as { data?: { displayName?: string } }).data?.displayName ?? '',
        },
        data: props.viz.sankey.nodes.map((n) => ({
          id: n.id,
          name: n.id,
          displayName: n.name,
          depth: n.layer,
          itemStyle:
            n.id === 'a:allow'
              ? { color: '#12a150' }
              : n.id === 'a:deny'
                ? { color: '#e0483e' }
                : n.id === 'p:預設規則'
                  ? { color: '#64748b' }
                  : undefined,
        })),
        links: props.viz.sankey.links.map((l) => ({
          source: l.source,
          target: l.target,
          value: l.value,
          estimated: l.estimated,
          positions: l.positions,
        })),
      },
    ],
  };
});

function onSankeyPick(p: ChartPick) {
  const d = p.data as { source?: string; target?: string } | undefined;
  if (d?.source && d?.target) {
    const s = props.viz.selection;
    if (s && s.kind === 'link' && s.source === d.source && s.target === d.target) {
      props.viz.select(null);
    } else {
      props.viz.select({ kind: 'link', source: d.source, target: d.target });
    }
  }
}

const selectionText = computed(() => {
  const s = props.viz.selection;
  if (!s) return '';
  if (s.kind === 'cell') return `矩陣格：${s.from} → ${s.to}`;
  const map = nodeLabelMap.value;
  return `Sankey 連線：${map.get(s.source) ?? s.source} → ${map.get(s.target) ?? s.target}`;
});

function resetFilters() {
  props.viz.filters.action = null;
  props.viz.filters.zone = null;
  props.viz.filters.unusedDays = null;
  props.viz.select(null);
}
</script>

<template>
  <div class="viz-tab">
    <GCard class="filter-card">
      <div class="viz-filters">
        <GSelect v-model="actionModel" label="動作 (Action)" placeholder="全部動作" :options="ACTION_OPTIONS" />
        <GSelect v-model="zoneModel" label="Zone" placeholder="全部 Zone" :options="zoneOptions" />
        <GInput v-model="unusedDaysModel" label="長期未命中 (天)" type="number" placeholder="例: 90" clearable />
        <GButton variant="ghost" icon="reset" @click="resetFilters">重設篩選</GButton>
        <div class="spacer" />
        <div class="meta-pills">
          <GBadge tone="primary" variant="soft">符合規則 {{ fmtNum(viz.ruleCount) }} 條</GBadge>
          <template v-if="viz.selection">
            <GBadge tone="info" variant="outline">{{ selectionText }}</GBadge>
            <GButton size="sm" variant="secondary" icon="x" @click="viz.select(null)">清除選取</GButton>
          </template>
        </div>
      </div>

      <GAlert v-if="policy.allError" tone="danger" class="mt-2">{{ describeError(policy.allError) }}</GAlert>
    </GCard>

    <GSkeleton v-if="policy.allLoading && !policy.allRules.length" :rows="8" />

    <template v-else>
      <GCard class="viz-card">
        <header class="viz-head">
          <div>
            <h3>1. Zone × Zone 矩陣</h3>
            <p class="xs muted">
              列為來源 Zone、欄為目的 Zone;停用規則不計入。點擊格子可連動下方順序條強調相關規則。
            </p>
          </div>
          <div class="legend xs">
            <span class="lg"><i class="dot allow" />全允許</span>
            <span class="lg"><i class="dot deny" />全拒絕</span>
            <span class="lg"><i class="dot mixed" />混合</span>
          </div>
        </header>

        <GAlert tone="info" class="mb-2">
          格子數字是<strong>規則出現次數</strong>,多 zone 規則會出現在多格,不可直接加總成總規則數。
        </GAlert>

        <GEmpty
          v-if="!viz.matrix.rows.length || !viz.matrix.cols.length"
          icon="grid"
          title="目前篩選沒有啟用規則可繪製矩陣"
        />

        <div v-else class="matrix-scroll">
          <div
            class="matrix-grid"
            :style="{ gridTemplateColumns: `140px repeat(${viz.matrix.cols.length}, minmax(76px, 1fr))` }"
          >
            <div class="m-corner xs muted">來源 \ 目的</div>
            <div v-for="col in viz.matrix.cols" :key="`c-${col}`" class="m-col-hdr mono xs">{{ col }}</div>

            <template v-for="row in viz.matrix.rows" :key="`r-${row}`">
              <div class="m-row-hdr mono xs">{{ row }}</div>
              <template v-for="col in viz.matrix.cols" :key="`${row}-${col}`">
                <button
                  v-if="cellOf(row, col)"
                  type="button"
                  class="m-cell mono"
                  :class="[`tone-${cellOf(row, col)!.tone}`, { selected: isCellSelected(row, col) }]"
                  :style="{ background: cellBg(cellOf(row, col)!) }"
                  :title="cellTitle(cellOf(row, col)!)"
                  @click="onSelectCell(row, col)"
                >
                  {{ cellOf(row, col)!.count }}
                </button>
                <div v-else class="m-cell empty">—</div>
              </template>
            </template>
          </div>
        </div>
      </GCard>

      <GCard class="viz-card">
        <header class="viz-head">
          <div>
            <h3>2. 規則順序條 (Rulebase 階梯)</h3>
            <p class="xs muted">
              依 PA 比對順序由上往下排列,長條為 log10(命中數 + 1);點擊規則可開啟詳細抽屜。
            </p>
          </div>
          <div class="legend xs">
            <span class="lg"><i class="dot allow" />允許</span>
            <span class="lg"><i class="dot deny" />拒絕</span>
            <span class="lg"><i class="dot zero" />0 次命中</span>
            <span class="lg"><i class="dot nodata" />無資料 / 預設規則</span>
          </div>
        </header>

        <GEmpty v-if="!viz.order.length" icon="list" title="目前篩選沒有可顯示的規則" />
        <GEChart
          v-else
          chart="policy-order"
          :option="orderOption"
          :height="`${Math.min(560, Math.max(280, viz.order.length * 24 + 60))}px`"
          ariaLabel="安全規則順序與命中數橫條圖"
          @pick="onOrderPick"
        />
      </GCard>

      <GCard class="viz-card">
        <header class="viz-head">
          <div>
            <h3>3. 規則命中流向 (Sankey)</h3>
            <p class="xs muted">
              來源 Zone → 動作 → 目的 Zone(線寬為命中數,預設規則獨立於左側「預設規則」節點)。點擊連線可連動順序條。
            </p>
          </div>
        </header>

        <GEmpty
          v-if="!viz.sankey.links.length"
          icon="graph"
          title="沒有命中數資料可繪製 Sankey"
          description="目前篩選範圍內的啟用規則與預設規則皆無命中紀錄。"
        />
        <GEChart
          v-else
          chart="policy-sankey"
          :option="sankeyOption"
          height="380px"
          ariaLabel="安全規則來源區域至動作至目的區域命中流向桑基圖"
          @pick="onSankeyPick"
        />
      </GCard>
    </template>
  </div>
</template>

<style scoped>
.viz-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.viz-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
}
.viz-filters > .g-select,
.viz-filters > .g-field {
  min-width: 170px;
}
.spacer {
  flex: 1;
}
.meta-pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.mt-2 {
  margin-top: 12px;
}
.mb-2 {
  margin-bottom: 12px;
}
.viz-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 12px;
}
.viz-head h3 {
  margin: 0;
  font-size: var(--fs-md);
}
.viz-head p {
  margin: 4px 0 0;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  color: var(--text-2);
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  display: inline-block;
}
.dot.allow {
  background: var(--c-success);
}
.dot.deny {
  background: var(--c-danger);
}
.dot.mixed {
  background: var(--c-warning);
}
.dot.zero {
  background: var(--c-warning);
  transform: rotate(45deg);
}
.dot.nodata {
  background: #94a3b8;
  border-radius: 50%;
}
.matrix-scroll {
  overflow-x: auto;
}
.matrix-grid {
  display: grid;
  gap: 4px;
  min-width: 420px;
}
.m-corner,
.m-col-hdr,
.m-row-hdr {
  padding: 6px 8px;
  font-weight: 600;
  display: flex;
  align-items: center;
  background: var(--glass-soft);
  border-radius: 6px;
}
.m-col-hdr {
  justify-content: center;
  text-align: center;
  word-break: break-all;
}
.m-row-hdr {
  word-break: break-all;
}
.m-cell {
  height: 36px;
  border-radius: 6px;
  border: 1px solid var(--line);
  display: grid;
  place-items: center;
  font-size: var(--fs-sm);
  font-weight: 700;
  color: var(--text);
  cursor: pointer;
  transition: transform var(--dur), box-shadow var(--dur), border-color var(--dur);
}
.m-cell:hover:not(.empty) {
  transform: translateY(-1px);
  border-color: var(--c-primary);
}
.m-cell.selected {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
  box-shadow: var(--shadow-glow);
}
.m-cell.empty {
  background: transparent;
  border-style: dashed;
  color: var(--text-3);
  font-weight: 400;
  cursor: default;
}
</style>
