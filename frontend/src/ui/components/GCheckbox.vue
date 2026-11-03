<script setup lang="ts">
/** 核取方塊:矩陣編輯用;readonly 時只顯示狀態 */
defineProps<{ label?: string; disabled?: boolean; ariaLabel?: string; tone?: string }>();
const model = defineModel<boolean>({ default: false });
</script>

<template>
  <label class="g-check" :class="[`tone-${tone ?? 'primary'}`, { on: model, disabled }]">
    <input v-model="model" type="checkbox" :disabled="disabled" :aria-label="ariaLabel ?? label" />
    <span class="box"><GIcon v-if="model" name="check" :size="13" :stroke="3" /></span>
    <span v-if="label" class="text">{{ label }}</span>
  </label>
</template>

<style scoped>
.g-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}
input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.box {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  color: #fff;
  background: var(--field);
  border: 1.5px solid var(--field-border);
  transition: all var(--dur) var(--ease);
}
.on .box {
  background: var(--tone);
  border-color: var(--tone);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--tone) 40%, transparent);
}
.g-check:hover:not(.disabled) .box {
  border-color: var(--tone);
}
input:focus-visible + .box {
  outline: 2px solid var(--field-focus);
  outline-offset: 2px;
}
.disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
