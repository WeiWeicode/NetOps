<script setup lang="ts">
/** 載入骨架:lines 行文字或指定高度的區塊 */
withDefaults(defineProps<{ lines?: number; height?: string }>(), { lines: 3 });
</script>

<template>
  <div class="g-skel" aria-busy="true" aria-label="載入中">
    <div v-if="height" class="bar" :style="{ height }" />
    <template v-else>
      <div v-for="i in lines" :key="i" class="bar" :style="{ width: i === lines ? '60%' : '100%' }" />
    </template>
  </div>
</template>

<style scoped>
.g-skel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bar {
  height: 14px;
  border-radius: 8px;
  background: linear-gradient(90deg, var(--glass-soft) 0%, var(--glass-hover) 50%, var(--glass-soft) 100%);
  background-size: 200% 100%;
  animation: shimmer 1.3s linear infinite;
}
@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}
</style>
