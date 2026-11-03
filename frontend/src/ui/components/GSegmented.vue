<script setup lang="ts">
/** 分段切換(小型篩選):options 為 { label, value, icon? } */
defineProps<{ options: { label: string; value: string; icon?: string }[]; size?: 'sm' | 'md' }>();
const model = defineModel<string>({ required: true });
</script>

<template>
  <div class="g-seg" :class="`s-${size ?? 'md'}`" role="radiogroup">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="radio"
      :aria-checked="model === o.value"
      :class="{ active: model === o.value }"
      @click="model = o.value"
    >
      <GIcon v-if="o.icon" :name="o.icon" :size="15" />
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.g-seg {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
}
button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font: inherit;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.s-sm button {
  height: 26px;
  padding: 0 10px;
  font-size: var(--fs-xs);
}
button:hover {
  color: var(--text);
}
button.active {
  color: var(--text);
  background: var(--glass-strong);
  box-shadow: var(--shadow-sm);
}
</style>
