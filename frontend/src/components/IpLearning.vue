<script setup lang="ts">
/**
 * 外部 IP 自動學習(舊版知識庫頁的「學習外部 IP」;docs/API.md §10.2;ARCHITECTURE D10)
 *   狀態:netops.kb.read;執行:netops.kb.write(畫面節點 netops.kb-page.write)。執行在背景,開著時每 2 秒查狀態
 *   從最近幾天的 PA 摘要挑外部 IP → RDAP / DNS 反查 → AI 整理成知識庫筆記(作者「AI 自動學習」,管理者改過的筆記不覆寫)
 */
import { onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import { ai, type IpLearnStatus } from '@/api/ai';
import { describeError } from '@/api/gateway';
import { fmtTime } from '@/api/format';
import { toast } from '@/ui';

const props = defineProps<{ canRun: boolean }>();
const open = defineModel<boolean>({ default: false });
const emit = defineEmits<{ (e: 'learned'): void }>();

const status = shallowRef<IpLearnStatus | null>(null);
const error = ref<unknown>(null);
const form = reactive({ days: 7, max: 150, rewrite: false });
const starting = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let wasBusy = false;
/** 卸載後不再排輪詢;seq:只有最新一次查詢可以排下一輪(快速關閉再開啟時不會重複輪詢) */
let disposed = false;
let seq = 0;

async function refresh() {
  clearTimeout(timer);
  const my = ++seq;
  try {
    const s = await ai.ipLearning();
    if (my !== seq || disposed) return;
    status.value = s;
    error.value = null;
    // 執行完成:通知知識庫頁重新整理
    if (wasBusy && !s.busy) emit('learned');
    wasBusy = s.busy;
  } catch (e) {
    if (my !== seq || disposed) return;
    error.value = e;
  }
  clearTimeout(timer);
  if (open.value && status.value?.busy) timer = setTimeout(() => void refresh(), 2000);
}

async function run() {
  starting.value = true;
  try {
    const days = Math.min(Math.max(Math.round(Number(form.days)) || 7, 1), 60);
    const max = Math.min(Math.max(Math.round(Number(form.max)) || 150, 1), 500);
    Object.assign(form, { days, max });
    status.value = await ai.learnIps({ days, max, rewrite: form.rewrite });
    wasBusy = true;
    toast.success('已開始學習外部 IP');
    clearTimeout(timer);
    if (!disposed) timer = setTimeout(() => void refresh(), 2000);
  } catch (e) {
    toast.fromError(e, '無法開始學習');
  } finally {
    starting.value = false;
  }
}

watch(open, (v) => {
  if (v) void refresh();
  else {
    seq++;
    clearTimeout(timer);
  }
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>

<template>
  <GModal v-model:open="open" title="外部 IP 自動學習" subtitle="查公開註冊資料(RDAP)與 DNS 反查,請 AI 整理成知識庫筆記" icon="globe" width="720px">
    <div class="stack" style="--gap: 12px">
      <GAlert v-if="error" tone="danger">{{ describeError(error) }}</GAlert>
      <GAlert v-else-if="status && !status.enabled" tone="warning">尚未設定 AI 服務,無法自動學習。</GAlert>
      <template v-if="status?.enabled">
        <p class="small muted">
          已學過 {{ status.learnedIps ?? 0 }} 個 IP、{{ status.groups ?? 0 }} 個組織 / 網段、{{ status.notes ?? 0 }} 則筆記 ·
          {{ status.hour >= 0 ? `每天 ${status.hour} 點自動執行` : '不自動執行(只能手動)' }}
        </p>
        <p v-if="status.lastRun" class="small muted">
          上次:{{ status.lastRun.at }}({{ status.lastRun.by || '—' }})· {{ status.lastRun.range }} 共 {{ status.lastRun.candidates }} 個外部 IP,這次查
          {{ status.lastRun.looked }} 個、失敗 {{ status.lastRun.failed }},寫入 / 更新 {{ status.lastRun.notes }} 則筆記
        </p>
        <div v-if="status.busy" class="small">
          <p class="strong">執行中:{{ status.phase }}<template v-if="status.total">({{ status.done }} / {{ status.total }})</template></p>
        </div>
        <GAlert v-if="status.error" tone="danger">上次執行失敗:{{ status.error }}</GAlert>
        <pre v-if="status.log?.length" class="log">{{ status.log.join('\n') }}</pre>
        <p v-if="status.finishedAt && !status.busy" class="xs faint">結束於 {{ fmtTime(status.finishedAt) }}</p>

        <div v-if="props.canRun" class="run">
          <GInput v-model.number="form.days" type="number" label="看最近幾天的 log(1–60)" class="num-in" :disabled="status.busy" />
          <GInput v-model.number="form.max" type="number" label="最多查幾個新 IP(1–500)" class="num-in" :disabled="status.busy" />
          <GCheckbox v-model="form.rewrite" :disabled="status.busy" label="已學過的組織也重新整理(管理者改過的筆記不覆寫)" />
          <GButton variant="primary" icon="play" :loading="starting" :disabled="status.busy" @click="run">立即學習</GButton>
        </div>
        <p class="xs faint">筆記標籤「自動學習」,可信度低於管理者手寫的筆記;已有管理者筆記涵蓋的 IP 會略過。RDAP 查詢會連到外部登記處(ARIN、APNIC 等),只送 IP。</p>
      </template>
    </div>
  </GModal>
</template>

<style scoped>
p {
  margin: 0;
}
.log {
  max-height: 220px;
  overflow-y: auto;
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  font-size: var(--fs-xs, 0.75rem);
  white-space: pre-wrap;
}
.run {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.num-in {
  width: 190px;
}
</style>
