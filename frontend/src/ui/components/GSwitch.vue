<script setup lang="ts">
/** 開關:v-model 布林;size sm 用於表格內 */
defineProps<{ label?: string; disabled?: boolean; size?: 'sm' | 'md'; ariaLabel?: string }>();
const model = defineModel<boolean>({ default: false });
</script>

<template>
  <label class="g-switch" :class="[`s-${size ?? 'md'}`, { on: model, disabled }]">
    <input v-model="model" type="checkbox" role="switch" :disabled="disabled" :aria-label="ariaLabel ?? label" />
    <span class="track"><span class="thumb" /></span>
    <span v-if="label" class="text">{{ label }}</span>
  </label>
</template>

<style scoped>
.g-switch {
  --w: 40px;
  --h: 22px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}
.s-sm {
  --w: 32px;
  --h: 18px;
}
input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.track {
  position: relative;
  width: var(--w);
  height: var(--h);
  border-radius: 99px;
  background: var(--line-strong);
  border: 1px solid var(--glass-border-2);
  transition:
    background var(--dur) var(--ease),
    box-shadow var(--dur);
}
.thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: calc(var(--h) - 6px);
  height: calc(var(--h) - 6px);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.25);
  transition: transform var(--dur) var(--ease);
}
.on .track {
  background: var(--grad-brand);
  box-shadow: var(--shadow-glow);
}
.on .thumb {
  transform: translateX(calc(var(--w) - var(--h)));
}
input:focus-visible + .track {
  outline: 2px solid var(--field-focus);
  outline-offset: 2px;
}
.disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.text {
  font-size: var(--fs-md);
}
</style>
