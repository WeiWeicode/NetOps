<script setup lang="ts">
/**
 * 時段明細的資料來源徽章(V-b2;HANDOFF-GEMINI-VIZ §4.3、§6):
 *   hot「⚡ 即時熱資料」、cold「🧊 歷史冷歸檔」、mixed 兩個都顯示;
 *   色用 --badge-hot、--badge-cold,文字對比 ≥ 4.5:1。
 */
import type { SliceSource } from '@/api/slice';

defineProps<{ source: SliceSource }>();
</script>

<template>
  <span class="g-source" role="status" :aria-label="source === 'hot' ? '即時熱資料' : source === 'cold' ? '歷史冷歸檔' : '即時熱資料與歷史冷歸檔混合'">
    <span v-if="source !== 'cold'" class="g-source__b is-hot">⚡ 即時熱資料</span>
    <span v-if="source !== 'hot'" class="g-source__b is-cold">🧊 歷史冷歸檔</span>
  </span>
</template>

<style scoped>
.g-source {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.g-source__b {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: var(--fs-xs);
  font-weight: 650;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid transparent;
}
.is-hot {
  color: var(--badge-hot);
  background: color-mix(in srgb, var(--badge-hot) 12%, var(--glass-strong));
  border-color: color-mix(in srgb, var(--badge-hot) 32%, transparent);
}
.is-cold {
  color: var(--badge-cold);
  background: color-mix(in srgb, var(--badge-cold) 12%, var(--glass-strong));
  border-color: color-mix(in srgb, var(--badge-cold) 32%, transparent);
}
</style>
