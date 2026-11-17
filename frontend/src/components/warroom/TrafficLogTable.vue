<script setup lang="ts">
/**
 * 戰情室底部 TRAFFIC LOG 表格(WR-5;WARROOM-GEMINI-HANDOFF §2、§3):
 *   - 篩選:全部(all) / 阻擋(deny) / 允許(allow) / 威脅(threat)
 *   - 暫停 / 繼續切換(w.paused)
 *   - 聚焦節點同步篩選提示與一鍵清除聚焦
 *   - 欄位:時間、動作、來源 IP、國家、目的 IP、區段、Port、App、規則、Bytes、Session(威脅顯示威脅名稱/嚴重度)
 *   - 支援 IP 對照表(GIpLabel)與連到 Log 明細查詢(/firewall/search)
 */
import { computed } from 'vue';
import { fmtClock, fmtNum } from '@/api/format';
import type { LiveLog } from '@/api/paLive';
import type { WarroomSegment, WarroomSource } from '@/api/warroom';
import { classifyLog, type Focus, type LogFilterKind } from '@/composables/useWarroom';
import GIpLabel from '@/ui/components/GIpLabel.vue';

const props = defineProps<{
  logs: readonly LiveLog[];
  filter: LogFilterKind;
  paused: boolean;
  focus: Focus | null;
  sources?: readonly WarroomSource[];
  segments?: readonly WarroomSegment[];
}>();

const emit = defineEmits<{
  (e: 'update:filter', v: LogFilterKind): void;
  (e: 'update:paused', v: boolean): void;
  (e: 'clearFocus'): void;
}>();

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
  <section id="logbar" class="wr-logbar" aria-label="即時流量與威脅紀錄">
    <div class="hd">
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

    <div class="bd">
      <table>
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
            <tr v-for="l in logs" :key="`${l.type}:${l.id}`" class="new">
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
  background: rgba(12, 20, 36, 0.86);
  border: 1px solid #1c2a44;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: #cfe3ff;
  backdrop-filter: blur(4px);
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
table {
  width: 100%;
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
  padding: 4px 10px;
  border-top: 1px solid #111d33;
  white-space: nowrap;
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
