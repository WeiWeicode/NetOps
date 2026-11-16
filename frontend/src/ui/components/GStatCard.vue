<script setup lang="ts">
/** KPI 卡片:數值、單位、漲跌幅、迷你趨勢圖;invert=true 表示數值下降是好事(例如延遲) */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    value: number | string;
    unit?: string;
    delta?: number;
    trend?: number[];
    tone?: string;
    icon?: string;
    invert?: boolean;
    hint?: string;
    deltaUnit?: string;
  }>(),
  { tone: 'primary', deltaUnit: '%' },
);

const display = computed(() => (typeof props.value === 'number' ? props.value.toLocaleString('zh-TW') : props.value));
const good = computed(() => (props.delta ?? 0) === 0 || (props.delta ?? 0) > 0 !== props.invert);
</script>

<template>
  <GCard class="g-stat" :tone="tone" glow padding="sm">
    <div class="top">
      <span v-if="icon" class="ic"><GIcon :name="icon" :size="17" /></span>
      <span class="label">{{ label }}</span>
    </div>
    <div class="val">
      <span class="num">{{ display }}</span>
      <span v-if="unit" class="unit">{{ unit }}</span>
    </div>
    <div class="bottom">
      <span v-if="delta !== undefined" class="delta" :class="good ? 'good' : 'bad'">
        <GIcon :name="delta >= 0 ? 'trend-up' : 'trend-down'" :size="13" :stroke="2.4" />
        {{ Math.abs(delta) }}{{ deltaUnit }}
      </span>
      <span v-if="hint" class="faint xs">{{ hint }}</span>
    </div>
    <GSparkline v-if="trend?.length" class="spark" :values="trend" :tone="tone" :height="44" />
  </GCard>
</template>

<style scoped>
.top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ic {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) calc(var(--tone-bg-alpha) * 100%), transparent);
}
.label {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-2);
}
.val {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 12px;
}
.num {
  font-size: var(--fs-3xl);
  font-weight: 750;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.unit {
  color: var(--text-3);
  font-weight: 600;
}
.bottom {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
  margin-top: 2px;
}
.delta {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: var(--fs-xs);
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 99px;
}
.good {
  color: var(--c-success);
  background: color-mix(in srgb, var(--c-success) 14%, transparent);
}
.bad {
  color: var(--c-danger);
  background: color-mix(in srgb, var(--c-danger) 14%, transparent);
}
.spark {
  margin: 10px -16px -16px;
}
</style>
