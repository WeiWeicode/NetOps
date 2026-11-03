<script setup lang="ts">
/** 多行文字輸入:外觀同 GInput(label、錯誤、提示);mono 用於位址、JSON、Gherkin 等程式文字 */
import { useId } from 'vue';

withDefaults(
  defineProps<{
    label?: string;
    placeholder?: string;
    error?: string | null;
    hint?: string;
    disabled?: boolean;
    required?: boolean;
    rows?: number;
    mono?: boolean;
  }>(),
  { rows: 3 },
);
const model = defineModel<string>({ default: '' });
const id = useId();
</script>

<template>
  <label class="g-field" :class="{ invalid: !!error, disabled }" :for="id">
    <span v-if="label" class="lbl">{{ label }}<i v-if="required" class="req">*</i></span>
    <textarea
      :id="id"
      v-model="model"
      :rows="rows"
      :placeholder="placeholder"
      :disabled="disabled"
      :required="required"
      :aria-invalid="!!error || undefined"
      :class="{ mono }"
    />
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
textarea {
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--field);
  border: 1px solid var(--field-border);
  backdrop-filter: blur(8px);
  outline: 0;
  font: inherit;
  color: var(--text);
  resize: vertical;
  transition:
    border-color var(--dur),
    box-shadow var(--dur);
}
textarea.mono {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
textarea::placeholder {
  color: var(--text-3);
}
textarea:focus {
  border-color: var(--field-focus);
  box-shadow: 0 0 0 4px rgb(99 102 241 / 0.16);
}
.invalid textarea {
  border-color: var(--c-danger);
}
.disabled textarea {
  opacity: 0.6;
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
