<script setup lang="ts">
/** 標籤:tone 決定顏色;dot 顯示狀態點;variant soft(預設)/ outline / solid */
withDefaults(defineProps<{ tone?: string; dot?: boolean; icon?: string; variant?: 'soft' | 'outline' | 'solid'; mono?: boolean }>(), {
  tone: 'neutral',
  variant: 'soft',
});
</script>

<template>
  <span class="g-badge" :class="[`tone-${tone}`, `v-${variant}`, { mono }]">
    <i v-if="dot" class="dot" />
    <GIcon v-if="icon" :name="icon" :size="12" :stroke="2.2" />
    <slot />
  </span>
</template>

<style scoped>
.g-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  /* 與文字色混合:明亮時加深、黑暗時提亮,小字也能達到 4.5:1 */
  color: color-mix(in srgb, var(--tone) 62%, var(--text));
  border: 1px solid transparent;
}
.v-soft {
  background: color-mix(in srgb, var(--tone) calc(var(--tone-bg-alpha) * 100%), transparent);
  border-color: color-mix(in srgb, var(--tone) 22%, transparent);
}
.v-outline {
  border-color: color-mix(in srgb, var(--tone) 45%, transparent);
}
.v-solid {
  color: var(--text-invert);
  background: var(--tone);
}
.mono {
  font-family: var(--font-mono);
  font-weight: 500;
  letter-spacing: -0.01em;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 22%, transparent);
}
</style>
