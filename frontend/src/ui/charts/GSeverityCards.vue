<script setup lang="ts">
/**
 * 威脅嚴重度計分卡(V-b2;HANDOFF-GEMINI-VIZ §3.3、§4.2、§5):
 *   - 5 張嚴重度卡片(critical / high / medium / low / info),含與前一期(score.prev)比較
 *   - KPI count-up:初次載入 0→值 800ms easeOutCubic,後續更新舊值→新值 400ms;useReducedMotion().reduced 時直接顯示最終值
 *   - Critical / High(> 0 時)呼吸光暈 2.4s ease-in-out 無限(reduced-motion 時靜態外框)
 *   - 點擊卡片 emit('pick', { chart: 'severity', name: key, value })
 */
import { onBeforeUnmount, reactive, watch } from 'vue';
import { fmtNum } from '@/api/format';
import type { SeverityCounts } from '@/api/heatmap';
import { useReducedMotion } from '@/composables/useReducedMotion';
import type { ChartPick, GSeverityCardsProps } from './viz-types';

const props = defineProps<GSeverityCardsProps>();
const emit = defineEmits<{ (e: 'pick', p: ChartPick): void }>();

const { reduced } = useReducedMotion();

type SevKey = keyof SeverityCounts;

const ITEMS: readonly { key: SevKey; label: string; en: string; tone: string }[] = [
  { key: 'critical', label: '嚴重', en: 'Critical', tone: 'danger' },
  { key: 'high', label: '高風險', en: 'High', tone: 'warning' },
  { key: 'medium', label: '中風險', en: 'Medium', tone: 'info' },
  { key: 'low', label: '低風險', en: 'Low', tone: 'cyan' },
  { key: 'info', label: '資訊', en: 'Info', tone: 'neutral' },
];

const animated = reactive<SeverityCounts>({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

let firstRun = true;
let rafId: number | null = null;

function cancelAnim() {
  if (rafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function animateTo(target: SeverityCounts, durationMs: number) {
  cancelAnim();
  if (reduced.value || typeof requestAnimationFrame !== 'function') {
    for (const { key } of ITEMS) animated[key] = target[key];
    return;
  }
  const from: SeverityCounts = firstRun
    ? { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    : { ...animated };
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const step = (now: number) => {
    const elapsed = Math.max(0, now - start);
    const t = Math.min(1, elapsed / durationMs);
    const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
    for (const { key } of ITEMS) {
      animated[key] = Math.round(from[key] + (target[key] - from[key]) * ease);
    }
    if (t < 1) {
      rafId = requestAnimationFrame(step);
    } else {
      for (const { key } of ITEMS) animated[key] = target[key];
      rafId = null;
    }
  };
  rafId = requestAnimationFrame(step);
}

watch(
  [() => props.score, reduced],
  ([s]) => {
    const dur = firstRun ? 800 : 400;
    animateTo(s, dur);
    firstRun = false;
  },
  { immediate: true, deep: true },
);

onBeforeUnmount(cancelAnim);

function deltaOf(k: SevKey): number | null {
  if (!props.score.prev) return null;
  return props.score[k] - props.score.prev[k];
}

function selectSev(k: SevKey) {
  emit('pick', { chart: 'severity', name: k, value: props.score[k] });
}
</script>

<template>
  <div class="g-sev-cards" role="group" aria-label="各嚴重度威脅計分卡">
    <button
      v-for="it in ITEMS"
      :key="it.key"
      type="button"
      class="g-sev-card glass glass-edge"
      :class="[
        `tone-${it.tone}`,
        `is-${it.key}`,
        {
          'is-glow-critical': it.key === 'critical' && score.critical > 0,
          'is-glow-high': it.key === 'high' && score.high > 0,
        },
      ]"
      :aria-label="`${it.label} (${it.en}) ${score[it.key]} 筆，點擊開啟明細`"
      @click="selectSev(it.key)"
    >
      <div class="g-sev-card__top">
        <span class="g-sev-card__dot" />
        <span class="g-sev-card__lbl">{{ it.label }}</span>
        <span class="g-sev-card__en">{{ it.en }}</span>
      </div>
      <div class="g-sev-card__val num">{{ fmtNum(animated[it.key]) }}</div>
      <div class="g-sev-card__foot">
        <template v-if="deltaOf(it.key) !== null">
          <span
            class="g-sev-card__delta num"
            :class="{
              'is-up': deltaOf(it.key)! > 0,
              'is-down': deltaOf(it.key)! < 0,
              'is-flat': deltaOf(it.key) === 0,
            }"
          >
            {{ deltaOf(it.key)! > 0 ? `+${fmtNum(deltaOf(it.key)!)}` : deltaOf(it.key)! < 0 ? fmtNum(deltaOf(it.key)!) : '持平' }}
          </span>
          <span class="g-sev-card__prev">較前一期 ({{ score.prevFrom.slice(5) }}~{{ score.prevTo.slice(5) }})</span>
        </template>
        <span v-else class="g-sev-card__prev">無完整前一期資料</span>
      </div>
    </button>
  </div>
</template>

<style scoped>
.g-sev-cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 1100px) {
  .g-sev-cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 640px) {
  .g-sev-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 420px) {
  .g-sev-cards {
    grid-template-columns: minmax(0, 1fr);
  }
}

.g-sev-card {
  text-align: left;
  padding: 14px 16px;
  cursor: pointer;
  color: var(--text);
  font: inherit;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition:
    transform var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.g-sev-card:hover {
  transform: translateY(-2px);
  background: var(--glass-hover);
}
/* Critical / High 呼吸光暈:2.4s ease-in-out 無限(§5) */
.g-sev-card.is-glow-critical {
  border-color: color-mix(in srgb, var(--c-danger) 55%, transparent);
  animation: sevGlowCritical 2.4s ease-in-out infinite;
}
.g-sev-card.is-glow-high {
  border-color: color-mix(in srgb, var(--c-warning) 55%, transparent);
  animation: sevGlowHigh 2.4s ease-in-out infinite;
}
@keyframes sevGlowCritical {
  0%,
  100% {
    box-shadow: var(--shadow-sm);
  }
  50% {
    box-shadow: 0 0 22px 2px var(--glow-critical);
  }
}
@keyframes sevGlowHigh {
  0%,
  100% {
    box-shadow: var(--shadow-sm);
  }
  50% {
    box-shadow: 0 0 20px 2px var(--glow-high);
  }
}

.g-sev-card__top {
  display: flex;
  align-items: center;
  gap: 7px;
}
.g-sev-card__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--tone);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 22%, transparent);
}
.g-sev-card__lbl {
  font-size: var(--fs-sm);
  font-weight: 700;
}
.g-sev-card__en {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.g-sev-card__val {
  font-size: var(--fs-2xl);
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.15;
}
.g-sev-card__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 20px;
}
.g-sev-card__delta {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
}
.g-sev-card__delta.is-up {
  color: color-mix(in srgb, var(--c-danger) 70%, var(--text));
  background: color-mix(in srgb, var(--c-danger) 15%, transparent);
}
.g-sev-card__delta.is-down {
  color: color-mix(in srgb, var(--c-success) 70%, var(--text));
  background: color-mix(in srgb, var(--c-success) 15%, transparent);
}
.g-sev-card__delta.is-flat {
  color: var(--text-2);
  background: var(--glass-soft);
}
.g-sev-card__prev {
  font-size: 11px;
  color: var(--text-3);
}

@media (prefers-reduced-motion: reduce) {
  .g-sev-card.is-glow-critical,
  .g-sev-card.is-glow-high {
    animation: none !important;
  }
  .g-sev-card:hover {
    transform: none !important;
  }
}
</style>
