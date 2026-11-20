<script lang="ts">
export const RISK_OPEN_KEY = 'wr-risk';
export function readRiskOpen(): boolean {
  try {
    return localStorage.getItem(RISK_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}
</script>

<script setup lang="ts">
/**
 * 戰情室下方近一小時高風險統計(WR-5;WARROOM-GEMINI-HANDOFF §2、§3):
 *   - 總覽 4 數字:威脅事件(threats)、阻擋次數(denies)、攻擊來源 IP(attackSources,attackSourcesLowerBound 為 true 時加「≥」)、Critical(critical)
 *   - partial 時數字為 null,顯示「—」
 *   - Top 威脅類型長條(依 severity 著色)
 *   - Top 攻擊來源長條(依 denyRatio 著色,支援 IP 對照表名稱提示)
 *   - 可收摺(v-model:open,localStorage 'wr-risk');收摺只留標題列,Canvas 依框的實際高度把核心放回
 */
import { computed } from 'vue';
import { fmtNum } from '@/api/format';
import { describeError } from '@/api/gateway';
import type { WarroomRisk } from '@/api/warroom';
import { ipLabel } from '@/composables/ipNames';

const props = withDefaults(
  defineProps<{
    risk: WarroomRisk | null;
    error?: Error | null;
    centerX?: number | null;
    open?: boolean;
    /** TS-4:威脅名稱是否可點開特徵碼說明抽屜 */
    sigLinkable?: (nameOrId: string) => boolean;
  }>(),
  { error: null, centerX: null, open: true },
);

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'open-signature', name: string): void;
}>();

function toggleOpen() {
  const next = !props.open;
  try {
    localStorage.setItem(RISK_OPEN_KEY, next ? '1' : '0');
  } catch {
    /* 無法寫入 localStorage 時僅影響重整後記憶 */
  }
  emit('update:open', next);
}

const styleObj = computed(() => (props.centerX ? { left: `${props.centerX}px` } : undefined));

const fmtVal = (v: number | null | undefined, prefix = ''): string => {
  if (v == null) return '—';
  return `${prefix}${fmtNum(v)}`;
};

const threatsText = computed(() => fmtVal(props.risk?.threats));
const deniesText = computed(() => fmtVal(props.risk?.denies));
const sourcesText = computed(() =>
  fmtVal(props.risk?.attackSources, props.risk?.attackSources != null && props.risk?.attackSourcesLowerBound ? '≥' : ''),
);
const criticalText = computed(() => fmtVal(props.risk?.critical));

function sevColor(sev: string | null | undefined): string {
  switch ((sev ?? '').toLowerCase()) {
    case 'critical':
      return '#ff4d5e';
    case 'high':
      return '#f5b03a';
    case 'medium':
      return '#a078ff';
    default:
      return '#3ea8ff';
  }
}

function ratioColor(ratio: number | null | undefined): string {
  if (ratio == null) return '#f5b03a';
  return ratio > 0.6 ? '#ff4d5e' : ratio > 0.25 ? '#f5b03a' : '#22d3a6';
}

const topThreats = computed(() => {
  const list = props.risk?.topThreats ?? [];
  const max = Math.max(1, ...list.map((t) => t.count));
  return list.slice(0, 5).map((t) => ({
    label: t.name,
    count: t.count,
    pct: Math.min(100, Math.round((t.count / max) * 100)),
    color: sevColor(t.severity),
  }));
});

const topSources = computed(() => {
  const list = props.risk?.topSources ?? [];
  const max = Math.max(1, ...list.map((s) => s.count));
  return list.slice(0, 5).map((s) => {
    const ipName = ipLabel(s.key);
    const display = ipName ? `${s.key} (${ipName.text})` : s.country ? `${s.key} (${s.country})` : s.key || s.label;
    const titleParts = [s.key, s.label, ipName?.title, s.denyRatio != null ? `阻擋 ${Math.round(s.denyRatio * 100)}%` : ''].filter(Boolean);
    return {
      key: s.key,
      label: display,
      title: titleParts.join(' · '),
      count: s.count,
      pct: Math.min(100, Math.round((s.count / max) * 100)),
      color: ratioColor(s.denyRatio),
    };
  });
});
</script>

<template>
  <section id="risk" class="wr-ov wr-risk" :style="styleObj" aria-label="近一小時高風險統計">
    <h3 class="wr-risk__hd">
      <button
        type="button"
        class="wr-risk__toggle"
        :aria-expanded="open"
        :title="open ? '收摺高風險統計' : '展開高風險統計'"
        aria-label="收摺或展開高風險統計"
        @click="toggleOpen"
      >
        {{ open ? '▾' : '▸' }}
      </button>
      <span>⚠ 近一小時高風險統計</span>
      <span class="meta">
        <template v-if="risk?.partial">資料不完整 · </template>每分鐘更新
      </span>
    </h3>

    <template v-if="open">
    <div v-if="error && !risk" class="wr-risk__err" role="alert">
      無法取得高風險統計：{{ describeError(error) }}
    </div>

    <div class="grid">
      <div class="col">
        <h4>總覽</h4>
        <div class="big">
          <div>
            <b id="rThreat" class="is-warn">{{ threatsText }}</b>
            <span>威脅事件</span>
          </div>
          <div>
            <b id="rDeny" class="is-bad">{{ deniesText }}</b>
            <span>阻擋次數</span>
          </div>
        </div>
        <div class="big wr-risk__big2">
          <div>
            <b id="rSrc">{{ sourcesText }}</b>
            <span>攻擊來源 IP</span>
          </div>
          <div>
            <b id="rCrit" class="is-bad">{{ criticalText }}</b>
            <span>Critical</span>
          </div>
        </div>
      </div>

      <div class="col">
        <h4>Top 威脅類型</h4>
        <div id="rTypes">
          <template v-if="topThreats.length">
            <div v-for="t in topThreats" :key="t.label" class="rb">
              <button
                v-if="sigLinkable?.(t.label)"
                type="button"
                class="l wr-risk__sig-btn"
                :title="`${t.label}（檢視威脅特徵碼說明）`"
                @click="emit('open-signature', t.label)"
              >
                {{ t.label }}
              </button>
              <span v-else class="l" :title="t.label">{{ t.label }}</span>
              <span class="b"><i :style="{ width: `${t.pct}%`, background: t.color }" /></span>
              <span class="v">{{ fmtNum(t.count) }}</span>
            </div>
          </template>
          <div v-else class="wr-risk__empty">無威脅紀錄</div>
        </div>
      </div>

      <div class="col">
        <h4>Top 攻擊來源</h4>
        <div id="rTop">
          <template v-if="topSources.length">
            <div v-for="s in topSources" :key="s.key" class="rb">
              <span class="l" :title="s.title">{{ s.label }}</span>
              <span class="b"><i :style="{ width: `${s.pct}%`, background: s.color }" /></span>
              <span class="v">{{ fmtNum(s.count) }}</span>
            </div>
          </template>
          <div v-else class="wr-risk__empty">無高風險來源</div>
        </div>
      </div>
    </div>
    </template>
  </section>
</template>

<style scoped>
.wr-ov {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  width: min(560px, calc(100% - 540px));
  min-width: 300px;
  background: rgba(10, 18, 34, 0.93);
  border: 1px solid #23406b;
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 12px;
  color: #cfe3ff;
  /* 不用 backdrop-filter:疊在動畫 Canvas 上每幀都要重算模糊 */
  box-shadow: 0 0 24px rgba(62, 168, 255, 0.15);
  z-index: 6;
}
.wr-risk {
  bottom: calc(var(--wr-log-h, 242px) + 14px);
}
.wr-risk__hd {
  margin: 0;
  font-size: 12px;
  letter-spacing: 1px;
  color: #8fc3ff;
  display: flex;
  align-items: center;
  gap: 8px;
}
.wr-risk__toggle {
  border: 1px solid #1c2a44;
  border-radius: 6px;
  background: transparent;
  color: #6f86a8;
  font: inherit;
  line-height: 16px;
  padding: 0 6px;
  cursor: pointer;
}
.wr-risk__toggle:hover {
  border-color: #3ea8ff;
  color: #cfe3ff;
}
.meta {
  margin-left: auto;
  color: #6f86a8;
  font-weight: normal;
  font-size: 11px;
}
.wr-risk__err {
  color: #ff4d5e;
  margin-top: 6px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
  margin-top: 8px;
}
.col {
  min-width: 0;
}
.col h4 {
  margin: 0 0 4px;
  font-size: 11px;
  color: #6f86a8;
  font-weight: normal;
}
.rb {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 3px 0;
}
.rb .l {
  width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wr-risk__sig-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: #8fc3ff;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.wr-risk__sig-btn:hover {
  color: #cfe3ff;
  text-decoration: underline;
}
.rb .b {
  flex: 1;
  height: 6px;
  background: #14223a;
  border-radius: 3px;
  overflow: hidden;
}
.rb .b i {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 0.6s ease;
}
.rb .v {
  width: 38px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.big {
  display: flex;
  gap: 12px;
  margin-top: 2px;
}
.wr-risk__big2 {
  margin-top: 6px;
}
.big div {
  flex: 1;
  min-width: 0;
}
.big b {
  font-size: 17px;
  display: block;
  font-variant-numeric: tabular-nums;
}
.big b.is-warn {
  color: #f5b03a;
}
.big b.is-bad {
  color: #ff4d5e;
}
.big span {
  color: #6f86a8;
  font-size: 10px;
}
.wr-risk__empty {
  color: #6f86a8;
  font-size: 11px;
  padding: 6px 0;
}
@media (max-width: 1100px) {
  .wr-ov {
    width: min(520px, calc(100% - 280px));
  }
}
/* 窄版面:置中會蓋住核心,改排到右欄下方 */
@container wrmain (max-width: 1400px) {
  .wr-ov {
    left: auto !important;
    right: 12px;
    transform: none;
    width: 270px;
    min-width: 0;
    max-height: calc(50% - 150px);
    overflow: auto;
  }
}
</style>
