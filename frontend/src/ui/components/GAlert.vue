<script setup lang="ts">
/** 區塊提示:tone 決定顏色與預設圖示;錯誤訊息用 tone="danger"(內容含 requestId 時一併顯示) */
import { computed } from 'vue';

const props = withDefaults(defineProps<{ tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral'; icon?: string; title?: string }>(), { tone: 'info' });
const ICON: Record<string, string> = { info: 'info', success: 'check-circle', warning: 'alert', danger: 'alert-circle', neutral: 'info' };
const iconName = computed(() => props.icon ?? ICON[props.tone]!);
</script>

<template>
  <div class="g-alert" :class="`tone-${tone}`" :role="tone === 'danger' ? 'alert' : 'status'">
    <GIcon :name="iconName" :size="17" class="ic" />
    <div class="body">
      <strong v-if="title" class="title">{{ title }}</strong>
      <div class="text"><slot /></div>
    </div>
  </div>
</template>

<style scoped>
.g-alert {
  display: flex;
  gap: 10px;
  padding: 11px 14px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text);
  background: color-mix(in srgb, var(--tone) calc(var(--tone-bg-alpha) * 100%), transparent);
  border: 1px solid color-mix(in srgb, var(--tone) 30%, transparent);
}
.ic {
  margin-top: 1px;
  color: color-mix(in srgb, var(--tone) 70%, var(--text));
}
.body {
  min-width: 0;
}
.title {
  display: block;
  margin-bottom: 2px;
}
.text :deep(a) {
  font-weight: 600;
}
.text :deep(ul) {
  margin: 4px 0 0;
  padding-left: 18px;
}
</style>
