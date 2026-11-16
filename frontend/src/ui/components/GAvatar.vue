<script setup lang="ts">
/** 頭像:取姓名最後一字(中文)或前兩字母,顏色依名稱固定 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 34 });
// 頭像底色取自圖表色盤 token(明暗各一組)
const GRADS = [
  ['--chart-8', '--chart-1'],
  ['--chart-1', '--chart-2'],
  ['--chart-4', '--chart-2'],
  ['--chart-5', '--chart-6'],
  ['--chart-3', '--c-danger'],
];
const initials = computed(() => {
  const n = props.name.trim();
  return /[一-鿿]/.test(n) ? n.slice(-2) : n.slice(0, 2).toUpperCase();
});
const bg = computed(() => {
  const [a, b] = GRADS[[...props.name].reduce((s, c) => s + c.charCodeAt(0), 0) % GRADS.length]!;
  return `linear-gradient(135deg, var(${a}), var(${b}))`;
});
</script>

<template>
  <span class="g-avatar" :style="{ width: `${size}px`, height: `${size}px`, background: bg, fontSize: `${Math.round(size * 0.36)}px` }">{{ initials }}</span>
</template>

<style scoped>
.g-avatar {
  display: inline-grid;
  place-items: center;
  flex: none;
  border-radius: 30%;
  color: var(--text-invert);
  font-weight: 700;
  letter-spacing: 0.02em;
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.3),
    0 4px 12px rgb(0 0 0 / 0.12);
}
</style>
