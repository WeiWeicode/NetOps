<script setup lang="ts">
/**
 * 防火牆 › 即時監控戰情室(WR-5;docs/WARROOM-PLAN.md §2、docs/WARROOM-GEMINI-HANDOFF.md §2、§3):
 *   - 取代現有 /firewall/live 頁面;資料與狀態一律由 useWarroom() 與 useWarroomAi() 提供，不自行 fetch、不自寫權限判斷
 *   - 版面(對照樣稿 warroom-v5.html):頂部 KPI、提示橫幅(Notices)、左說明(LegendPanel,可收摺)、中央 Canvas(WarroomCanvas)、
 *     右即時事件(EventFeed)、上 AI 分析框(AiPanel)、下近一小時高風險統計(RiskPanel)、底部 Log 表(TrafficLogTable)
 *   - 收集器狀態與測試區暫停開關移至收摺的「系統狀態」抽屜(SystemStatusDrawer)
 */
import { computed, ref } from 'vue';
import { fmtNum } from '@/api/format';
import { collectorView, fmtBps } from '@/composables/paLive';
import { useWarroom } from '@/composables/useWarroom';
import { useWarroomAi } from '@/composables/useWarroomAi';
import AiPanel from '@/components/warroom/AiPanel.vue';
import EventFeed from '@/components/warroom/EventFeed.vue';
import LegendPanel, { readLegendOpen } from '@/components/warroom/LegendPanel.vue';
import Notices from '@/components/warroom/Notices.vue';
import RiskPanel from '@/components/warroom/RiskPanel.vue';
import SystemStatusDrawer from '@/components/warroom/SystemStatusDrawer.vue';
import TrafficLogTable from '@/components/warroom/TrafficLogTable.vue';
import WarroomCanvas from '@/components/warroom/WarroomCanvas.vue';

const w = useWarroom();
const a = useWarroomAi();

const legendOpen = ref(readLegendOpen());
const statusDrawerOpen = ref(false);
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

    <!-- 主視覺區 -->
    <div class="wr-main">
      <WarroomCanvas
        :sources="w.nodes.value.sources"
        :segments="w.nodes.value.segments"
        :links="w.links.value"
        :rates="w.rates.value"
        :kpis="w.kpis.value"
        :snapshot="w.snapshot.value"
        :gauge="w.gauge.value"
        :focus="w.focus.value"
        :legend-open="legendOpen"
        @toggle-focus="w.toggleFocus"
        @center-change="canvasCenterX = $event"
      />

      <LegendPanel v-model="legendOpen" :geo-attribution="w.geoAttribution.value" />

      <EventFeed
        :events="w.events.value"
        :sources="w.nodes.value.sources"
        :segments="w.nodes.value.segments"
      />

      <AiPanel
        :text="a.text.value"
        :insight="a.insight.value"
        :running="a.running.value"
        :failed="a.failed.value"
        :run-error="a.runError.value"
        :load-error="a.loadError.value"
        :allowed="a.allowed.value"
        :can-run="a.canRun.value"
        :cooldown-sec="a.cooldownSec.value"
        :center-x="canvasCenterX"
        @run="a.run()"
      />

      <RiskPanel
        :risk="w.risk.value"
        :error="w.riskError.value"
        :center-x="canvasCenterX"
      />

      <TrafficLogTable
        v-model:filter="w.filter.value"
        v-model:paused="w.paused.value"
        :logs="w.logs.value"
        :focus="w.focus.value"
        :sources="w.nodes.value.sources"
        :segments="w.nodes.value.segments"
        @clear-focus="w.toggleFocus(null)"
      />
    </div>

    <!-- 系統狀態收摺抽屜(原 Live.vue 收集器狀態、測試區暫停開關、PA 精準查詢) -->
    <SystemStatusDrawer
      v-model="statusDrawerOpen"
      :snapshot="w.snapshot.value"
      :connected="w.connected.value"
      :stream-error="w.streamError.value"
      :set-control="w.setControl"
    />
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
