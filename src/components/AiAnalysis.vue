<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Sparkles, Square, Copy, RotateCcw, Brain, Loader2 } from 'lucide-vue-next'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import http, { apiBase } from '../api/http.js'
import { getToken } from '../stores/token.js'
import TranslateBox from './TranslateBox.vue'

/**
 * AI 分析（POST /ai/analyze，SSE 串流）：分析 from ~ to（'yyyy/MM/dd'）的 PA log 統計摘要
 * question：想特別了解的問題（可空白）
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  from: { type: String, default: '' },
  to: { type: String, default: '' },
  title: { type: String, default: 'AI 分析' },
})
const emit = defineEmits(['update:modelValue'])
const open = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) })

const think = ref(false)
const question = ref('')
const phase = ref('idle') // idle | preparing | thinking | writing | done | error
const text = ref('')
const error = ref('')
const meta = ref(null)
const thinkingChars = ref(0)
const truncated = ref(false)
const service = ref(null) // { ok, model, message }
const elapsed = ref(0)
let controller = null
let timer = null

const running = computed(() => ['preparing', 'thinking', 'writing'].includes(phase.value))
// 時間範圍「08:31~09:43」的 ~ 會被 Markdown 當成刪除線，先換成全形「～」
const html = computed(() => DOMPurify.sanitize(marked.parse((text.value || '').replace(/~/g, '～'), { breaks: false, gfm: true })))

const phaseText = computed(() => {
  if (phase.value === 'preparing') return '整理防火牆統計、等待 AI 回應...'
  if (phase.value === 'thinking') return `AI 思考中...（已思考 ${thinkingChars.value.toLocaleString()} 字）`
  if (phase.value === 'writing') return 'AI 撰寫中...'
  return ''
})

async function checkService() {
  if (service.value?.ok) return
  try {
    const res = await http.get('/ai/status')
    service.value = res.data
  } catch (err) {
    service.value = { ok: false, message: err.message }
  }
}

function reset() {
  text.value = ''
  error.value = ''
  meta.value = null
  thinkingChars.value = 0
  truncated.value = false
  elapsed.value = 0
}

async function start() {
  if (running.value) return
  reset()
  phase.value = 'preparing'
  controller = new AbortController()
  const t0 = Date.now()
  timer = setInterval(() => (elapsed.value = Math.round((Date.now() - t0) / 1000)), 1000)
  try {
    const res = await fetch(`${apiBase}/ai/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ from: props.from, to: props.to, think: think.value, question: question.value }),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`
      try {
        msg = (await res.json()).message || msg
      } catch {
        // 不是 JSON
      }
      throw new Error(msg)
    }

    // 解析 SSE：event: xxx\ndata: {...}\n\n
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const event = block.match(/^event: (.*)$/m)?.[1]
        const data = block.match(/^data: (.*)$/m)?.[1]
        if (!event || !data) continue
        const payload = JSON.parse(data)
        if (event === 'meta') meta.value = payload
        else if (event === 'thinking') {
          phase.value = 'thinking'
          thinkingChars.value = payload.chars
        } else if (event === 'content') {
          phase.value = 'writing'
          text.value += payload.text
        } else if (event === 'done') truncated.value = payload.truncated
        else if (event === 'error') throw new Error(payload.message)
      }
    }
    phase.value = text.value ? 'done' : 'error'
    if (!text.value) error.value = 'AI 沒有產生內容，請再試一次'
  } catch (err) {
    if (err.name === 'AbortError') {
      phase.value = text.value ? 'done' : 'idle'
    } else {
      phase.value = 'error'
      error.value = err.message
    }
  } finally {
    clearInterval(timer)
    controller = null
  }
}

function stop() {
  controller?.abort()
}

async function copy() {
  try {
    await navigator.clipboard.writeText(text.value)
    ElMessage.success('已複製分析結果（Markdown）')
  } catch {
    ElMessage.error('無法複製，請手動選取文字')
  }
}

watch(open, (v) => {
  if (v) checkService()
  else stop()
})
// 換日期 / 範圍時清掉上一次的結果
watch(() => [props.from, props.to], () => {
  stop()
  reset()
  phase.value = 'idle'
})
onBeforeUnmount(stop)
</script>

<template>
  <el-drawer v-model="open" :title="title" size="min(860px, 100%)" class="ai-drawer">
    <div class="flex flex-col gap-3 h-full">
      <div class="flex flex-wrap items-center gap-3">
        <el-button v-if="!running" type="primary" :disabled="service && !service.ok" @click="start">
          <Sparkles v-if="phase === 'idle'" :size="16" class="mr-1" /><RotateCcw v-else :size="16" class="mr-1" />
          {{ phase === 'idle' ? '開始分析' : '重新分析' }}
        </el-button>
        <el-button v-else type="danger" plain @click="stop"><Square :size="14" class="mr-1" />停止</el-button>
        <el-tooltip content="先推理再回答，分析較完整，但需要數分鐘" placement="bottom">
          <el-checkbox v-model="think" :disabled="running"><Brain :size="14" class="inline mr-1 -mt-0.5" />深入思考（較慢）</el-checkbox>
        </el-tooltip>
        <el-button v-if="text && !running" text @click="copy"><Copy :size="14" class="mr-1" />複製結果</el-button>        <span class="ml-auto text-xs text-dim">
          <template v-if="service?.ok">模型：{{ service.model }}</template>
          <template v-if="meta">　資料 {{ meta.contextChars.toLocaleString() }} 字</template>
          <template v-if="running || elapsed">　{{ elapsed }} 秒</template>
        </span>
      </div>

      <div v-if="service && !service.ok" class="rounded-lg p-3 text-sm bg-danger/10 border border-danger/40 text-danger">{{ service.message }}</div>

      <el-input v-model="question" type="textarea" :rows="2" :disabled="running" maxlength="1000" resize="none"
        placeholder="想特別了解的問題（可空白），例如：10.10.115.35 一直被擋是什麼原因？有沒有對外開放不該開的服務？" />

      <p v-if="phase === 'idle'" class="m-0 text-sm text-mute">
        分析 {{ from === to ? from : `${from} ~ ${to}` }} 的流量、阻擋、外部連入、高風險應用與疑似掃描，並和前一段同長度期間比較。
        只送統計摘要（不送原始 log），送到公司內部的 AI 服務（10.10.130.45），不會傳到外部。
      </p>

      <div v-if="running && !text" class="flex items-center gap-2 text-mute text-sm py-6 justify-center">
        <Loader2 :size="18" class="animate-spin text-brand-500" />{{ phaseText }}
      </div>

      <div v-if="text" class="flex-1 min-h-0 overflow-y-auto pr-1">
        <!-- 內容由 marked 轉換、DOMPurify 過濾後顯示 -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <article class="ai-md" v-html="html" />
        <div v-if="!running" class="mt-2 border-t border-glow pt-1"><TranslateBox :text="text" /></div>
        <p v-if="running" class="flex items-center gap-2 text-dim text-xs mt-2"><Loader2 :size="14" class="animate-spin" />{{ phaseText }}</p>
        <p v-if="truncated" class="text-warn text-xs mt-2">內容超過長度上限被截斷；可以取消「深入思考」後重新分析。</p>
      </div>

      <div v-if="error" class="rounded-lg p-3 text-sm bg-danger/10 border border-danger/40 text-danger">{{ error }}</div>

      <p class="m-0 text-xs text-dim border-t border-glow pt-2">AI 依目前資料自動產生，內容僅供參考；調整防火牆政策前，請以「Log 明細查詢」與 PA 管理介面的實際紀錄確認。</p>
    </div>
  </el-drawer>
</template>

<style scoped>
.ai-md {
  color: var(--color-ink);
  font-size: 0.875rem;
  line-height: 1.7;
}
.ai-md :deep(h1),
.ai-md :deep(h2) {
  font-size: 1.05rem;
  font-weight: 700;
  margin: 1.1em 0 0.4em;
  padding-bottom: 0.25em;
  border-bottom: 1px solid var(--color-glow);
}
.ai-md :deep(h2:first-child) {
  margin-top: 0;
}
.ai-md :deep(h3) {
  font-size: 0.95rem;
  font-weight: 700;
  margin: 0.9em 0 0.3em;
}
.ai-md :deep(p) {
  margin: 0.4em 0;
}
.ai-md :deep(ul),
.ai-md :deep(ol) {
  margin: 0.3em 0;
  padding-left: 1.4em;
}
.ai-md :deep(li) {
  margin: 0.15em 0;
}
.ai-md :deep(code) {
  font-size: 0.85em;
  padding: 0.1em 0.35em;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-ink) 8%, transparent);
}
.ai-md :deep(strong) {
  font-weight: 700;
}
.ai-md :deep(table) {
  border-collapse: collapse;
  margin: 0.5em 0;
  font-size: 0.8125rem;
}
.ai-md :deep(th),
.ai-md :deep(td) {
  border: 1px solid var(--color-glow);
  padding: 4px 8px;
  text-align: left;
}
.ai-md :deep(blockquote) {
  margin: 0.5em 0;
  padding-left: 0.8em;
  border-left: 3px solid var(--color-glow);
  color: var(--color-mute);
}
</style>
