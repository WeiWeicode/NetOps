<script setup lang="ts">
/**
 * IP + 名稱(IMPL-PLAN AC3):名稱由應用注入的查詢函式提供(ui/ipLabel.ts);查不到時只顯示 IP。
 * 名稱是補充資訊:IP 一律保留(複製、比對用);窄螢幕時名稱換到下一行並截斷,完整內容在 title 與報讀文字。
 */
import { computed, inject } from 'vue';
import { IP_LABEL_KEY } from '../ipLabel';

const props = withDefaults(defineProps<{ ip: string | null | undefined; inline?: boolean }>(), { inline: false });
const resolve = inject(IP_LABEL_KEY, () => undefined);
const label = computed(() => (props.ip ? resolve(props.ip) : undefined));
</script>

<template>
  <span v-if="!ip">—</span>
  <span v-else-if="!label" class="mono">{{ ip }}</span>
  <span v-else class="g-ip" :class="{ inline }" :title="`${ip}:${label.title}`">
    <span class="mono">{{ ip }}</span>
    <span class="name">
      <span aria-hidden="true">{{ label.text }}</span>
      <span class="sr-only">({{ label.title }})</span>
    </span>
  </span>
</template>

<style scoped>
.g-ip {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
  max-width: 100%;
  min-width: 0;
}
.name {
  display: inline-block;
  max-width: 14em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--grad-brand-soft);
  color: var(--c-primary-text);
  font-size: var(--fs-sm);
  font-family: var(--font-sans);
  line-height: 1.6;
}
.g-ip:not(.inline) .name {
  max-width: 10em;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 760px) {
  .name {
    max-width: 9em;
  }
}
</style>
