<script setup lang="ts">
/**
 * 連線驗證(IMPL-PLAN B0、F1):呼叫 GET /api/netops/ping,確認 瀏覽器 → Gateway → netops-api 的路徑與權限。
 * 只在擁有 netops.ping.read 時顯示(由呼叫端判斷);失敗時顯示錯誤與 requestId,不當作成功。
 */
import { describeError } from '@/api/gateway';
import { ping } from '@/api/netops';
import { useAsync } from '@/composables/useAsync';

const { data, loading, error, reload } = useAsync(ping);
</script>

<template>
  <GCard title="連線驗證" icon="activity">
    <template #actions>
      <GButton variant="ghost" size="sm" icon="refresh" :loading="loading" @click="reload">重新測試</GButton>
    </template>
    <GSkeleton v-if="loading && !data" :lines="2" />
    <GAlert v-else-if="error" tone="danger" title="無法連線 netops-api">{{ describeError(error) }}</GAlert>
    <dl v-else-if="data" class="kv">
      <dt>服務</dt>
      <dd>{{ data.service }}</dd>
      <dt>登入者</dt>
      <dd>{{ data.name }}(<span class="mono">{{ data.emp }}</span>){{ data.dept ? ` · ${data.dept}` : '' }}</dd>
      <dt>角色</dt>
      <dd>{{ data.roles.join('、') || '—' }}</dd>
      <dt>requestId</dt>
      <dd class="mono">{{ data.requestId }}</dd>
    </dl>
  </GCard>
</template>

<style scoped>
.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0;
  font-size: var(--fs-sm);
}
dt {
  color: var(--text-3);
}
dd {
  margin: 0;
  color: var(--text);
  overflow-wrap: anywhere;
}
</style>
