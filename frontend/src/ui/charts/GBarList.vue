<script setup lang="ts">
/** 橫向長條清單(分類比較用,標籤在左、數值在右,長度一目了然) */
import { computed } from 'vue';
import { chartColor } from './palette';

export interface GBarListItem {
  label: string;
  value: number;
  hint?: string;
  color?: string;
}

const props = withDefaults(
  defineProps<{
    items: GBarListItem[];
    unit?: string;
    colorful?: boolean;
    clickable?: boolean | ((item: GBarListItem) => boolean);
    pickHint?: string;
  }>(),
  {
    unit: '',
    clickable: false,
    pickHint: '',
  },
);
const emit = defineEmits<{ (e: 'pick', item: GBarListItem): void }>();
const max = computed(() => Math.max(1, ...props.items.map((i) => i.value)));
const canPick = (it: GBarListItem): boolean => (typeof props.clickable === 'function' ? props.clickable(it) : !!props.clickable);
</script>

<template>
  <ul class="g-barlist">
    <li v-for="(it, i) in items" :key="it.label">
      <button
        v-if="canPick(it)"
        type="button"
        class="item-btn"
        :title="pickHint || `點擊查詢 ${it.label}`"
        @click="emit('pick', it)"
      >
        <div class="meta">
          <span class="lbl is-link">{{ it.label }}</span>
          <span v-if="it.hint" class="faint xs">{{ it.hint }}</span>
          <span class="spacer" />
          <span class="val num">{{ it.value.toLocaleString() }}{{ unit }}</span>
        </div>
        <div class="track">
          <span class="bar" :style="{ width: `${(it.value / max) * 100}%`, '--c': it.color ?? (colorful ? chartColor(i) : 'var(--c-primary)') }" />
        </div>
      </button>
      <template v-else>
        <div class="meta">
          <span class="lbl">{{ it.label }}</span>
          <span v-if="it.hint" class="faint xs">{{ it.hint }}</span>
          <span class="spacer" />
          <span class="val num">{{ it.value.toLocaleString() }}{{ unit }}</span>
        </div>
        <div class="track">
          <span class="bar" :style="{ width: `${(it.value / max) * 100}%`, '--c': it.color ?? (colorful ? chartColor(i) : 'var(--c-primary)') }" />
        </div>
      </template>
    </li>
  </ul>
</template>

<style scoped>
.g-barlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.item-btn {
  display: block;
  width: 100%;
  padding: 4px 6px;
  margin: -4px -6px;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.item-btn:hover {
  background: var(--glass-hover);
}
.item-btn:hover .lbl.is-link {
  color: var(--c-primary-text);
  text-decoration: underline;
}
.meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
  font-size: var(--fs-sm);
}
.lbl {
  font-weight: 600;
}
.val {
  font-weight: 700;
}
.track {
  height: 8px;
  border-radius: 99px;
  background: var(--line);
  overflow: hidden;
}
.bar {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--c) 55%, transparent), var(--c));
  box-shadow: 0 0 12px color-mix(in srgb, var(--c) 45%, transparent);
  transition: width 700ms var(--ease);
}
</style>
