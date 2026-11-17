<script setup lang="ts">
/**
 * 戰情室右欄即時事件(WR-5;WARROOM-GEMINI-HANDOFF §2、§3):
 *   - 顯示最新 30 筆 w.events({ log, kind })，不受底部篩選與暫停影響
 *   - 對照樣稿顯示時間、動作(阻擋/允許/威脅)、來源(或國家)→ 目的(或網段)、威脅名稱
 */
import { fmtClock } from '@/api/format';
import type { LiveLog } from '@/api/paLive';
import type { WarroomSegment, WarroomSource } from '@/api/warroom';
import { sourceIdOf, type LogKind } from '@/composables/useWarroom';

const props = defineProps<{
  events: readonly { log: LiveLog; kind: LogKind }[];
  sources?: readonly WarroomSource[];
  segments?: readonly WarroomSegment[];
}>();

const KIND_LABELS: Record<LogKind, string> = {
  deny: '阻擋',
  allow: '允許',
  threat: '威脅',
};

function srcText(log: LiveLog): string {
  if (props.sources?.length) {
    const id = sourceIdOf(log, props.sources);
    const found = id ? props.sources.find((s) => s.id === id) : undefined;
    if (found) return found.label;
  }
  if (typeof log.src === 'string' && log.src) {
    return typeof log.country === 'string' && log.country ? `${log.src} (${log.country})` : log.src;
  }
  return '未知來源';
}

function dstText(log: LiveLog): string {
  if (typeof log.segment === 'string' && log.segment && props.segments?.length) {
    const seg = props.segments.find((g) => g.id === log.segment);
    if (seg) return seg.label;
  }
  if (typeof log.dst === 'string' && log.dst) return log.dst;
  if (typeof log.segment === 'string' && log.segment) return log.segment;
  return '內部網段';
}
</script>

<template>
  <aside id="feed" class="wr-feed" aria-label="即時事件">
    <h3>即時事件</h3>
    <div id="evs" class="wr-feed__list">
      <template v-if="events.length">
        <div v-for="ev in events" :key="`${ev.log.type}:${ev.log.id}`" class="ev">
          <span class="t">{{ fmtClock(ev.log.receivedAt) }}</span>
          <span class="act" :class="ev.kind">{{ KIND_LABELS[ev.kind] }}</span>
          <br />
          <span class="route">{{ srcText(ev.log) }} → {{ dstText(ev.log) }}</span>
          <template v-if="ev.kind === 'threat' && ev.log.name">
            <br />
            <span class="threat">{{ ev.log.name }}</span>
          </template>
        </div>
      </template>
      <div v-else class="wr-feed__empty">等待即時事件…</div>
    </div>
  </aside>
</template>

<style scoped>
.wr-feed {
  position: absolute;
  top: 64px;
  right: 12px;
  bottom: 252px;
  width: 250px;
  background: rgba(12, 20, 36, 0.82);
  border: 1px solid #1c2a44;
  border-radius: 8px;
  padding: 12px;
  font-size: 12px;
  color: #cfe3ff;
  backdrop-filter: blur(4px);
  display: flex;
  flex-direction: column;
  z-index: 6;
}
.wr-feed h3 {
  margin: 0 0 8px;
  font-size: 12px;
  color: #6f86a8;
  letter-spacing: 1px;
}
.wr-feed__list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
.ev {
  padding: 5px 0;
  border-bottom: 1px dashed #1c2a44;
  animation: wr-ev-in 0.4s ease;
  line-height: 1.45;
}
@keyframes wr-ev-in {
  from {
    opacity: 0;
    transform: translateX(20px);
  }
}
.ev .t {
  color: #6f86a8;
  margin-right: 6px;
  font-variant-numeric: tabular-nums;
}
.ev .act {
  font-weight: 600;
}
.ev .route {
  color: #cfe3ff;
  word-break: break-all;
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
.wr-feed__empty {
  color: #6f86a8;
  padding: 12px 0;
}
</style>
