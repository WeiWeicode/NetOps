<script setup lang="ts">
/**
 * 防火牆 › 分析儀表板(V-b2;HANDOFF-GEMINI-VIZ §3.3、§4.2、§5、§7):
 *   - 期間選擇:今天 / 7 天 / 30 天 / 90 天 / 自訂(≤ 90 天),含今天時每 60 秒自動刷新
 *   - 頁籤:流量分析 / 威脅分析(AD 異常之後獨立做在 AD 網域)
 *   - 流量 Tab:GTrendDualAxis、GSankey、GTopBars、GAppShare(甜甜圈/Treemap 切換)、GAllowDeny
 *   - 威脅 Tab:GSeverityCards(含與前一期比較、count-up、呼吸光暈)、GThreatTimeline、GWorldMap、GTopCompare(含 notes)、Top 10 威脅名稱
 *   - 每個圖表皆提供「看表格」無障礙切換(同一份資料,點擊列同樣開啟時段明細)
 *   - 429 NETOPS_INSIGHT_BUSY 時顯示中性提示並倒數自動重試
 *   - 任何圖表元素點擊 → useChartPick.toSliceQuery → useSlice.open(SliceDrawer)
 *   - AC4「AI 摘要本期異常」:標題列按鈕(權限 netops.pa-insight.ai)開對話框,摘要目前頁籤與期間(後端用儀表板快取);
 *     時段明細抽屜的「AI 解讀這個時段」用同一個按鈕權限
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { fmtNum, fmtSize } from '@/api/format';
import type { ExplainInput } from '@/api/ai';
import { ApiError, can, describeError } from '@/api/gateway';
import { UI } from '@/api/perms';
import AiExplainPanel from '@/components/AiExplainPanel.vue';
import type { CountryCount, TopApp, TopIp, TopIpTraffic, TopThreatName } from '@/api/insight';
import SliceDrawer from '@/components/SliceDrawer.vue';
import { useChartPick } from '@/composables/useChartPick';
import { useInsight, type InsightView, type RangePreset } from '@/composables/useInsight';
import { useSlice } from '@/composables/useSlice';
import { taipeiLocal } from '@/composables/vizTime';
import { toast } from '@/ui';
import GAllowDeny from '@/ui/charts/GAllowDeny.vue';
import GAppShare from '@/ui/charts/GAppShare.vue';
import GEChart from '@/ui/charts/GEChart.vue';
import GSankey from '@/ui/charts/GSankey.vue';
import GSeverityCards from '@/ui/charts/GSeverityCards.vue';
import GThreatTimeline from '@/ui/charts/GThreatTimeline.vue';
import GTopBars from '@/ui/charts/GTopBars.vue';
import GTopCompare from '@/ui/charts/GTopCompare.vue';
import GTrendDualAxis from '@/ui/charts/GTrendDualAxis.vue';
import GWorldMap from '@/ui/charts/GWorldMap.vue';
import type { ChartPick } from '@/ui/charts/viz-types';
import type { Column } from '@/ui/components/GTable.vue';

const traffic = useInsight('traffic');
const threat = useInsight('threat', { immediate: false });
const { toSliceQuery } = useChartPick();
const s = useSlice();

const activeTab = ref<InsightView>('traffic');
const threatLoadedRange = ref('');
const drawer = ref(false);
const appShareMode = ref<'donut' | 'treemap'>('donut');

const customOpen = ref(false);
const customFrom = ref(traffic.range.value.from);
const customTo = ref(traffic.range.value.to);

const activeInsight = computed(() => (activeTab.value === 'traffic' ? traffic : threat));

/* ───── AC4 AI 摘要本期異常(目前頁籤 + 期間;後端用儀表板快取) ───── */
const canAi = computed(() => can(UI.paInsightAi));
const aiOpen = ref(false);
const aiInput = computed<ExplainInput>(() => ({ kind: 'insight', params: { view: activeTab.value, from: activeInsight.value.range.value.from, to: activeInsight.value.range.value.to } }));
const aiReady = computed(() => !!activeInsight.value.data.value && !activeInsight.value.rangeError.value);
const aiSubtitle = computed(() => {
  const p = aiInput.value.params as { view: string; from: string; to: string };
  return `${p.view === 'traffic' ? '流量' : '安全威脅'} · ${p.from}${p.to !== p.from ? ` ~ ${p.to}` : ''}`;
});

/** 切換到威脅 Tab 或期間改變時同步威脅視角 */
function syncThreatIfNeeded() {
  if (activeTab.value !== 'threat') return;
  const r = traffic.range.value;
  const key = `${r.from}:${r.to}`;
  if (threat.range.value.from !== r.from || threat.range.value.to !== r.to) {
    if (traffic.activePreset.value !== 'custom') {
      threat.preset(traffic.activePreset.value);
    } else {
      threat.setCustom(r.from, r.to);
    }
    threatLoadedRange.value = key;
  } else if (threatLoadedRange.value !== key && !threat.data.value && !threat.loading.value) {
    threatLoadedRange.value = key;
    void threat.refresh();
  }
}

watch(activeTab, () => syncThreatIfNeeded());

function selectPreset(p: RangePreset) {
  if (p === 'custom') {
    customFrom.value = traffic.range.value.from;
    customTo.value = traffic.range.value.to;
    customOpen.value = true;
    return;
  }
  customOpen.value = false;
  traffic.preset(p);
  if (activeTab.value === 'threat') {
    threat.preset(p);
    threatLoadedRange.value = `${traffic.range.value.from}:${traffic.range.value.to}`;
  }
}

function applyCustomRange() {
  const ok = traffic.setCustom(customFrom.value, customTo.value);
  if (ok && activeTab.value === 'threat') {
    threat.setCustom(customFrom.value, customTo.value);
    threatLoadedRange.value = `${customFrom.value}:${customTo.value}`;
  }
}

function refreshActive() {
  if (activeTab.value === 'traffic') void traffic.refresh();
  else void threat.refresh();
}

/* ───── 429 NETOPS_INSIGHT_BUSY 自動重試倒數(§2.1) ───── */
const busyRetrySec = ref(0);
let busyTimer: ReturnType<typeof setInterval> | undefined;

function clearBusyTimer() {
  clearInterval(busyTimer);
  busyTimer = undefined;
}

const isInsightBusy = computed(() => {
  const err = activeInsight.value.error.value;
  return err instanceof ApiError && (err.status === 429 || err.code === 'NETOPS_INSIGHT_BUSY');
});

watch(
  () => activeInsight.value.error.value,
  (err) => {
    clearBusyTimer();
    if (err instanceof ApiError && (err.status === 429 || err.code === 'NETOPS_INSIGHT_BUSY')) {
      const d = err.details as { retryAfter?: number } | undefined;
      busyRetrySec.value = Math.max(1, Number(d?.retryAfter) || 5);
      busyTimer = setInterval(() => {
        busyRetrySec.value = Math.max(0, busyRetrySec.value - 1);
        if (busyRetrySec.value === 0) {
          clearBusyTimer();
          refreshActive();
        }
      }, 1000);
    } else {
      busyRetrySec.value = 0;
    }
  },
);

/* ───── 每個圖表的「看表格」無障礙切換(§3.3) ───── */
const tableMode = reactive<Record<string, boolean>>({
  trend: false,
  sankey: false,
  topIp: false,
  topApp: false,
  allowDeny: false,
  severity: false,
  timeline: false,
  country: false,
  compare: false,
  topNames: false,
});

function toggleTable(key: string) {
  tableMode[key] = !tableMode[key];
}

/* ───── 點擊圖表或表格列 → 時段明細抽屜(§3.3) ───── */
function onPick(p: ChartPick) {
  // 沒有 Log 明細權限:提示而不是靜默不動(程式碼審查 #5)
  if (!traffic.canSlice.value) return toast.info('沒有時段明細權限', '需要「Log 明細查詢」權限才能開啟時段明細');
  const d = traffic.data.value;
  const td = threat.data.value;
  const q = toSliceQuery(p, traffic.range.value, {
    bucketSeconds: activeTab.value === 'traffic' ? d?.bucketSeconds : td?.bucketSeconds,
    allowDenyBucketSeconds: d?.allowDenyBucketSeconds,
  });
  if (!q) return;
  drawer.value = true;
  void s.open(q);
}

/* ───── Top 10 威脅名稱圖表設定(威脅 Tab 第 5 張圖) ───── */
// 窄螢幕(≤ 640px)縮小左側標籤區,不讓長條只剩幾十 px(程式碼審查 #7)
const narrowMq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;
const narrow = ref(!!narrowMq?.matches);
const onNarrow = (e: MediaQueryListEvent) => (narrow.value = e.matches);
narrowMq?.addEventListener?.('change', onNarrow);
onBeforeUnmount(() => narrowMq?.removeEventListener?.('change', onNarrow));
const themeTick = ref(0);
let mo: MutationObserver | null = null;

onMounted(() => {
  if (typeof document !== 'undefined') {
    mo = new MutationObserver(() => {
      themeTick.value++;
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-style'] });
  }
});

onBeforeUnmount(() => {
  clearBusyTimer();
  mo?.disconnect();
});

const esc = (str: unknown): string =>
  String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function token(name: string, fallback: string): string {
  void themeTick.value;
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

const topNamesOption = computed<Record<string, unknown>>(() => {
  const items = [...(threat.data.value?.topNames ?? [])].slice(0, 10).reverse();
  const sevColors: Record<string, string> = {
    critical: token('--c-danger', '#e0483e'),
    high: token('--c-warning', '#e0901a'),
    medium: token('--c-info', '#2f7de1'),
    low: token('--c-cyan', '#0891b2'),
    info: token('--text-3', '#566b7c'),
  };

  return {
    grid: { top: 16, right: 28, bottom: 24, left: narrow.value ? '38%' : 210, containLabel: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : [params];
        const first = arr[0] as { dataIndex?: number } | undefined;
        const item = items[first?.dataIndex ?? 0];
        if (!item) return '';
        return [
          `<div><strong>${esc(item.name)}</strong></div>`,
          `<div>嚴重度：<strong>${esc(item.severity)}</strong></div>`,
          `<div>次數：<strong>${esc(fmtNum(item.count))}</strong></div>`,
        ].join('');
      },
    },
    xAxis: { type: 'value' },
    yAxis: {
      type: 'category',
      data: items.map((x) => x.name),
      axisLabel: {
        width: narrow.value ? 110 : 195,
        overflow: 'truncate',
      },
    },
    series: [
      {
        name: '威脅次數',
        type: 'bar',
        barMaxWidth: 18,
        data: items.map((x) => ({
          name: x.name,
          value: x.count,
          severity: x.severity,
          itemStyle: {
            color: sevColors[x.severity] ?? sevColors.info,
            borderRadius: [0, 4, 4, 0],
          },
        })),
      },
    ],
  };
});

/* ───── 表格欄位與資料列轉換(無障礙「看表格」共用同一份資料) ───── */
const trendCols: Column[] = [
  { key: 'time', label: '時間', mono: true },
  { key: 'recvFmt', label: '下載流量', align: 'right' },
  { key: 'sentFmt', label: '上傳流量', align: 'right' },
  { key: 'sessionsFmt', label: '連線數 (Session)', align: 'right' },
];
const trendRows = computed(() =>
  (traffic.data.value?.trend ?? []).map((p) => ({
    t: p.t,
    time: taipeiLocal(p.t).replace('T', ' '),
    recvFmt: p.recv === null ? '沒有資料' : fmtSize(p.recv),
    sentFmt: p.sent === null ? '沒有資料' : fmtSize(p.sent),
    sessionsFmt: p.sessions === null ? '沒有資料' : fmtNum(p.sessions),
  })),
);

const sankeyCols: Column[] = [
  { key: 'sourceName', label: '起點' },
  { key: 'targetName', label: '終點' },
  { key: 'bytesFmt', label: '流量', align: 'right' },
];
const sankeyRows = computed(() => {
  const sk = traffic.data.value?.sankey;
  if (!sk) return [];
  const map = new Map(sk.nodes.map((n) => [n.id, n.name]));
  return sk.links.map((l, idx) => ({
    _id: `${idx}-${l.source}-${l.target}`,
    source: l.source,
    target: l.target,
    sourceName: map.get(l.source) ?? l.source,
    targetName: map.get(l.target) ?? l.target,
    bytesFmt: fmtSize(l.bytes),
  }));
});

const topIpCols: Column[] = [
  { key: 'ip', label: '來源 IP', mono: true, ip: true },
  { key: 'bytesFmt', label: '總流量', align: 'right' },
  { key: 'recvFmt', label: '下載', align: 'right' },
  { key: 'sentFmt', label: '上傳', align: 'right' },
  { key: 'sessionsFmt', label: '連線數', align: 'right' },
];
const topIpRows = computed(() =>
  (traffic.data.value?.topIp ?? []).map((x: TopIpTraffic) => ({
    ip: x.ip,
    bytesFmt: fmtSize(x.bytes),
    recvFmt: fmtSize(x.recv),
    sentFmt: fmtSize(x.sent),
    sessionsFmt: fmtNum(x.sessions),
  })),
);

const topAppCols: Column[] = [
  { key: 'app', label: '應用程式' },
  { key: 'bytesFmt', label: '總流量', align: 'right' },
  { key: 'sessionsFmt', label: '連線數', align: 'right' },
];
const topAppRows = computed(() =>
  (traffic.data.value?.topApp ?? []).map((x: TopApp) => ({
    app: x.app,
    bytesFmt: fmtSize(x.bytes),
    sessionsFmt: fmtNum(x.sessions),
  })),
);

const allowDenyCols: Column[] = [
  { key: 'time', label: '時間', mono: true },
  { key: 'allowFmt', label: '允許 (Allow)', align: 'right' },
  { key: 'denyFmt', label: '阻擋 (Deny)', align: 'right' },
];
const allowDenyRows = computed(() =>
  (traffic.data.value?.allowDeny ?? []).map((p) => ({
    t: p.t,
    time: taipeiLocal(p.t).replace('T', ' '),
    allowFmt: p.allow === null ? '沒有資料' : fmtNum(p.allow),
    denyFmt: p.deny === null ? '沒有資料' : fmtNum(p.deny),
  })),
);

const sevTableCols: Column[] = [
  { key: 'label', label: '嚴重度' },
  { key: 'currFmt', label: '本期數量', align: 'right' },
  { key: 'prevFmt', label: '前一期數量', align: 'right' },
  { key: 'diffFmt', label: '比較增減', align: 'right' },
];
const sevTableRows = computed(() => {
  const sc = threat.data.value?.score;
  if (!sc) return [];
  const defs = [
    { key: 'critical', label: '嚴重 (Critical)' },
    { key: 'high', label: '高風險 (High)' },
    { key: 'medium', label: '中風險 (Medium)' },
    { key: 'low', label: '低風險 (Low)' },
    { key: 'info', label: '資訊 (Info)' },
  ] as const;
  return defs.map((d) => {
    const curr = sc[d.key];
    const prev = sc.prev ? sc.prev[d.key] : null;
    const diff = prev !== null ? curr - prev : null;
    return {
      key: d.key,
      label: d.label,
      currFmt: fmtNum(curr),
      prevFmt: prev !== null ? fmtNum(prev) : '—',
      diffFmt: diff === null ? '—' : diff > 0 ? `+${fmtNum(diff)}` : diff < 0 ? fmtNum(diff) : '持平',
    };
  });
});

const timelineCols: Column[] = [
  { key: 'time', label: '時間', mono: true },
  { key: 'criticalFmt', label: '嚴重', align: 'right' },
  { key: 'highFmt', label: '高風險', align: 'right' },
  { key: 'mediumFmt', label: '中風險', align: 'right' },
  { key: 'lowFmt', label: '低風險', align: 'right' },
];
const timelineRows = computed(() =>
  (threat.data.value?.timeline ?? []).map((p) => ({
    t: p.t,
    time: taipeiLocal(p.t).replace('T', ' '),
    criticalFmt: p.critical === null ? '沒有資料' : fmtNum(p.critical),
    highFmt: p.high === null ? '沒有資料' : fmtNum(p.high),
    mediumFmt: p.medium === null ? '沒有資料' : fmtNum(p.medium),
    lowFmt: p.low === null ? '沒有資料' : fmtNum(p.low),
  })),
);

const countryCols: Column[] = [
  { key: 'country', label: '國家' },
  { key: 'iso2Fmt', label: 'ISO2', mono: true, width: '80px' },
  { key: 'countFmt', label: '總威脅數', align: 'right' },
  { key: 'criticalFmt', label: '嚴重', align: 'right' },
  { key: 'highFmt', label: '高風險', align: 'right' },
];
const countryRows = computed(() =>
  (threat.data.value?.countries ?? []).map((c: CountryCount) => ({
    _id: `${c.iso2 ?? 'unk'}-${c.country}`,
    raw: c,
    country: c.country,
    iso2Fmt: c.iso2 ?? '—',
    countFmt: fmtNum(c.count),
    criticalFmt: fmtNum(c.critical),
    highFmt: fmtNum(c.high),
  })),
);

const compareCols: Column[] = [
  { key: 'ip', label: 'IP 位址', mono: true, ip: true },
  { key: 'countFmt', label: '總威脅數', align: 'right' },
  { key: 'highFmt', label: '高風險以上', align: 'right' },
];
const leftCompareRows = computed(() =>
  (threat.data.value?.topInternalSrc ?? []).map((x: TopIp) => ({
    ip: x.ip,
    countFmt: fmtNum(x.count),
    highFmt: fmtNum(x.high),
  })),
);
const rightCompareRows = computed(() =>
  (threat.data.value?.topServerDst ?? []).map((x: TopIp) => ({
    ip: x.ip,
    countFmt: fmtNum(x.count),
    highFmt: fmtNum(x.high),
  })),
);

const topNameCols: Column[] = [
  { key: 'name', label: '威脅名稱' },
  { key: 'severity', label: '嚴重度', width: '100px' },
  { key: 'countFmt', label: '次數', align: 'right', width: '110px' },
];
const topNameRows = computed(() =>
  (threat.data.value?.topNames ?? []).map((x: TopThreatName) => ({
    name: x.name,
    severity: x.severity,
    countFmt: fmtNum(x.count),
  })),
);
</script>

<template>
  <div class="viz-insight stack">
    <GPageHeader
      title="分析儀表板"
      subtitle="PA-560 流量與威脅多維度視覺化分析；點擊任意圖表元素或表格列可聯動開啟時段明細抽屜"
    >
      <span v-if="activeInsight.includesToday.value" class="faint xs">含今日資料 · 每 60 秒自動更新</span>
      <GButton size="sm" variant="secondary" icon="refresh" :loading="activeInsight.loading.value" @click="refreshActive()">
        重新整理
      </GButton>
      <GButton v-if="canAi" size="sm" variant="primary" icon="sparkles" :disabled="!aiReady" @click="aiOpen = true">AI 摘要本期異常</GButton>
    </GPageHeader>

    <!-- 視角 Tab 與期間選擇列 -->
    <div class="viz-insight__top">
      <!-- 視角頁籤:流量 / 威脅(U6:移除「AD 異常」頁籤,AD 之後獨立做在 AD 網域) -->
      <nav class="viz-tabs glass" role="tablist" aria-label="分析儀表板視角">
        <button
          type="button"
          role="tab"
          class="viz-tabs__tab"
          :class="{ active: activeTab === 'traffic' }"
          :aria-selected="activeTab === 'traffic'"
          @click="activeTab = 'traffic'"
        >
          <GIcon name="activity" :size="16" />
          <span>流量分析</span>
        </button>
        <button
          type="button"
          role="tab"
          class="viz-tabs__tab"
          :class="{ active: activeTab === 'threat' }"
          :aria-selected="activeTab === 'threat'"
          @click="activeTab = 'threat'"
        >
          <GIcon name="shield-alert" :size="16" />
          <span>威脅分析</span>
        </button>
      </nav>

      <div class="spacer" />

      <!-- 期間預設切換(今天 / 7 天 / 30 天 / 90 天 / 自訂 ≤ 90 天) -->
      <div class="viz-insight__range-bar">
        <div class="viz-preset-seg" role="radiogroup" aria-label="統計期間">
          <button
            v-for="p in traffic.presets"
            :key="p.value"
            type="button"
            role="radio"
            class="viz-preset-seg__btn"
            :class="{ active: (customOpen && p.value === 'custom') || (!customOpen && traffic.activePreset.value === p.value) }"
            :aria-checked="(customOpen && p.value === 'custom') || (!customOpen && traffic.activePreset.value === p.value)"
            @click="selectPreset(p.value)"
          >
            {{ p.label }}
          </button>
        </div>
        <span class="mono xs muted">{{ traffic.range.value.from }} ~ {{ traffic.range.value.to }}</span>
      </div>
    </div>

    <!-- 自訂期間輸入列 -->
    <GCard v-if="customOpen || traffic.activePreset.value === 'custom'" padding="sm">
      <div class="viz-custom-range">
        <span class="small strong">自訂期間（最長 90 天）</span>
        <input v-model="customFrom" type="date" class="viz-date-input" aria-label="開始日期" />
        <span class="muted">至</span>
        <input v-model="customTo" type="date" class="viz-date-input" aria-label="結束日期" />
        <GButton size="sm" variant="primary" @click="applyCustomRange">套用期間</GButton>
        <span v-if="traffic.rangeError.value" class="c-danger small" role="alert">{{ traffic.rangeError.value }}</span>
      </div>
    </GCard>

    <!-- 429 NETOPS_INSIGHT_BUSY 中性提示與倒數重試(§2.1、§7) -->
    <GAlert v-if="isInsightBusy" tone="info" title="儀表板計算忙碌中">
      <div class="row">
        <span>目前系統同時計算已達上限，將於 {{ busyRetrySec }} 秒後自動重試</span>
        <GButton size="sm" variant="secondary" @click="refreshActive()">立即重試</GButton>
      </div>
    </GAlert>
    <GAlert v-else-if="activeInsight.error.value" tone="danger" title="儀表板資料讀取失敗">
      {{ describeError(activeInsight.error.value) }}
    </GAlert>

    <!-- ==================== 流量分析 Tab ==================== -->
    <div v-if="activeTab === 'traffic'" class="stack">
      <div v-if="traffic.loading.value && !traffic.data.value" class="grid grid-2">
        <GSkeleton height="300px" />
        <GSkeleton height="300px" />
      </div>

      <template v-else-if="traffic.data.value">
        <GAlert v-if="traffic.data.value.coverage.since === null" tone="info">
          彙總表還沒有資料（此日期前沒有資料）。
        </GAlert>

        <!-- 1. 上傳 / 下載 + Session 雙軸趨勢 -->
        <GCard
          title="上傳 / 下載流量與 Session 雙軸趨勢"
          :subtitle="`時間粒度：每 ${traffic.data.value.bucketSeconds >= 86400 ? '1 天' : traffic.data.value.bucketSeconds >= 3600 ? '1 小時' : '5 分鐘'}（點擊時間點開啟明細）`"
        >
          <template #actions>
            <GButton size="sm" variant="ghost" icon="table" @click="toggleTable('trend')">
              {{ tableMode.trend ? '看圖表' : '看表格' }}
            </GButton>
          </template>
          <GTable
            v-if="tableMode.trend"
            :columns="trendCols"
            :rows="trendRows"
            row-key="t"
            dense
            clickable
            @row-click="(row) => onPick({ chart: 'trend', name: row.t })"
          />
          <GTrendDualAxis
            v-else
            :points="traffic.data.value.trend"
            :bucket-seconds="traffic.data.value.bucketSeconds"
            @pick="onPick"
          />
        </GCard>

        <!-- 2. 來源區域 → App → 目的區域桑基圖 -->
        <GCard title="來源區域 → 應用程式 → 目的區域流量桑基圖" subtitle="點擊節點或連線可依區域與應用程式篩選時段明細">
          <template #actions>
            <GButton size="sm" variant="ghost" icon="table" @click="toggleTable('sankey')">
              {{ tableMode.sankey ? '看圖表' : '看表格' }}
            </GButton>
          </template>
          <GTable
            v-if="tableMode.sankey"
            :columns="sankeyCols"
            :rows="sankeyRows"
            row-key="_id"
            dense
            clickable
            @row-click="(row) => onPick({ chart: 'sankey', name: `${row.source}>${row.target}`, data: { source: row.source, target: row.target } })"
          />
          <GSankey
            v-else
            :nodes="traffic.data.value.sankey.nodes"
            :links="traffic.data.value.sankey.links"
            @pick="onPick"
          />
        </GCard>

        <!-- 3 & 4. Top 10 頻寬 IP 與 Top 10 App -->
        <div class="grid grid-2">
          <GCard title="Top 10 頻寬來源 IP（上傳 / 下載堆疊）" subtitle="點擊 IP 查看該來源 IP 明細">
            <template #actions>
              <GButton size="sm" variant="ghost" icon="table" @click="toggleTable('topIp')">
                {{ tableMode.topIp ? '看圖表' : '看表格' }}
              </GButton>
            </template>
            <GTable
              v-if="tableMode.topIp"
              :columns="topIpCols"
              :rows="topIpRows"
              row-key="ip"
              dense
              clickable
              @row-click="(row) => onPick({ chart: 'topIp', name: row.ip })"
            />
            <GTopBars v-else :items="traffic.data.value.topIp" @pick="onPick" />
          </GCard>

          <GCard title="Top 10 應用程式流量佔比" subtitle="可切換甜甜圈或 Treemap 視角">
            <template #actions>
              <GSegmented
                v-if="!tableMode.topApp"
                v-model="appShareMode"
                :options="[
                  { label: '甜甜圈', value: 'donut' },
                  { label: 'Treemap', value: 'treemap' },
                ]"
                size="sm"
              />
              <GButton size="sm" variant="ghost" icon="table" @click="toggleTable('topApp')">
                {{ tableMode.topApp ? '看圖表' : '看表格' }}
              </GButton>
            </template>
            <GTable
              v-if="tableMode.topApp"
              :columns="topAppCols"
              :rows="topAppRows"
              row-key="app"
              dense
              clickable
              @row-click="(row) => onPick({ chart: 'topApp', name: row.app })"
            />
            <GAppShare v-else :items="traffic.data.value.topApp" :mode="appShareMode" @pick="onPick" />
          </GCard>
        </div>

        <!-- 5. Allow vs Deny 堆疊柱 -->
        <GCard
          title="Allow vs Deny 連線堆疊柱狀圖"
          :subtitle="`時間粒度：每 ${traffic.data.value.allowDenyBucketSeconds >= 86400 ? '1 天' : '1 小時'}（點擊阻擋柱直接篩選非 allow 明細）`"
        >
          <template #actions>
            <GButton size="sm" variant="ghost" icon="table" @click="toggleTable('allowDeny')">
              {{ tableMode.allowDeny ? '看圖表' : '看表格' }}
            </GButton>
          </template>
          <GTable
            v-if="tableMode.allowDeny"
            :columns="allowDenyCols"
            :rows="allowDenyRows"
            row-key="t"
            dense
            clickable
            @row-click="(row) => onPick({ chart: 'allowDeny', name: row.t, series: 'deny' })"
          />
          <GAllowDeny
            v-else
            :points="traffic.data.value.allowDeny"
            :bucket-seconds="traffic.data.value.allowDenyBucketSeconds"
            @pick="onPick"
          />
        </GCard>
      </template>
    </div>

    <!-- ==================== 威脅分析 Tab ==================== -->
    <div v-else-if="activeTab === 'threat'" class="stack">
      <div v-if="threat.loading.value && !threat.data.value" class="grid grid-2">
        <GSkeleton height="140px" />
        <GSkeleton height="140px" />
        <GSkeleton height="300px" />
        <GSkeleton height="300px" />
      </div>

      <template v-else-if="threat.data.value">
        <GAlert v-if="threat.data.value.notes.length" tone="info" title="統計說明">
          <ul>
            <li v-for="n in threat.data.value.notes" :key="n">{{ n }}</li>
          </ul>
        </GAlert>

        <!-- 1. 嚴重度計分卡(含與前一期比較) -->
        <GCard title="威脅嚴重度計分卡（含與前一期比較）" subtitle="點擊任一嚴重度卡片查看該等級威脅明細">
          <template #actions>
            <GButton size="sm" variant="ghost" icon="table" @click="toggleTable('severity')">
              {{ tableMode.severity ? '看計分卡' : '看表格' }}
            </GButton>
          </template>
          <GTable
            v-if="tableMode.severity"
            :columns="sevTableCols"
            :rows="sevTableRows"
            row-key="key"
            dense
            clickable
            @row-click="(row) => onPick({ chart: 'severity', name: row.key })"
          />
          <GSeverityCards v-else :score="threat.data.value.score" @pick="onPick" />
        </GCard>

        <!-- 2. 威脅堆疊時序 -->
        <GCard title="威脅嚴重度堆疊時序" subtitle="點擊時間柱可依時段與嚴重度查看威脅明細">
          <template #actions>
            <GButton size="sm" variant="ghost" icon="table" @click="toggleTable('timeline')">
              {{ tableMode.timeline ? '看圖表' : '看表格' }}
            </GButton>
          </template>
          <GTable
            v-if="tableMode.timeline"
            :columns="timelineCols"
            :rows="timelineRows"
            row-key="t"
            dense
            clickable
            @row-click="(row) => onPick({ chart: 'timeline', name: row.t })"
          />
          <GThreatTimeline
            v-else
            :points="threat.data.value.timeline"
            :bucket-seconds="threat.data.value.bucketSeconds"
            @pick="onPick"
          />
        </GCard>

        <!-- 3. 國家 Top 10 + 世界地圖 -->
        <GCard title="全球威脅來源國家分布與 Top 10 排行" subtitle="內建 Natural Earth 世界地圖（不連外部 CDN）；點擊國家查看威脅明細">
          <template #actions>
            <GButton size="sm" variant="ghost" icon="table" @click="toggleTable('country')">
              {{ tableMode.country ? '看圖表' : '看表格' }}
            </GButton>
          </template>
          <GTable
            v-if="tableMode.country"
            :columns="countryCols"
            :rows="countryRows"
            row-key="_id"
            dense
            clickable
            @row-click="(row) => onPick({ chart: 'country', name: row.raw.iso2 ?? '', data: row.raw })"
          />
          <GWorldMap v-else :countries="threat.data.value.countries" :top="10" @pick="onPick" />
        </GCard>

        <!-- 4. 發起威脅最多內網 IP vs 被攻擊最多伺服器 -->
        <GCard title="發起威脅最多內網 IP vs 被攻擊最多伺服器" subtitle="左右對照內網異常來源與受攻擊目標伺服器">
          <template #actions>
            <GButton size="sm" variant="ghost" icon="table" @click="toggleTable('compare')">
              {{ tableMode.compare ? '看圖表' : '看表格' }}
            </GButton>
          </template>
          <div v-if="tableMode.compare" class="grid grid-2">
            <div>
              <h4 class="small strong" style="margin-bottom: 8px">發起威脅最多內網 IP</h4>
              <GTable
                :columns="compareCols"
                :rows="leftCompareRows"
                row-key="ip"
                dense
                clickable
                @row-click="(row) => onPick({ chart: 'topInternalSrc', name: row.ip })"
              />
            </div>
            <div>
              <h4 class="small strong" style="margin-bottom: 8px">被攻擊最多伺服器</h4>
              <GAlert v-if="threat.data.value.topServerDst === null" tone="info">
                <ul v-if="threat.data.value.notes.length">
                  <li v-for="n in threat.data.value.notes" :key="n">{{ n }}</li>
                </ul>
                <span v-else>尚未設定伺服器網段</span>
              </GAlert>
              <GTable
                v-else
                :columns="compareCols"
                :rows="rightCompareRows"
                row-key="ip"
                dense
                clickable
                @row-click="(row) => onPick({ chart: 'topServerDst', name: row.ip })"
              />
            </div>
          </div>
          <GTopCompare
            v-else
            :left="threat.data.value.topInternalSrc"
            :right="threat.data.value.topServerDst"
            left-title="發起威脅最多內網 IP"
            right-title="被攻擊最多伺服器"
            :notes="threat.data.value.notes"
            @pick="onPick"
          />
        </GCard>

        <!-- 5. Top 10 威脅名稱 -->
        <GCard title="Top 10 威脅名稱排行" subtitle="點擊威脅名稱開啟對應時段明細">
          <template #actions>
            <GButton size="sm" variant="ghost" icon="table" @click="toggleTable('topNames')">
              {{ tableMode.topNames ? '看圖表' : '看表格' }}
            </GButton>
          </template>
          <GTable
            v-if="tableMode.topNames"
            :columns="topNameCols"
            :rows="topNameRows"
            row-key="name"
            dense
            clickable
            @row-click="(row) => onPick({ chart: 'topNames', name: row.name })"
          />
          <GEChart
            v-else
            chart="topNames"
            height="300px"
            :option="topNamesOption"
            ariaLabel="Top 10 威脅名稱橫向長條圖"
            @pick="(p) => onPick({ ...p, chart: 'topNames' })"
          />
        </GCard>
      </template>
    </div>

    <!-- 時段明細抽屜 -->
    <SliceDrawer v-model="drawer" :slice="s" :ai-perm="UI.paInsightAi" />

    <!-- AC4:AI 摘要本期異常(開啟時自動開始;換頁籤或期間時清掉舊回答) -->
    <GModal v-if="canAi" v-model:open="aiOpen" title="AI 摘要本期異常" :subtitle="aiSubtitle" icon="sparkles" width="880px">
      <AiExplainPanel
        v-if="aiOpen"
        :input="aiInput"
        title="本期異常摘要"
        start-label="開始摘要"
        hint="只把儀表板的統計、Top 10 與前一期比較(不是原始 log)送到公司內部的 AI 服務,不會傳到外部"
        frame="plain"
        auto-start
      />
    </GModal>
  </div>
</template>

<style scoped>
.viz-insight__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.viz-tabs {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius-md);
}
.viz-tabs__tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 14px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  font: inherit;
  font-size: var(--fs-md);
  font-weight: 650;
  color: var(--text-2);
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.viz-tabs__tab:hover:not(:disabled) {
  color: var(--text);
}
.viz-tabs__tab.active {
  color: var(--c-primary-text);
  background: var(--glass-strong);
  box-shadow: var(--shadow-sm);
}
.viz-tabs__tab.is-disabled {
  cursor: not-allowed;
  opacity: 0.56;
}
.viz-tabs__hint {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--line);
  color: var(--text-3);
}

.viz-insight__range-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.viz-preset-seg {
  display: inline-flex;
  flex-wrap: wrap;
  padding: 3px;
  gap: 2px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
}
.viz-preset-seg__btn {
  height: 28px;
  padding: 0 11px;
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
.viz-preset-seg__btn:hover {
  color: var(--text);
}
.viz-preset-seg__btn.active {
  color: var(--text);
  background: var(--glass-strong);
  box-shadow: var(--shadow-sm);
}

.viz-custom-range {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.viz-date-input {
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--field-border);
  background: var(--field);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sm);
  color-scheme: inherit;
}
</style>
