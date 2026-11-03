<script setup lang="ts">
/** Gateway BFF 無法連線(非 401)時的維護頁:可重試,不導向登入(giga-Portal PRD §10 可用性) */
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();
const retrying = ref(false);

function target(): string {
  const r = route.query.redirect;
  // 只接受本系統內的相對路徑
  return typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') ? r : '/';
}

async function retry() {
  retrying.value = true;
  await router.replace(target()).finally(() => (retrying.value = false));
}
</script>

<template>
  <GCard class="state">
    <GEmpty icon="alert" tone="danger" title="暫時無法連線 Gateway" description="Gateway BFF 目前沒有回應,請稍後再試;持續發生請洽 IT。">
      <GButton variant="primary" icon="refresh" :loading="retrying" @click="retry">重試</GButton>
    </GEmpty>
  </GCard>
</template>

<style scoped>
.state {
  max-width: 640px;
  margin: 15vh auto;
}
</style>
