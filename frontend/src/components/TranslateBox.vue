<script setup lang="ts">
/**
 * AI 回答的「翻譯」(由舊版 src/components/TranslateBox.vue 搬移;docs/API.md §10.1):
 *   選語言 → POST /api/netops/ai/translations(SSE,沿用 LLM_URL / LLM_MODEL、關閉思考),譯文顯示在下方;換了內容清掉舊譯文
 */
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { ai, TRANSLATE_LANGS, type TranslateTarget } from '@/api/ai';
import { describeError } from '@/api/gateway';
import { toast } from '@/ui';
import AiMarkdown from './AiMarkdown.vue';

const props = defineProps<{ text: string }>();
const result = shallowRef<{ target: string; text: string; seconds: number } | null>(null);
const loading = ref<TranslateTarget | ''>('');
let controller: AbortController | null = null;

async function run(target: TranslateTarget) {
  if (!props.text || loading.value) return;
  loading.value = target;
  controller = new AbortController();
  try {
    result.value = await ai.translate(props.text, target, controller.signal);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') toast.error(`翻譯失敗:${describeError(e)}`);
  } finally {
    loading.value = '';
    controller = null;
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(result.value?.text ?? '');
    toast.success('已複製譯文');
  } catch {
    toast.error('無法複製,請手動選取文字');
  }
}

watch(
  () => props.text,
  () => (result.value = null),
);
onBeforeUnmount(() => controller?.abort());
const label = (v: string) => TRANSLATE_LANGS.find((l) => l.value === v)?.label ?? v;
</script>

<template>
  <div class="tr">
    <div class="langs">
      <span class="xs faint"><GIcon name="globe" :size="13" /> 翻譯</span>
      <GButton v-for="l in TRANSLATE_LANGS" :key="l.value" size="sm" variant="ghost" :loading="loading === l.value" :disabled="!text || (!!loading && loading !== l.value)" @click="run(l.value)">
        {{ l.label }}
      </GButton>
    </div>
    <div v-if="result" class="out">
      <div class="bar xs faint">
        <GIcon name="globe" :size="13" />{{ label(result.target) }}({{ result.seconds }} 秒)
        <span class="spacer" />
        <GButton size="sm" variant="ghost" icon="file-text" @click="copy">複製</GButton>
        <GButton size="sm" variant="ghost" icon="x" square aria-label="關閉譯文" @click="result = null" />
      </div>
      <AiMarkdown :text="result.text" />
    </div>
  </div>
</template>

<style scoped>
.tr {
  min-width: 0;
}
.langs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.out {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--line);
}
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.spacer {
  flex: 1;
}
</style>
