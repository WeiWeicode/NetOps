<script setup lang="ts">
/**
 * 時段明細的資料來源徽章(V-b1 樸素版;介面見 ui/charts/viz-types.ts GSourceBadgeProps)。顏色與樣式由 Gemini 在 V-b2 調整。
 *   hot「⚡ 即時熱資料」、cold「🧊 歷史冷歸檔」、mixed 兩個都顯示
 */
import type { SliceSource } from '@/api/slice';

defineProps<{ source: SliceSource }>();
</script>

<template>
  <span class="g-source">
    <span v-if="source !== 'cold'" class="g-source__b is-hot">⚡ 即時熱資料</span>
    <span v-if="source !== 'hot'" class="g-source__b is-cold">🧊 歷史冷歸檔</span>
  </span>
</template>

<style scoped>
.g-source {
  display: inline-flex;
  gap: 4px;
}
.g-source__b {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid currentColor;
}
.is-hot {
  color: var(--badge-hot);
}
.is-cold {
  color: var(--badge-cold);
}
</style>
