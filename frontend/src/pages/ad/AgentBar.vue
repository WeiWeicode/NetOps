<script setup lang="ts">
/**
 * AD 事件總覽頂部「DC Agent 即時狀態列」(AD-3;docs/AD-AGENT-PLAN.md §6.1):
 *   - 呼叫 GET /api/netops/ad/agents(30 秒輪詢;頁面隱藏時停止,離開頁面時清除)
 *   - 只在 NETOPS_AD_SOURCE === 'clickhouse' 時掛載
 *   - DC 送來的文字(lastError、events[].detail)只用純文字插值,不可使用 v-html
 *   - 424 NETOPS_REDIS_UNAVAILABLE 顯示「DC 狀態暫時無法取得」,不阻擋下方總覽
 */
import { computed, ref, toRef } from 'vue';
import type { AgentStatus, AgentSummary } from '@/api/ad';
import { describeError } from '@/api/gateway';
import { fmtNum, fmtTime } from '@/api/format';
import { AGENT_EVENT_LABELS, AGENT_STATE_META, useAdAgents } from '@/composables/adAgents';

const props = withDefaults(
  defineProps<{
    /** 是否啟用輪詢(父層 clickhouse 模式時為 true) */
    enabled?: boolean;
    /** 來自 GET /ad/days 的 agents 摘要(載入中或 Redis 讀不到前的降級參考) */
    fallbackSummary?: AgentSummary | null;
    /** 輪詢間隔(毫秒;測試可覆寫) */
    pollMs?: number;
  }>(),
  { enabled: true, fallbackSummary: null },
);

const enabledRef = toRef(props, 'enabled');
const { data, loading, error, redisUnavailable, refresh } = useAdAgents(enabledRef, props.pollMs);

const items = computed(() => data.value?.items ?? []);
const summary = computed(() => data.value?.summary ?? props.fallbackSummary ?? null);

/** 已展開看 Watchdog 事件與 Channel 水位的 DC */
const expanded = ref<Record<string, boolean>>({});
function toggleExpand(computer: string) {
  expanded.value = { ...expanded.value, [computer]: !expanded.value[computer] };
}

function stateBadgeLabel(dc: AgentStatus): string {
  const base = AGENT_STATE_META[dc.state]?.label ?? dc.state;
  if (dc.state === 'offline' && dc.updatedAt) return `${base}(最後連線於 ${fmtTime(dc.updatedAt)})`;
  return base;
}

const channelEntries = (dc: AgentStatus) => Object.entries(dc.channels ?? {});
const eventLabel = (type: string) => AGENT_EVENT_LABELS[type] ?? (type || '事件');
const fmtHours = (h: number | null | undefined) => (h == null ? '—' : `${h.toFixed(1)} 小時`);
</script>

<template>
  <GCard padding="sm" title="DC Agent 即時狀態" icon="server">
    <template #actions>
      <div class="bar-actions">
        <template v-if="summary">
          <GBadge tone="neutral">共 {{ fmtNum(summary.total) }} 台</GBadge>
          <GBadge v-if="summary.ok > 0" tone="success" dot>正常 {{ fmtNum(summary.ok) }}</GBadge>
          <GBadge v-if="summary.stale > 0" tone="warning" dot>停止更新 {{ fmtNum(summary.stale) }}</GBadge>
          <GBadge v-if="summary.offline > 0" tone="danger" dot>離線 {{ fmtNum(summary.offline) }}</GBadge>
          <GBadge v-if="summary.unknown > 0" tone="neutral" dot>未知 {{ fmtNum(summary.unknown) }}</GBadge>
          <GBadge v-if="summary.wrapRisk > 0" tone="warning">覆寫風險 {{ fmtNum(summary.wrapRisk) }}</GBadge>
        </template>
        <GButton size="sm" variant="ghost" icon="refresh" :loading="loading" @click="refresh">重新整理</GButton>
      </div>
    </template>

    <GAlert v-if="redisUnavailable" tone="warning" title="DC 狀態暫時無法取得">
      {{ describeError(error) }}
    </GAlert>
    <GAlert v-else-if="error" tone="danger" title="無法取得 DC Agent 狀態">
      {{ describeError(error) }}
    </GAlert>

    <div v-if="loading && !data && !error" class="agent-grid">
      <GSkeleton :lines="2" />
    </div>

    <GEmpty v-else-if="data && !items.length" icon="server" title="尚未有 DC Agent 回報" description="在網域控制站安裝並啟動 NetOpsAdAgent 後,狀態會自動顯示在這裡" />

    <div v-else-if="items.length" class="agent-list">
      <div v-for="dc in items" :key="dc.computer" class="dc-item" :data-dc="dc.computer">
        <div class="dc-head">
          <div class="dc-title">
            <strong class="mono">{{ dc.computer }}</strong>
            <span v-if="dc.dcDomain" class="xs muted">{{ dc.dcDomain }}</span>
            <GBadge :tone="AGENT_STATE_META[dc.state]?.tone ?? 'neutral'" dot>{{ stateBadgeLabel(dc) }}</GBadge>
            <GBadge v-if="dc.channels.Security?.wrapRisk === true" tone="warning" title="Security Log 涵蓋時數不足 24 小時,有覆寫風險">
              Security 覆寫風險
            </GBadge>
          </div>

          <div class="dc-metrics small muted">
            <span>Security 涵蓋 <strong class="text num">{{ fmtHours(dc.channels.Security?.coverageHours) }}</strong></span>
            <span>
              24h 重啟
              <strong class="num" :class="(dc.agent.restarts24h ?? 0) > 0 ? 'c-warning' : 'text'">
                {{ dc.agent.restarts24h == null ? '—' : fmtNum(dc.agent.restarts24h) }}
              </strong>
            </span>
            <span>已收 <strong class="text num">{{ fmtNum(dc.received) }}</strong></span>
            <span v-if="dc.agentVersion" class="xs">v{{ dc.agentVersion }}</span>
            <GButton
              size="sm"
              variant="ghost"
              :icon="expanded[dc.computer] ? 'chevron-down' : 'chevron-right'"
              :aria-expanded="!!expanded[dc.computer]"
              @click="toggleExpand(dc.computer)"
            >
              事件({{ dc.events.length }})
            </GButton>
          </div>
        </div>

        <p v-if="dc.agent.lastError" class="dc-err xs c-danger">最近錯誤:{{ dc.agent.lastError }}</p>

        <div v-if="expanded[dc.computer]" class="dc-detail stack" style="--gap: 10px">
          <div class="dc-meta xs muted">
            <span>服務:{{ dc.agent.serviceState || '—' }}({{ dc.agent.startType || '—' }})</span>
            <span v-if="dc.agent.rssMb != null">記憶體:{{ dc.agent.rssMb.toFixed(1) }} MB</span>
            <span v-if="dc.agent.pendingEvents != null">待送:{{ fmtNum(dc.agent.pendingEvents) }}</span>
            <span v-if="dc.agent.skippedEvents != null && dc.agent.skippedEvents > 0" class="c-warning">略過:{{ fmtNum(dc.agent.skippedEvents) }}</span>
            <span v-if="dc.agent.sendRejectStreak != null && dc.agent.sendRejectStreak > 0" class="c-danger">連續拒收:{{ fmtNum(dc.agent.sendRejectStreak) }}</span>
            <span v-if="dc.updatedAt">最後心跳:{{ fmtTime(dc.updatedAt) }}</span>
          </div>

          <div v-if="channelEntries(dc).length" class="ch-grid">
            <div v-for="[chName, ch] in channelEntries(dc)" :key="chName" class="ch-chip xs">
              <span class="strong">{{ chName }}</span>
              <span class="muted num">RecordID {{ ch.lastRecordId == null ? '—' : fmtNum(ch.lastRecordId) }}</span>
              <span class="muted num">世代 {{ ch.logEpoch == null ? '—' : ch.logEpoch }}</span>
              <span v-if="ch.fileSizeMb != null" class="muted num">
                {{ ch.fileSizeMb.toFixed(1) }}<template v-if="ch.maxSizeMb != null"> / {{ ch.maxSizeMb.toFixed(0) }}</template> MB
              </span>
            </div>
          </div>

          <div class="events-box">
            <p class="xs muted strong events-title">最近 24 小時 Watchdog / Agent 事件</p>
            <p v-if="!dc.events.length" class="xs muted events-empty">沒有異常事件</p>
            <ul v-else class="events-list">
              <li v-for="(ev, idx) in dc.events" :key="`${ev.receivedAt ?? ''}:${ev.type}:${idx}`" class="xs">
                <span class="num muted nowrap">{{ fmtTime(ev.at ?? ev.receivedAt) }}</span>
                <GBadge :tone="ev.type === 'agent_start_failed' ? 'danger' : 'warning'">{{ eventLabel(ev.type) }}</GBadge>
                <span v-if="ev.cause" class="muted">({{ ev.cause }})</span>
                <span class="ev-detail">{{ ev.detail }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </GCard>
</template>

<style scoped>
.bar-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.agent-list {
  display: grid;
  gap: 8px;
}
.dc-item {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--glass-soft);
}
.dc-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px 12px;
}
.dc-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.dc-metrics {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
}
.text {
  color: var(--text);
}
.dc-err {
  margin: 6px 0 0;
  word-break: break-word;
}
.dc-detail {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.dc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}
.ch-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ch-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--glass-strong);
}
.events-title {
  margin: 0 0 4px;
}
.events-empty {
  margin: 0;
}
.events-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.events-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ev-detail {
  color: var(--text);
  word-break: break-word;
}
.strong {
  font-weight: 600;
}
</style>
