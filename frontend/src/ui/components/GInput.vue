<script setup lang="ts">
/** 文字輸入:label、左側 icon、錯誤訊息;type=password 時提供顯示 / 隱藏切換 */
import { computed, ref, useId } from 'vue';

const props = withDefaults(
  defineProps<{
    label?: string;
    icon?: string;
    type?: string;
    placeholder?: string;
    error?: string | null;
    hint?: string;
    disabled?: boolean;
    autocomplete?: string;
    size?: 'md' | 'lg';
    required?: boolean;
    clearable?: boolean;
  }>(),
  { type: 'text', size: 'md' },
);
// type="number" 搭配 v-model.number 時為數字
const model = defineModel<string | number>({ default: '' });
const id = useId();
const reveal = ref(false);
const inputType = computed(() => (props.type === 'password' && reveal.value ? 'text' : props.type));
</script>

<template>
  <label class="g-field" :class="[`s-${size}`, { invalid: !!error, disabled }]" :for="id">
    <span v-if="label" class="lbl">{{ label }}<i v-if="required" class="req">*</i></span>
    <span class="control">
      <GIcon v-if="icon" :name="icon" :size="17" class="lead" />
      <input
        :id="id"
        v-model="model"
        :type="inputType"
        :placeholder="placeholder"
        :disabled="disabled"
        :autocomplete="autocomplete"
        :aria-invalid="!!error || undefined"
        :required="required"
      />
      <button v-if="clearable && model" type="button" class="trail" aria-label="清除" @click="model = ''"><GIcon name="x" :size="15" /></button>
      <button v-if="type === 'password'" type="button" class="trail" :aria-label="reveal ? '隱藏密碼' : '顯示密碼'" @click="reveal = !reveal">
        <GIcon :name="reveal ? 'eye-off' : 'eye'" :size="17" />
      </button>
    </span>
    <span v-if="error" class="err">{{ error }}</span>
    <span v-else-if="hint" class="hint">{{ hint }}</span>
  </label>
</template>

<style scoped>
.g-field {
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
    box-shadow var(--dur),
    background var(--dur);
}
.s-lg .control {
  height: 48px;
  border-radius: var(--radius-md);
}
.control:focus-within {
  border-color: var(--field-focus);
  box-shadow: 0 0 0 4px var(--focus-ring);
}
.invalid .control {
  border-color: var(--c-danger);
}
.disabled .control {
  opacity: 0.6;
}
.lead {
  margin-left: 12px;
  color: var(--text-3);
}
input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 12px;
  border: 0;
  outline: 0;
  background: transparent;
  font: inherit;
  color: var(--text);
}
input::placeholder {
  color: var(--text-3);
}
.trail {
  display: grid;
  place-items: center;
  width: 34px;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.trail:hover {
  color: var(--text);
}
.err {
  font-size: var(--fs-xs);
  color: var(--c-danger);
}
.hint {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
</style>
