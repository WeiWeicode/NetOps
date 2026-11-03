<script setup lang="ts">
/** 全站圖示:以名稱取用(新增圖示時在 ui/icons.ts 登記,頁面不直接 import lucide) */
import { computed } from 'vue';
import { FALLBACK_ICON, ICONS } from '../icons';

const props = withDefaults(defineProps<{ name: string; size?: number; stroke?: number }>(), { size: 18, stroke: 1.9 });
const icon = computed(() => ICONS[props.name] ?? FALLBACK_ICON);
</script>

<template>
  <component :is="icon" class="g-icon" :size="size" :stroke-width="stroke" aria-hidden="true" />
</template>

<style scoped>
.g-icon {
  flex: none;
  vertical-align: middle;
}
</style>
