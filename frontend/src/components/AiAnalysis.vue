<script setup lang="ts">
/**
 * AI 期間分析(由舊版 src/components/AiAnalysis.vue 搬移;docs/API.md §10.1):分析 from ~ to(YYYY-MM-DD)的 PA 統計摘要
 *   POST /api/netops/ai/analyses(SSE);只送統計摘要給公司內部 AI,不送原始 log
 *   question:想特別了解的問題(可空白);深入思考較慢
 * 以對話框顯示(流量總覽頁的「AI 分析」按鈕,權限 netops.pa-dashboard.ai)
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { ai, AiStreamError, type AiStatus } from '@/api/ai';
import { describeError } from '@/api/gateway';
import { toast } from '@/ui';
import AiMarkdown from './AiMarkdown.vue';
import TranslateBox from './TranslateBox.vue';

const props = defineProps<{ from: string; to: string }>();
const open = defineModel<boolean>({ default: false });

interface Meta {
  model: string;
  files: number;
  missing: number;
  rows: number;
  notes: { id: string; title: string; related: boolean }[];
  vectorError: boolean;
}

const think = ref(false);
const question = ref('');
const phase = ref<'idle' | 'preparing' | 'thinking' | 'writing' | 'done' | 'error'>('idle');
const text = ref('');
const error = ref('');
const meta = shallowRef<Meta | null>(null);
const thinkingChars = ref(0);
const truncated = ref(false);
const service = shallowRef<AiStatus | null>(null);
const elapsed = ref(0);
let controller: AbortController | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

const running = computed(() => ['preparing', 'thinking', 'writing'].includes(phase.value));
const phaseText = computed(() => {
  if (phase.value === 'preparing') return '整理防火牆統計、等待 AI 回應...';
  if (phase.value === 'thinking') return `AI 思考中...(已思考 ${thinkingChars.value.toLocaleString()} 字)`;
  if (phase.value === 'writing') return 'AI 撰寫中...';
  return '';
});

async function checkService() {
  if (service.value?.ok) return;
  try {
    service.value = await ai.status();
  } catch (e) {
    service.value = { enabled: true, ok: false, model: '', message: describeError(e) };
  }
}

function reset() {
  text.value = '';
  error.value = '';
  meta.value = null;
  thinkingChars.value = 0;
  truncated.value = false;
  elapsed.value = 0;
}

async function start() {
  if (running.value || !props.from) return;
  reset();
  phase.value = 'preparing';
  controller = new AbortController();
  const t0 = Date.now();
  timer = setInterval(() => (elapsed.value = Math.round((Date.now() - t0) / 1000)), 1000);
  try {
    await ai.analyze(
      { from: props.from, to: props.to || props.from, think: think.value, question: question.value.trim() },
      (e) => {
        const p = e.data as Record<string, unknown>;
        if (e.event === 'meta') meta.value = p as unknown as Meta;
        else if (e.event === 'thinking') {
          phase.value = 'thinking';
          thinkingChars.value = Number(p.chars) || 0;
        } else if (e.event === 'content') {
          phase.value = 'writing';
          text.value += String(p.text ?? '');
        } else if (e.event === 'done') truncated.value = p.truncated === true;
      },
      controller.signal,
    );
    phase.value = text.value ? 'done' : 'error';
    if (!text.value) error.value = 'AI 沒有產生內容,請再試一次';
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      phase.value = text.value ? 'done' : 'idle';
      if (text.value) error.value = '已停止,分析不完整';
    } else {
      // 連線中斷(沒有收到 done)時保留已收到的內容,並標示不完整
      if (text.value) truncated.value = true;
      phase.value = 'error';
      error.value = e instanceof AiStreamError ? e.message : describeError(e);
    }
  } finally {
    clearInterval(timer);
    controller = null;
  }
}

const stop = () => controller?.abort();

async function copy() {
  try {
    await navigator.clipboard.writeText(text.value);
    toast.success('已複製分析結果(Markdown)');
  } catch {
    toast.error('無法複製,請手動選取文字');
  }
}

watch(open, (v) => {
  if (v) void checkService();
  else stop();
});
// 換了期間:舊的結果不適用
watch(
  () => [props.from, props.to],
  () => {
    if (!running.value) {
      reset();
      phase.value = 'idle';
    }
  },
);
onBeforeUnmount(() => {
  stop();
  clearInterval(timer);
});
</script>

<template>
  <GModal v-model:open="open" title="AI 分析" :subtitle="`${from}${to && to !== from ? ` ~ ${to}` : ''} 的防火牆統計`" icon="sparkles" width="880px">
    <div class="stack" style="--gap: 12px">
      <GAlert v-if="service && !service.ok" tone="danger">{{ service.message }}</GAlert>
      <GInput v-model="question" label="想特別了解的問題(選填)" placeholder="例如:有沒有疑似掃描或資料外流?" :disabled="running" maxlength="1000" />
      <div class="row-actions">
        <GCheckbox v-model="think" :disabled="running" label="深入思考(較慢,先推理再回答)" />
        <span class="spacer" />
        <GButton v-if="running" variant="danger" icon="square" @click="stop">停止</GButton>
        <GButton v-else variant="primary" icon="sparkles" :disabled="!from || (service !== null && !service.ok)" @click="start">{{ text ? '重新分析' : '開始分析' }}</GButton>
      </div>
      <p class="xs faint">只把這段期間的統計摘要(不是原始 log)送到公司內部的 AI 服務{{ service?.model ? `(${service.model})` : '' }},不會傳到外部。</p>

      <p v-if="meta" class="xs muted">
        {{ meta.files }} 個 log 檔、{{ meta.rows.toLocaleString() }} 筆連線紀錄<template v-if="meta.notes?.length"> · 參考知識庫 {{ meta.notes.length }} 則</template>
        <span v-if="meta.missing" class="c-warning"> · {{ meta.missing }} 個檔案的摘要讀不到,資料不完整</span>
        <span v-if="meta.vectorError" class="c-warning"> · 語意搜尋失敗,筆記改用關鍵字比對</span>
      </p>
      <p v-if="running" class="small muted status"><span class="spin" />{{ phaseText }}({{ elapsed }} 秒)</p>
      <GAlert v-if="error" tone="danger">{{ error }}</GAlert>
      <div v-if="text" class="result">
        <AiMarkdown :text="text" />
        <p v-if="truncated" class="xs c-warning">回答超過長度上限,內容可能不完整</p>
      </div>
      <div v-if="text && !running" class="tools">
        <GButton size="sm" variant="ghost" icon="file-text" @click="copy">複製</GButton>
        <TranslateBox :text="text" />
      </div>
    </div>
  </GModal>
</template>

<style scoped>
.row-actions,
.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.tools {
  align-items: flex-start;
}
.spacer {
  flex: 1;
}
p {
  margin: 0;
}
.result {
  max-height: 60vh;
  overflow-y: auto;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--glass-soft);
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
}
.spin {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--c-primary) 30%, transparent);
  border-top-color: var(--c-primary);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
