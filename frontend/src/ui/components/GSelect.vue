<script setup lang="ts">
/** 下拉選單(原生 select,支援鍵盤與行動裝置):options 為 { label, value } */
import { useId } from 'vue';

defineProps<{
  label?: string;
  options: { label: string; value: string }[];
  placeholder?: string;
  icon?: string;
  disabled?: boolean;
  error?: string | null;
  required?: boolean;
}>();
const model = defineModel<string>({ default: '' });
const id = useId();
</script>

<template>
  <label class="g-select" :class="{ invalid: !!error }" :for="id">
    <span v-if="label" class="lbl">{{ label }}<i v-if="required" class="req">*</i></span>
    <span class="control">
      <GIcon v-if="icon" :name="icon" :size="16" class="lead" />
      <select :id="id" v-model="model" :disabled="disabled">
        <option v-if="placeholder !== undefined" value="">{{ placeholder }}</option>
        <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <GIcon name="chevron-down" :size="16" class="caret" />
    </span>
    <span v-if="error" class="err">{{ error }}</span>
  </label>
</template>

<style scoped>
.g-select {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.lbl {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-2);
}
.req {
  font-style: normal;
  color: var(--c-danger);
  margin-left: 3px;
}
.control {
  position: relative;
  display: flex;
  align-items: center;
  height: 40px;
  border-radius: var(--radius-sm);
  background: var(--field);
  border: 1px solid var(--field-border);
  backdrop-filter: blur(8px);
  transition:
    border-color var(--dur),
    box-shadow var(--dur);
}
.control:focus-within {
  border-color: var(--field-focus);
  box-shadow: 0 0 0 4px var(--focus-ring);
}
.invalid .control {
  border-color: var(--c-danger);
}
.lead {
  margin-left: 12px;
  color: var(--text-3);
  pointer-events: none;
}
select {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 34px 0 12px;
  border: 0;
  outline: 0;
  background: transparent;
  font: inherit;
  color: var(--text);
  appearance: none;
  cursor: pointer;
}
select option {
  background: var(--bg);
  color: var(--text);
}
.caret {
  position: absolute;
  right: 12px;
  color: var(--text-3);
  pointer-events: none;
}
.err {
  font-size: var(--fs-xs);
  color: var(--c-danger);
}
</style>
