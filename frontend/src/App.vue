<script setup lang="ts">
/** 第一次導覽完成前(路由守衛等待 Gateway /api/auth/me)顯示載入畫面,避免整頁空白 */
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const ready = ref(false);
useRouter()
  .isReady()
  .finally(() => (ready.value = true));
</script>

<template>
  <RouterView v-if="ready" />
  <div v-else class="boot" role="status" aria-live="polite">
    <GLogo :size="48" />
    <span class="muted small">正在確認登入狀態…</span>
  </div>
  <GFeedbackHost />
</template>

<style scoped>
.boot {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  min-height: 100vh;
  animation: boot-in 300ms var(--ease) 200ms both;
}
@keyframes boot-in {
  from {
    opacity: 0;
  }
}
</style>
