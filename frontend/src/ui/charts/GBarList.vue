<script setup lang="ts">
/** 橫向長條清單(分類比較用,標籤在左、數值在右,長度一目了然) */
import { computed } from 'vue';
import { chartColor } from './palette';

const props = withDefaults(defineProps<{ items: { label: string; value: number; hint?: string; color?: string }[]; unit?: string; colorful?: boolean }>(), {
  unit: '',
});
const max = computed(() => Math.max(1, ...props.items.map((i) => i.value)));
</script>

<template>
  <ul class="g-barlist">
    <li v-for="(it, i) in items" :key="it.label">
      <div class="meta">
        <span class="lbl">{{ it.label }}</span>
        <span v-if="it.hint" class="faint xs">{{ it.hint }}</span>
        <span class="spacer" />
        <span class="val num">{{ it.value.toLocaleString() }}{{ unit }}</span>
      </div>
      <div class="track">
        <span class="bar" :style="{ width: `${(it.value / max) * 100}%`, '--c': it.color ?? (colorful ? chartColor(i) : 'var(--c-primary)') }" />
      </div>
    </li>
  </ul>
</template>

<style scoped>
.g-barlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
  font-size: var(--fs-sm);
}
.lbl {
  font-weight: 600;
}
.val {
  font-weight: 700;
}
.track {
  height: 8px;
  border-radius: 99px;
  background: var(--line);
  overflow: hidden;
}
.bar {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--c) 55%, transparent), var(--c));
  box-shadow: 0 0 12px color-mix(in srgb, var(--c) 45%, transparent);
  transition: width 700ms var(--ease);
}
</style>
