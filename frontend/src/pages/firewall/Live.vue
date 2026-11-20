<script setup lang="ts">
/**
 * 防火牆 › 即時監控戰情室(WR-5;docs/WARROOM-PLAN.md §2、docs/WARROOM-GEMINI-HANDOFF.md §2、§3):
 *   - 取代現有 /firewall/live 頁面;資料與狀態一律由 useWarroom() 與 useWarroomAi() 提供，不自行 fetch、不自寫權限判斷
 *   - 版面(對照樣稿 warroom-v5.html):頂部 KPI、提示橫幅(Notices)、左說明(LegendPanel,可收摺)、中央 Canvas(WarroomCanvas)、
 *     右即時事件(EventFeed)、上 AI 分析框(AiPanel)、下近一小時高風險統計(RiskPanel)、底部 Log 表(TrafficLogTable)
 *   - 收集器狀態與測試區暫停開關移至收摺的「系統狀態」抽屜(SystemStatusDrawer)
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fmtNum } from '@/api/format';
import { collectorView, fmtBps, logSource } from '@/composables/paLive';
import { useLiveTop } from '@/composables/useLiveTop';
import { usePaSignatureDrawer } from '@/composables/usePaSignatureDrawer';
import { useWarroom } from '@/composables/useWarroom';
import { useWarroomAi } from '@/composables/useWarroomAi';
import SignatureDrawer from '@/components/signatures/SignatureDrawer.vue';
import AiPanel from '@/components/warroom/AiPanel.vue';
import EventFeed, { readFeedOpen } from '@/components/warroom/EventFeed.vue';
import LegendPanel, { readLegendOpen } from '@/components/warroom/LegendPanel.vue';
import NewSignatureHitsBar from '@/components/warroom/NewSignatureHitsBar.vue';
import Notices from '@/components/warroom/Notices.vue';
import RiskPanel, { readRiskOpen } from '@/components/warroom/RiskPanel.vue';
import RankingDrawer from '@/components/warroom/RankingDrawer.vue';
import SystemStatusDrawer from '@/components/warroom/SystemStatusDrawer.vue';
import TrafficLogTable, { readLogOpen } from '@/components/warroom/TrafficLogTable.vue';
import WarroomCanvas from '@/components/warroom/WarroomCanvas.vue';
import { toast } from '@/ui';

const w = useWarroom();
const a = useWarroomAi();
const sigDrawer = usePaSignatureDrawer();

async function openSignature(nameOrId: string) {
  const r = await sigDrawer.show(nameOrId);
  if (r !== 'ok' && r !== 'stale' && !sigDrawer.open && sigDrawer.notice) {
    toast.info(sigDrawer.notice);
  }
}

const legendOpen = ref(readLegendOpen());
const feedOpen = ref(readFeedOpen());
const logOpen = ref(readLogOpen());
const riskOpen = ref(readRiskOpen());
/**
 * AI 框與高風險框在 Canvas 上佔用的高度(AI:上緣 12 + 框高;高風險:框高 + 與 Log 表間距 14),
 * 傳給 Canvas 讓核心與儀表避開;收摺、文字長短變動時由 ResizeObserver 自動更新
 */
const aiRef = ref<{ $el: HTMLElement } | null>(null);
const riskRef = ref<{ $el: HTMLElement } | null>(null);
const aiReserve = ref(0);
const riskReserve = ref(0);
let panelObs: ResizeObserver | null = null;
onMounted(() => {
  const ai = aiRef.value?.$el;
  const risk = riskRef.value?.$el;
  if (typeof ResizeObserver === 'undefined') return;
  panelObs = new ResizeObserver(() => {
    if (ai) aiReserve.value = Math.round(ai.offsetTop + ai.offsetHeight);
    if (risk) riskReserve.value = Math.round(risk.offsetHeight) + 14;
  });
  if (ai) panelObs.observe(ai);
  if (risk) panelObs.observe(risk);
});
onBeforeUnmount(() => panelObs?.disconnect());
/** Log 表佔用的高度:Canvas、高風險框、事件欄的底邊跟著它(收摺時 Canvas 往下放大);58 = 收摺高 46 + 底距 12,見 TrafficLogTable .mini */
const mainStyle = computed(() => ({ '--wr-log-h': logOpen.value ? '242px' : '58px' }));
const statusDrawerOpen = ref(false);
/** 進出方向篩選(WD-2;狀態在 useWarroom,記在 localStorage) */
const DIRECTION_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: '↘ 連入', value: 'in' },
  { label: '↗ 連出', value: 'out' },
];
/** 即時排行抽屜:開啟時才輪詢(useLiveTop) */
const rankingOpen = ref(false);
const rk = useLiveTop({ active: rankingOpen, mock: w.mock });
// 快照還沒載入時不判斷來源(避免誤報「沒有 log 來源」)
const rkSource = computed(() => (w.snapshot.value ? logSource(w.snapshot.value.collector) : { live: true, empty: '', stale: '' }));
const canvasCenterX = ref<number | null>(null);

const colView = computed(() => collectorView(w.snapshot.value?.collector));
const isLive = computed(() => w.connected.value && !w.stale.value && !w.partial.value && colView.value.live);
const liveBadgeText = computed(() => {
  if (w.mock) return 'MOCK';
  if (!w.connected.value) return 'OFFLINE';
  if (w.stale.value) return 'STALE';
  if (w.partial.value || !colView.value.live) return 'DEGRADED';
  return 'LIVE';
});

const kpiBps = computed(() => {
  const bps = w.snapshot.value?.metrics?.throughput?.bps;
  return bps != null ? fmtBps(bps) : '—';
});
const kpiSess = computed(() => {
  const act = w.snapshot.value?.metrics?.session?.active;
  return act != null ? fmtNum(act) : '—';
});
const kpiCps = computed(() => {
  const cps = w.snapshot.value?.metrics?.throughput?.cps;
  if (cps != null) return fmtNum(cps);
  return w.data.value && !w.data.value.partial ? fmtNum(Math.round(w.rates.value.conn)) : '—';
});
const kpiDeny = computed(() => {
  const d = w.kpis.value?.denyPerMin;
  return d != null ? fmtNum(d) : '—';
});
const kpiThreat = computed(() => {
  const t = w.kpis.value?.threat5m;
  return t != null ? fmtNum(t) : '—';
});
const kpiCpu = computed(() => {
  const dp = w.snapshot.value?.metrics?.cpu?.dataplane;
  return dp != null ? `${Math.round(dp)}%` : '—';
});
</script>

<template>
  <div class="wr-stage">
    <Teleport to="#page-actions" defer>
      <GBadge :tone="isLive ? 'success' : w.stale.value || w.partial.value ? 'warning' : 'neutral'" dot>
        {{ isLive ? '戰情室連線中' : colView.title }}
      </GBadge>
      <GButton size="sm" variant="secondary" icon="radio" @click="statusDrawerOpen = true">
        系統狀態
      </GButton>
      <GButton size="sm" variant="secondary" icon="trending-up" @click="rankingOpen = true">
        即時排行
      </GButton>
      <RouterLink to="/firewall/search">
        <GButton size="sm" variant="ghost" icon="search">Log 明細查詢</GButton>
      </RouterLink>
    </Teleport>

    <!-- 頂部戰情室標題與 6 個即時 KPI(對照樣稿 header) -->
    <header class="wr-header">
      <h1>NETOPS ▸ PA-560 戰情室</h1>
      <span class="live" :class="{ 'is-warn': !isLive }">{{ liveBadgeText }}</span>

      <button
        type="button"
        class="wr-sys-btn"
        title="開啟收集器與系統狀態抽屜"
        @click="statusDrawerOpen = true"
      >
        ⚙ 系統狀態
      </button>

      <GSegmented v-model="w.direction.value" class="wr-dir" size="sm" :options="DIRECTION_OPTIONS" aria-label="進出方向篩選" />

      <div class="kpis">
        <div class="kpi">
          <b id="kBps">{{ kpiBps }}</b>
          <span>吞吐量</span>
        </div>
        <div class="kpi">
          <b id="kSess">{{ kpiSess }}</b>
          <span>連線數</span>
        </div>
        <div class="kpi">
          <b id="kCps">{{ kpiCps }}</b>
          <span>新連線/秒</span>
        </div>
        <div class="kpi">
          <b id="kDeny" class="is-bad">{{ kpiDeny }}</b>
          <span>阻擋/分</span>
        </div>
        <div class="kpi">
          <b id="kThr" class="is-warn">{{ kpiThreat }}</b>
          <span>威脅/5分</span>
        </div>
        <div class="kpi">
          <b id="kCpu">{{ kpiCpu }}</b>
          <span>DP CPU</span>
        </div>
      </div>
    </header>

    <!-- 提示橫幅(notices[] 全部顯示 + DB-IP 授權連結) -->
    <Notices
      :notices="w.notices.value"
      :geo-attribution="w.geoAttribution.value"
      :stale="w.stale.value"
      :warroom-error="w.warroomError.value"
      :risk-error="w.riskError.value"
      :stream-error="w.streamError.value"
    />

    <!-- TS-4:近 30 天新增威脅特徵碼命中提示列(有命中時顯示,點選開特徵碼說明抽屜) -->
    <NewSignatureHitsBar
      :hits="w.newSignatureHits.value"
      :can-open-signature-page="w.canOpenSignaturePage.value"
      :sig-linkable="sigDrawer.linkable"
      @open-signature="openSignature"
    />

    <!-- 主視覺區 -->
    <div class="wr-main" :style="mainStyle">
      <WarroomCanvas
        :sources="w.nodes.value.sources"
        :segments="w.nodes.value.segments"
        :links="w.links.value"
        :rates="w.rates.value"
        :kpis="w.kpis.value"
        :snapshot="w.snapshot.value"
        :gauge="w.gauge.value"
        :focus="w.focus.value"
        :direction="w.direction.value"
        :legend-open="legendOpen"
        :feed-open="feedOpen"
        :top-reserve="aiReserve"
        :bottom-reserve="riskReserve"
        @toggle-focus="w.toggleFocus"
        @center-change="canvasCenterX = $event"
      />

      <LegendPanel v-model="legendOpen" :geo-attribution="w.geoAttribution.value" />

      <EventFeed
        v-model:open="feedOpen"
        :events="w.events.value"
        :sources="w.nodes.value.sources"
        :segments="w.nodes.value.segments"
        :sig-linkable="sigDrawer.linkable"
        @open-signature="openSignature"
      />

      <AiPanel
        ref="aiRef"
        :text="a.text.value"
        :insight="a.insight.value"
        :running="a.busy.value"
        :failed="a.failed.value"
        :fail-reason="a.failReason.value"
        :enabled="a.enabled.value"
        :run-error="a.runError.value"
        :load-error="a.loadError.value"
        :allowed="a.allowed.value"
        :can-run="a.canRun.value"
        :cooldown-sec="a.cooldownSec.value"
        :center-x="canvasCenterX"
        @run="a.run()"
      />

      <RiskPanel
        ref="riskRef"
        v-model:open="riskOpen"
        :risk="w.risk.value"
        :error="w.riskError.value"
        :center-x="canvasCenterX"
        :sig-linkable="sigDrawer.linkable"
        @open-signature="openSignature"
      />

      <TrafficLogTable
        v-model:open="logOpen"
        v-model:filter="w.filter.value"
        v-model:paused="w.paused.value"
        :logs="w.logs.value"
        :focus="w.focus.value"
        :sources="w.nodes.value.sources"
        :segments="w.nodes.value.segments"
        :sig-linkable="sigDrawer.linkable"
        @clear-focus="w.toggleFocus(null)"
        @open-signature="openSignature"
      />
    </div>

    <!-- 即時排行收摺抽屜(需求方 2026-11-17 加回舊頁排行卡) -->
    <RankingDrawer
      v-model="rankingOpen"
      v-model:type="rk.type.value"
      v-model:minutes="rk.minutes.value"
      :top="rk.top.value"
      :lists="rk.lists.value"
      :kpis="rk.kpis.value"
      :error="rk.error.value"
      :loading="rk.loading.value"
      :source="rkSource"
      :sig-linkable="sigDrawer.linkable"
      @open-signature="openSignature"
    />

    <!-- 系統狀態收摺抽屜(原 Live.vue 收集器狀態、測試區暫停開關、PA 精準查詢) -->
    <SystemStatusDrawer
      v-model="statusDrawerOpen"
      :snapshot="w.snapshot.value"
      :connected="w.connected.value"
      :stream-error="w.streamError.value"
      :can-manage="w.canManage.value"
      :set-control="w.setControl"
    />

    <!-- TS-4:跨頁威脅特徵碼說明抽屜 -->
    <SignatureDrawer :drawer="sigDrawer" />
  </div>
</template>

<style scoped>
.wr-stage {
  --bg: #060b14;
  --panel: #0c1424cc;
  --line: #1c2a44;
  --txt: #cfe3ff;
  --dim: #6f86a8;
  --ok: #22d3a6;
  --warn: #f5b03a;
  --bad: #ff4d5e;
  --acc: #3ea8ff;

  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: calc(100vh - 150px);
  min-height: 820px;
  background: var(--bg);
  color: var(--txt);
  font-family: 'Segoe UI', 'Microsoft JhengHei', sans-serif;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
.wr-header {
  height: 52px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 20px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(#0b1528, #060b14);
  z-index: 10;
}
.wr-header h1 {
  font-size: 17px;
  margin: 0;
  letter-spacing: 2px;
  color: var(--txt);
  white-space: nowrap;
}
.wr-header .live {
  color: var(--ok);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.wr-header .live.is-warn {
  color: var(--warn);
}
.wr-header .live::before {
  content: '●';
  margin-right: 4px;
  animation: wr-live-blink 1s infinite;
}
@keyframes wr-live-blink {
  50% {
    opacity: 0.2;
  }
}
.wr-sys-btn {
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(20, 34, 58, 0.75);
  color: var(--txt);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.2s;
}
.wr-dir {
  flex: none;
}
.wr-sys-btn:hover {
  border-color: var(--acc);
}
.kpis {
  display: flex;
  gap: 18px;
  margin-left: auto;
  overflow-x: auto;
}
.kpi {
  text-align: right;
  white-space: nowrap;
}
.kpi b {
  display: block;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.kpi b.is-bad {
  color: var(--bad);
}
.kpi b.is-warn {
  color: var(--warn);
}
.kpi span {
  font-size: 11px;
  color: var(--dim);
}
.wr-main {
  /* 窄版面:AI / 高風險框依主視覺區寬度改排到右欄(見 AiPanel、RiskPanel、EventFeed 的 @container) */
  container: wrmain / inline-size;
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.wr-main :deep(.wr-canvas-wrap) {
  top: 0;
}
.wr-main :deep(.wr-legend),
.wr-main :deep(.wr-feed) {
  top: 12px;
}
.wr-main :deep(.wr-ai) {
  top: 12px;
}
</style>
