<script setup lang="ts">
/**
 * 資料來源徽章:
 *   - 時段明細(V-b2):hot「⚡ 即時熱資料」、cold「🧊 歷史冷歸檔」、mixed 兩個都顯示
 *   - AD 事件(AD-3):agent「⚡ 即時」、ftp「FTP 補寫」
 *   色用 --badge-hot、--badge-cold,文字對比 ≥ 4.5:1。
 */
import { computed } from 'vue';
import type { SliceSource } from '@/api/slice';

export type SourceBadgeKind = SliceSource | 'agent' | 'ftp';

const props = defineProps<{ source: SourceBadgeKind }>();

const ariaLabel = computed(() => {
  switch (props.source) {
    case 'hot':
      return '即時熱資料';
    case 'cold':
      return '歷史冷歸檔';
    case 'mixed':
      return '即時熱資料與歷史冷歸檔混合';
    case 'agent':
      return '即時';
    case 'ftp':
      return 'FTP 補寫';
  }
});
</script>

<template>
  <span class="g-source" role="status" :aria-label="ariaLabel">
    <template v-if="source === 'agent'">
      <span class="g-source__b is-hot">⚡ 即時</span>
    </template>
    <template v-else-if="source === 'ftp'">
      <span class="g-source__b is-cold">FTP 補寫</span>
    </template>
    <template v-else>
      <span v-if="source !== 'cold'" class="g-source__b is-hot">⚡ 即時熱資料</span>
      <span v-if="source !== 'hot'" class="g-source__b is-cold">🧊 歷史冷歸檔</span>
    </template>
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
