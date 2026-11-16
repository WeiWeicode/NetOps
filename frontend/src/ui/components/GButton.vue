<script setup lang="ts">
/**
 * 按鈕:variant primary(漸層光暈)/ secondary(玻璃)/ ghost / danger;
 * 權限按鈕請加 v-can="'權限代碼'",沒有權限時整顆隱藏(後端仍會檢查)。
 */
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg';
    icon?: string;
    iconRight?: string;
    loading?: boolean;
    disabled?: boolean;
    block?: boolean;
    type?: 'button' | 'submit';
    square?: boolean;
  }>(),
  { variant: 'secondary', size: 'md', type: 'button' },
);
</script>

<template>
  <button
    :type="type"
    class="g-btn"
    :class="[`v-${variant}`, `s-${size}`, { block, square, loading }]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="spin" />
    <GIcon v-else-if="icon" :name="icon" :size="size === 'sm' ? 15 : 17" />
    <span v-if="$slots.default" class="label"><slot /></span>
    <GIcon v-if="iconRight && !loading" :name="iconRight" :size="size === 'sm' ? 15 : 17" />
  </button>
</template>

<style scoped>
.g-btn {
  --h: 38px;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: var(--h);
  padding: 0 16px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font: inherit;
  font-weight: 600;
  font-size: var(--fs-md);
  letter-spacing: 0.01em;
  cursor: pointer;
  white-space: nowrap;
  color: var(--text);
  transition:
    transform var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease),
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    opacity var(--dur);
}
.g-btn:active:not(:disabled) {
  transform: translateY(1px) scale(0.99);
}
.g-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.s-sm {
  --h: 30px;
  padding: 0 11px;
  font-size: var(--fs-sm);
  border-radius: var(--radius-xs);
  gap: 6px;
}
.s-lg {
  --h: 46px;
  padding: 0 22px;
  font-size: var(--fs-lg);
  border-radius: var(--radius-md);
}
.square {
  width: var(--h);
  padding: 0;
}
.block {
  width: 100%;
}

.v-primary {
  color: var(--on-primary);
  background: var(--grad-primary);
  background-size: 160% 160%;
  background-position: 0% 50%;
  box-shadow:
    var(--shadow-glow),
    inset 0 1px 0 rgb(255 255 255 / 0.25);
}
.v-primary:hover:not(:disabled) {
  background-position: 100% 50%;
  box-shadow:
    var(--shadow-glow-strong),
    inset 0 1px 0 rgb(255 255 255 / 0.3);
}

.v-secondary {
  background: var(--glass-strong);
  border-color: var(--glass-border-2);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--shadow-sm);
}
.v-secondary:hover:not(:disabled) {
  background: var(--glass-hover);
  border-color: var(--field-focus);
}

.v-ghost {
  background: transparent;
  color: var(--text-2);
}
.v-ghost:hover:not(:disabled) {
  background: var(--glass-soft);
  color: var(--text);
}

.v-danger {
  color: #fff;
  background: var(--grad-danger);
  box-shadow: var(--shadow-danger);
}
.v-danger:hover:not(:disabled) {
  filter: brightness(1.06);
}

.spin {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
