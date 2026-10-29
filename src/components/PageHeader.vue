<script setup>
defineProps({
  title: { type: String, required: true },
  icon: { type: [Object, Function], default: null },
  subtitle: { type: String, default: '' },
})
</script>

<template>
  <!-- 精簡頁首：圖示、標題、右側按鈕同一行，讓下方表格多顯示幾列 -->
  <div class="flex flex-wrap items-center justify-between gap-2 mb-3 shrink-0">
    <div class="flex items-center gap-2 min-w-0">
      <component :is="icon" v-if="icon" :size="22" class="text-brand-500 shrink-0" />
      <h1 class="text-xl font-bold text-ink m-0 truncate">{{ title }}</h1>
      <span v-if="subtitle" class="text-sm text-mute truncate">{{ subtitle }}</span>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <slot />
    </div>
  </div>
</template>
