<script setup lang="ts">
/** 單一比例環(0–100):中央顯示百分比 */
import { computed } from 'vue';
import { toneColor, uid } from './palette';

const props = withDefaults(defineProps<{ value: number; size?: number; tone?: string; label?: string }>(), { size: 72, tone: 'primary' });
const R = 40;
const C = 2 * Math.PI * R;
const id = uid('ring');
const len = computed(() => (Math.max(0, Math.min(100, props.value)) / 100) * C);
</script>

<template>
  <svg class="g-ring" :width="size" :height="size" viewBox="0 0 100 100" role="img" :aria-label="`${label ?? ''} ${Math.round(value)}%`">
    <defs>
      <linearGradient :id="id" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" :stop-color="toneColor(tone)" />
        <stop offset="1" stop-color="var(--brand-2)" />
      </linearGradient>
    </defs>
    <circle cx="50" cy="50" :r="R" class="bg" />
    <circle cx="50" cy="50" :r="R" class="fg" :stroke="`url(#${id})`" :stroke-dasharray="`${len} ${C}`" />
    <text x="50" y="56" text-anchor="middle">{{ Math.round(value) }}%</text>
  </svg>
</template>

<style scoped>
.g-ring {
  flex: none;
}
.bg {
  fill: none;
  stroke: var(--line);
  stroke-width: 9;
}
.fg {
  fill: none;
  stroke-width: 9;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: 50% 50%;
  transition: stroke-dasharray 800ms var(--ease);
}
text {
  font-size: 19px;
  font-weight: 750;
  fill: var(--text);
}
</style>
