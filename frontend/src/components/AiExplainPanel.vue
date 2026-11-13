<script setup lang="ts">
/**
 * AC4 AI 解讀面板(時段明細抽屜「AI 解讀這個時段」、分析儀表板「AI 摘要本期異常」共用;docs/API.md §10.3)
 *   - 狀態與串流在 composables/useAiExplain.ts;回答一律經 AiMarkdown(DOMPurify)
 *   - 條件改變時清掉舊回答(進行中的回答先停止);autoStart 時掛上就開始(對話框用)
 *   - 只送條件,後端自己取統計;畫面註明只送統計到公司內部 AI
 *   - 進度文字 aria-live;動畫依 prefers-reduced-motion 關閉
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { ExplainInput } from '@/api/ai';
import { explainKey, useAiExplain } from '@/composables/useAiExplain';
import { toast } from '@/ui';
import AiMarkdown from './AiMarkdown.vue';

const props = withDefaults(
  defineProps<{
    input: ExplainInput | null;
    title: string;
    startLabel: string;
    /** 標題下的說明(例:送了哪些資料) */
    hint?: string;
    autoStart?: boolean;
    /** 外框:card = 有邊框的區塊(抽屜內);plain = 沒有外框(對話框內) */
    frame?: 'card' | 'plain';
  }>(),
  { hint: '', autoStart: false, frame: 'card' },
);

const x = useAiExplain();
const think = ref(false);
const uid = `ai-explain-${Math.random().toString(36).slice(2, 8)}`;
const key = computed(() => explainKey(props.input));

function run() {
  if (props.input) void x.start(props.input, { think: think.value });
}

// 條件改變:舊的回答不適用
watch(key, (k) => {
  if (k !== x.answeredKey.value) x.reset();
});

onMounted(() => {
  if (props.autoStart) run();
});

async function copy() {
  try {
    await navigator.clipboard.writeText(x.text.value);
    toast.success('已複製 AI 回答(Markdown)');
  } catch {
    toast.error('無法複製,請手動選取文字');
  }
}

defineExpose({ start: run, stop: x.stop });
</script>

<template>
  <section class="ai-explain" :class="`is-${frame}`" :aria-labelledby="`${uid}-title`" :aria-busy="x.running.value">
    <header class="ai-explain__head">
      <span v-if="frame === 'card'" class="ai-explain__icon" aria-hidden="true"><GIcon name="sparkles" :size="16" /></span>
      <div class="ai-explain__titles">
        <!-- 對話框內(plain)標題已在對話框標題列,只留給螢幕報讀 -->
        <h3 :id="`${uid}-title`" class="ai-explain__title" :class="{ 'sr-only': frame === 'plain' }">{{ title }}</h3>
        <p class="xs faint">{{ hint || '只把統計與排行(不是原始 log)送到公司內部的 AI 服務,不會傳到外部' }}{{ x.meta.value?.model ? `(${x.meta.value.model})` : '' }}</p>
      </div>
      <div class="ai-explain__actions">
        <GCheckbox v-model="think" :disabled="x.running.value" label="深入思考" aria-label="深入思考(較慢,先推理再回答)" />
        <GButton v-if="x.running.value" size="sm" variant="danger" icon="square" @click="x.stop()">停止</GButton>
        <GButton v-else size="sm" variant="primary" icon="sparkles" :disabled="!input" @click="run">
          {{ x.text.value ? '重新解讀' : startLabel }}
        </GButton>
      </div>
    </header>

    <p v-if="x.running.value" class="ai-explain__status small muted" role="status" aria-live="polite">
      <span class="ai-explain__spin" aria-hidden="true" />{{ x.statusText.value }}({{ x.elapsed.value }} 秒)
    </p>

    <GAlert v-for="n in x.notices.value" :key="n.text" :tone="n.tone">{{ n.text }}</GAlert>
    <GAlert v-if="x.error.value" tone="danger">{{ x.error.value }}</GAlert>

    <div v-if="x.text.value" class="ai-explain__result" tabindex="0" :aria-label="`${title}的回答`">
      <AiMarkdown :text="x.text.value" />
      <p v-if="x.truncated.value" class="xs c-warning">回答超過長度上限或連線中斷,內容可能不完整</p>
    </div>

    <footer v-if="x.text.value && !x.running.value" class="ai-explain__foot">
      <span v-if="x.meta.value?.notes?.length" class="xs faint">參考知識庫 {{ x.meta.value.notes.length }} 則</span>
      <span class="spacer" />
      <GButton size="sm" variant="ghost" icon="file-text" @click="copy">複製</GButton>
    </footer>
  </section>
</template>

<style scoped>
.ai-explain {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.ai-explain.is-card {
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid color-mix(in srgb, var(--c-primary) 28%, var(--line));
  background: color-mix(in srgb, var(--c-primary) 5%, var(--glass-soft));
}
.ai-explain__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.ai-explain__icon {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  color: var(--c-primary);
  background: color-mix(in srgb, var(--c-primary) 14%, transparent);
}
.ai-explain__titles {
  flex: 1 1 200px;
  min-width: 0;
}
.ai-explain__title {
  margin: 0;
  font-size: var(--fs-md, 1rem);
  font-weight: 600;
}
.ai-explain__titles p {
  margin: 2px 0 0;
}
.ai-explain__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.ai-explain__status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}
.ai-explain__spin {
  width: 14px;
  height: 14px;
  flex: none;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--c-primary) 30%, transparent);
  border-top-color: var(--c-primary);
  animation: ai-explain-spin 0.8s linear infinite;
}
.ai-explain__result {
  max-height: 50vh;
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--glass-soft);
}
.ai-explain__result:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}
.ai-explain__result p {
  margin: 6px 0 0;
}
.ai-explain__foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.spacer {
  flex: 1;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@keyframes ai-explain-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-explain__spin {
    animation: none;
    border-color: var(--c-primary);
  }
}
@media (max-width: 480px) {
  .ai-explain__actions {
    width: 100%;
    justify-content: space-between;
  }
  .ai-explain__result {
    max-height: none;
  }
}
</style>
