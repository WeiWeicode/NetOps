<script setup>
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Languages, Loader2, Copy, X } from 'lucide-vue-next'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import http from '../api/http.js'

/**
 * AI 回答的「翻譯」：選語言 → POST /ai/translate（.45 Qwen，關閉思考），譯文顯示在下方
 * text：要翻譯的 Markdown；換了內容會清掉舊譯文
 */
const props = defineProps({ text: { type: String, default: '' } })

const LANGS = [
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'th', label: 'ภาษาไทย' },
  { value: 'zh', label: '繁體中文' },
]
const result = ref(null) // { target, text, seconds }
const loading = ref('')

const md = (t) => DOMPurify.sanitize(marked.parse((t || '').replace(/~/g, '～'), { gfm: true }))

async function run(target) {
  if (!props.text || loading.value) return
  loading.value = target
  try {
    const res = await http.post('/ai/translate', { text: props.text, target }, { timeout: 200000 })
    result.value = res.data
  } catch (err) {
    ElMessage.error(`翻譯失敗：${err.message}`)
  } finally {
    loading.value = ''
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(result.value.text)
    ElMessage.success('已複製譯文')
  } catch {
    ElMessage.error('無法複製，請手動選取文字')
  }
}

watch(() => props.text, () => (result.value = null))
</script>

<template>
  <span class="inline-flex flex-col w-full">
    <el-dropdown trigger="click" :disabled="!text || Boolean(loading)" @command="run">
      <el-button text size="small" class="!px-1">
        <Loader2 v-if="loading" :size="13" class="mr-1 animate-spin" /><Languages v-else :size="13" class="mr-1" />
        {{ loading ? '翻譯中...' : '翻譯' }}
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-for="l in LANGS" :key="l.value" :command="l.value">{{ l.label }}</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <div v-if="result" class="translated">
      <div class="flex items-center gap-2 text-xs text-dim mb-1">
        <Languages :size="13" />{{ LANGS.find((l) => l.value === result.target)?.label }}（{{ result.seconds }} 秒）
        <el-button text size="small" class="!px-1 ml-auto" @click="copy"><Copy :size="12" class="mr-1" />複製</el-button>
        <el-button text size="small" class="!px-1" aria-label="關閉譯文" @click="result = null"><X :size="12" /></el-button>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <article class="ai-md" v-html="md(result.text)" />
    </div>
  </span>
</template>

<style scoped>
.translated {
  margin-top: 6px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px dashed var(--color-glow);
  background: var(--color-brand-50);
}
.ai-md {
  color: var(--color-ink);
  font-size: 0.875rem;
  line-height: 1.7;
}
.ai-md :deep(h1),
.ai-md :deep(h2),
.ai-md :deep(h3) {
  font-size: 0.98rem;
  font-weight: 700;
  margin: 0.8em 0 0.3em;
}
.ai-md :deep(p) {
  margin: 0.4em 0;
}
.ai-md :deep(ul),
.ai-md :deep(ol) {
  margin: 0.3em 0;
  padding-left: 1.4em;
}
.ai-md :deep(code) {
  font-size: 0.85em;
  padding: 0.1em 0.35em;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-ink) 8%, transparent);
}
.ai-md :deep(table) {
  border-collapse: collapse;
}
.ai-md :deep(th),
.ai-md :deep(td) {
  border: 1px solid var(--color-glow);
  padding: 4px 8px;
}
</style>
