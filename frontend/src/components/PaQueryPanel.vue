<script setup lang="ts">
/**
 * PA 精準查詢(C5)最小可用介面:輸入 IP → 查當下 Session 或最近 15 分鐘 log。
 * **正式畫面由 Gemini 改寫**(HANDOFF-GEMINI-VIZ §10);資料與狀態只用 usePaQuery。沒有按鈕權限(netops.pa-live.query)時整塊不顯示。
 */
import { computed, onMounted, ref } from 'vue';
import { describeError } from '@/api/gateway';
import { usePaQuery } from '@/composables/usePaQuery';

const props = defineProps<{ ip?: string }>();
const q = usePaQuery();
const ip = ref(props.ip ?? '');
const valid = computed(() => /^[0-9A-Fa-f:.]{2,45}$/.test(ip.value.trim()));
const cols = computed(() => {
  const rows = q.job.value?.result?.rows ?? [];
  return rows.length ? Object.keys(rows[0]!).filter((k) => rows.some((r) => r[k] !== '' && r[k] !== undefined)).slice(0, 12) : [];
});
onMounted(() => void q.refreshState());
</script>

<template>
  <GCard v-if="q.canQuery.value" title="PA 精準查詢" icon="search" padding="sm">
    <div class="paq">
      <GInput v-model="ip" placeholder="IP,例 10.10.130.124" aria-label="查詢的 IP" />
      <GButton size="sm" :disabled="!valid || !q.ready.value" @click="q.session(ip.trim())">當下連線</GButton>
      <GButton size="sm" variant="ghost" :disabled="!valid || !q.ready.value" @click="q.recentLog(ip.trim())">最近 15 分鐘 log</GButton>
      <span class="paq__hint">
        <template v-if="q.server.value && !q.server.value.enabled">PA 精準查詢未啟用</template>
        <template v-else-if="q.waitSec.value">{{ q.waitSec.value }} 秒後可再查(全系統一次一個、每人每分鐘一次)</template>
        <template v-if="q.server.value?.mgmtCpu != null">・管理平面 CPU {{ q.server.value.mgmtCpu }}%</template>
      </span>
    </div>
    <p v-if="q.state.value === 'waiting' || q.state.value === 'submitting'">查詢 PA-560 中…(最長 60 秒)</p>
    <GAlert v-else-if="q.state.value === 'busy' || q.state.value === 'error'" :tone="q.state.value === 'busy' ? 'info' : 'danger'">{{ describeError(q.error.value) }}</GAlert>
    <GAlert v-else-if="q.job.value?.error" :tone="q.state.value === 'rejected' ? 'warning' : 'danger'">{{ q.job.value.error.message }}</GAlert>
    <template v-else-if="q.job.value?.result">
      <p>
        {{ q.job.value.result.count }} 筆<template v-if="q.job.value.result.truncated">(已達上限,只顯示前 {{ q.job.value.result.count }} 筆)</template>
        <template v-if="q.job.value.mgmtCpu != null">;查詢前管理平面 CPU {{ q.job.value.mgmtCpu }}%</template>
      </p>
      <div class="paq__table">
        <table>
          <thead>
            <tr><th v-for="c in cols" :key="c">{{ c }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in q.job.value.result.rows" :key="i"><td v-for="c in cols" :key="c">{{ r[c] }}</td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </GCard>
</template>

<style scoped>
.paq {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.paq__hint {
  color: var(--text-3);
  font-size: 12px;
}
.paq__table {
  max-height: 320px;
  overflow: auto;
  font-size: 12px;
}
.paq__table th,
.paq__table td {
  padding: 2px 6px;
  text-align: left;
  white-space: nowrap;
}
</style>
