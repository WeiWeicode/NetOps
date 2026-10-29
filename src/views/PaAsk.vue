<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Bot, Send, Square, Trash2, Brain, Loader2, Search, Copy, User, NotebookPen, BookOpen, Network, ShieldAlert } from 'lucide-vue-next'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import PageHeader from '../components/PageHeader.vue'
import TranslateBox from '../components/TranslateBox.vue'
import http, { apiBase } from '../api/http.js'
import { getToken } from '../stores/token.js'
import { useUserStore } from '../stores/user.js'
import { useChatStore } from '../stores/chat.js'
import { storeToRefs } from 'pinia'
import { fmtNum } from '../utils/format.js'

/**
 * AI 問答（POST /ai/ask，SSE 串流）；PA 防火牆與 AD 網域共用這個頁面（props.source = 'pa' | 'ad'）
 * PA：問題中有 IP / Port → 後端從 FTP 掃描防火牆 log 找出相關紀錄，連同問題送給內部 AI（10.10.130.45）；問到 AD 時一併附上 AD 事件
 * AD：只看已匯入的 AD 事件記錄（帳號、IP、事件 ID 會列出相關事件明細），不掃描防火牆 log；兩邊的對話分開保存
 * 追問時沒寫 IP 會沿用前面問題的 IP；對話只存在這個頁面，重新整理就清空
 * 管理者說明後請 AI 記錄（「請記錄：…」或按「記錄到知識庫」）→ POST /ai/note 存成知識庫 .md，之後問答會自動參考
 */
const props = defineProps({ source: { type: String, default: 'pa' } })
const isAd = props.source === 'ad'
const route = useRoute()
const router = useRouter()
const user = useUserStore()

/** 兩種來源的文字 */
const TEXT = isAd
  ? {
      title: 'AD AI 問答',
      subtitle: '問 AD 網域控制站的事件：帳號、登入、鎖定、特權異動、DNS、Kerberos、事件 ID',
      empty: '問 AD 事件記錄的問題',
      desc: '系統會把 {range} 的 AD 事件統計、需要注意的事件、帳號與特權異動，以及問題中帳號 / IP / 事件 ID 的相關事件整理給 AI。可以接著追問。',
      placeholder: '例如：S094009 為什麼被鎖定？事件 5719 要怎麼處理？（Ctrl + Enter 送出）',
      footer: 'AI 依 AD 事件記錄自動判斷，內容僅供參考；調整 AD 設定前請以「Log 明細查詢」與 DC 的事件檢視器確認。',
      examples: ['AD 網域控制站有哪些錯誤或警告？要怎麼處理？', '有沒有建立帳號或加入特權群組（Domain Admins 等）？', '事件 5719 和事件 37 是什麼問題？要怎麼處理？', '哪些帳號登入失敗或被鎖定最多？'],
      daysUrl: '/ad/days',
    }
  : {
      title: 'AI 問答',
      subtitle: '輸入 IP / Port 與問題，系統會從防火牆 log 找出相關紀錄交給 AI 判斷',
      empty: '問防火牆 log 的問題',
      desc: '問題裡寫 IP（可加 Port），系統會掃描 {range} 的防火牆 log，把這些 IP 的連線、被擋規則、結束原因整理給 AI；問到 AD（帳號、登入、DNS、Kerberos、事件 ID）會一併附上 AD 事件記錄。時間越短越快，一整天約需 1~3 分鐘。可以接著追問，沒寫 IP 會沿用上一題的 IP。',
      placeholder: '例如：10.10.112.1 連到 10.10.130.154 被擋，幫我查看問題（Ctrl + Enter 送出）',
      footer: 'AI 依 log 自動判斷，內容僅供參考；調整防火牆政策前請以「看原始紀錄」與 PA 管理介面確認。',
      examples: ['10.10.112.1 連到外面被擋，幫我查看問題', '10.10.115.35 連到 198.135.184.13 一直被擋，是什麼原因？', '10.10.130.3 的 445 port 有誰連不到？', '這段時間有沒有疑似掃描或中毒的主機？', 'AD 網域控制站有哪些錯誤或警告？要怎麼處理？'],
      daysUrl: '/palog/days',
    }
/** 「請記錄 / 記下來 / 記起來」開頭或包含這些字 → 當成要 AI 記錄 */
const NOTE_RE = /^\s*(請|幫我|麻煩)?\s*(ai\s*)?(記錄|紀錄|記下|記住|筆記|記起來)|請\s*(ai\s*)?(記錄|紀錄)|(記錄|紀錄)下來|記起來/i
const range = ref([])
const input = ref('')
const think = ref(false)
// 對話放在 store：切換頁面回來還在；PA 與 AD 分開
const chatStore = storeToRefs(useChatStore())
const messages = isAd ? chatStore.adMessages : chatStore.messages // { role: 'user' | 'assistant', content, evidence, status, error, ips, ports }
const running = ref(false)
const service = ref(null)
const listEl = ref(null)
let controller = null


const pad = (x) => String(x).padStart(2, '0')
const md = (text) => DOMPurify.sanitize(marked.parse((text || '').replace(/~/g, '～'), { gfm: true }))

async function scrollDown() {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' })
}

/** 對話紀錄（不含記錄筆記的訊息與錯誤） */
const historyOf = () => messages.value.filter((m) => m.content && !m.error && !m.kind).map((m) => ({ role: m.role, content: m.content }))

/** 請 AI 把管理者的說明整理成知識庫筆記 */
async function record(text = input.value) {
  const content = text.trim()
  if (!content || running.value) return
  const history = historyOf()
  messages.value.push({ role: 'user', content, kind: 'note' })
  messages.value.push({ role: 'assistant', content: '', kind: 'note', status: 'AI 整理筆記中...', error: '' })
  const r = messages.value[messages.value.length - 1]
  input.value = ''
  running.value = true
  scrollDown()
  try {
    const res = await http.post('/ai/note', { text: content, history }, { timeout: 200000 })
    r.note = res.data
    r.content = `已記錄到知識庫：**${res.data.title}**\n\n${res.data.content}`
  } catch (err) {
    r.error = err.message
  } finally {
    r.status = ''
    running.value = false
    scrollDown()
  }
}

async function send(text = input.value) {
  const question = text.trim()
  if (!question || running.value) return
  if (user.kbAdmin && NOTE_RE.test(question)) return record(question)
  if (!range.value?.length) return ElMessage.warning('請選擇時間範圍')
  const history = historyOf()
  messages.value.push({ role: 'user', content: question })
  const reply = { role: 'assistant', content: '', evidence: null, status: '準備中...', error: '' }
  messages.value.push(reply)
  const r = messages.value[messages.value.length - 1] // 取 reactive 版本
  input.value = ''
  running.value = true
  controller = new AbortController()
  scrollDown()
  try {
    const res = await fetch(`${apiBase}/ai/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ from: range.value[0], to: range.value[1], question, history, think: think.value, source: props.source }),
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
        const p = JSON.parse(data)
        if (event === 'meta') {
          r.ips = p.ips
          r.ports = p.ports
          r.status = isAd ? '整理 AD 事件記錄...' : p.ips.length || p.ports.length ? `查詢 ${[...p.ips, ...p.ports.map((x) => `Port ${x}`)].join('、')} 的 log...` : '整理期間統計...'
        } else if (event === 'scan') r.status = p.mode === 'flows' ? '查詢連線組合統計...' : `掃描 log ${p.filesScanned} / ${p.files} 個檔，找到 ${fmtNum(p.matched)} 筆...`
        else if (event === 'evidence') {
          r.evidence = p
          r.status = 'AI 分析中...'
        } else if (event === 'events') r.events = p
        else if (event === 'ad') {
          r.ad = p
          if (!r.evidence) r.status = 'AI 分析中...'
        } else if (event === 'notes') {
          r.notes = p.used
          r.notesOmitted = p.omitted
        }
        else if (event === 'thinking') r.status = `AI 思考中...（${fmtNum(p.chars)} 字）`
        else if (event === 'content') {
          r.status = 'AI 撰寫中...'
          r.content += p.text
          if (r.content.length % 400 < p.text.length) scrollDown()
        } else if (event === 'error') throw new Error(p.message)
      }
    }
    if (!r.content) r.error = 'AI 沒有產生內容，請再試一次'
  } catch (err) {
    if (err.name !== 'AbortError') r.error = err.message
    else if (!r.content) r.error = '已停止'
  } finally {
    r.status = ''
    running.value = false
    controller = null
    scrollDown()
  }
}

function stop() {
  controller?.abort()
}

function clearChat() {
  stop()
  messages.value = []
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已複製（Markdown）')
  } catch {
    ElMessage.error('無法複製，請手動選取文字')
  }
}

/** 到 Log 明細查詢看原始紀錄：1 個 IP 用「任一方 IP」，2 個 IP 再加關鍵字；AD 到 AD 的明細查詢 */
function openSearch(m) {
  if (isAd || m.ad) {
    const q = { from: range.value[0], to: range.value[1] }
    if (m.ips?.[0] && !m.ips[0].includes('/')) q.ip = m.ips[0]
    return router.push({ name: 'AdSearch', query: q })
  }
  const q = { from: range.value[0], to: range.value[1] }
  if (m.ips?.[0]) q.ip = m.ips[0]
  if (m.ips?.[1]) q.q = m.ips[1].replace(/\/\d+$/, '')
  if (m.ports?.length) q.port = m.ports.join(',')
  if (m.evidence?.block && !m.evidence?.allow) q.action = 'block'
  router.push({ name: 'PaSearch', query: q })
}

const rangeText = computed(() => (range.value?.length ? `${range.value[0]} ~ ${range.value[1]}` : ''))

onMounted(async () => {
  // 預設：最新一天有資料的整天
  const [days, st] = await Promise.all([http.get(TEXT.daysUrl).catch(() => null), http.get('/ai/status').catch((err) => ({ data: { ok: false, message: err.message } }))])
  service.value = st?.data ?? null
  const day = days?.data?.days?.[0]?.day
  if (day) range.value = [`${day} 00:00`, `${day} 23:59`]
  // 從其他頁帶過來的問題（例如安全事件頁點 IP）：?q=問題&from=yyyy/MM/dd&to=yyyy/MM/dd，填入輸入框由使用者送出
  const q = route.query
  if (q.from) range.value = [`${q.from} 00:00`, `${q.to || q.from} 23:59`]
  if (q.q) {
    input.value = String(q.q)
    router.replace({ query: {} })
  }
})
onBeforeUnmount(stop)

const onKey = (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send()
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <PageHeader :title="TEXT.title" :icon="isAd ? Network : Bot" :subtitle="TEXT.subtitle">
      <el-date-picker v-model="range" type="datetimerange" value-format="YYYY/MM/DD HH:mm" format="YYYY/MM/DD HH:mm" range-separator="~"
        :clearable="false" size="small" class="!w-[320px]" :disabled="running" />
      <el-button size="small" :disabled="!messages.length" @click="clearChat"><Trash2 :size="14" class="mr-1" />清除對話</el-button>
    </PageHeader>

    <div v-if="service && !service.ok" class="rounded-lg p-3 mb-3 text-sm bg-danger/10 border border-danger/40 text-danger">{{ service.message }}</div>

    <section class="glass rounded-2xl flex-1 min-h-[420px] flex flex-col overflow-hidden">
      <!-- 對話 -->
      <div ref="listEl" class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <div v-if="!messages.length" class="max-w-2xl mx-auto py-6 text-center">
          <Bot :size="40" class="text-brand-500 mx-auto" />
          <p class="m-0 mt-2 text-ink font-semibold">{{ TEXT.empty }}</p>
          <p class="m-0 mt-1 text-sm text-mute">{{ TEXT.desc.replace('{range}', rangeText) }}</p>
          <p v-if="user.kbAdmin" class="m-0 mt-2 text-sm text-mute">
            管理者可以補充說明並請 AI 記錄，例如「請記錄：10.10.130.154 是防毒伺服器，5517 是用戶端回報 Port」，
            會存到<a href="#" class="text-brand-500" @click.prevent="router.push({ name: 'Knowledge' })">知識庫</a>，之後的問答會自動參考。
          </p>
          <div class="flex flex-wrap justify-center gap-2 mt-4">
            <button v-for="q in TEXT.examples" :key="q" type="button" class="example" @click="send(q)">{{ q }}</button>
          </div>
          <p class="m-0 mt-4 text-xs text-dim">資料只送到公司內部的 AI 服務（10.10.130.45{{ service?.model ? `，${service.model}` : '' }}），不會傳到外部。</p>
        </div>

        <template v-for="(m, i) in messages" :key="i">
          <div v-if="m.role === 'user'" class="flex justify-end gap-2">
            <div class="bubble-user"><NotebookPen v-if="m.kind === 'note'" :size="14" class="inline mr-1 -mt-0.5 text-brand-500" />{{ m.content }}</div>
            <span class="avatar bg-brand-500/15 text-brand-500"><User :size="16" /></span>
          </div>
          <div v-else class="flex gap-2">
            <span class="avatar bg-run/15 text-run"><Bot :size="16" /></span>
            <div class="bubble-ai min-w-0 flex-1">
              <!-- 查到的資料 -->
              <div v-if="m.evidence" class="evidence">
                <template v-if="m.evidence.summary">{{ m.evidence.label }}</template>
                <template v-else>
                  <b>{{ m.evidence.label }}</b>：符合 {{ fmtNum(m.evidence.matched) }} 筆
                  （<span class="text-run">允許 {{ fmtNum(m.evidence.allow) }}</span>、<span class="text-danger">阻擋 {{ fmtNum(m.evidence.block) }}</span>，{{ fmtNum(m.evidence.flows) }} 種連線組合）·
                  查了 {{ m.evidence.filesScanned }} / {{ m.evidence.files }} 檔<template v-if="m.evidence.flowFiles">（{{ m.evidence.flowFiles === m.evidence.files ? '全部' : m.evidence.flowFiles }} 查連線統計<template v-if="m.evidence.rows">，其餘從 FTP 掃 {{ fmtNum(m.evidence.rows) }} 列</template>）</template><template v-else>、{{ fmtNum(m.evidence.rows) }} 列</template>{{ m.evidence.cached ? '（沿用剛才的查詢）' : `、${m.evidence.seconds} 秒` }}
                  <span v-if="m.evidence.partial" class="text-warn">· 掃描逾時，資料不完整</span>
                  <el-button link type="primary" size="small" class="!ml-1" @click="openSearch(m)"><Search :size="13" class="mr-0.5" />看原始紀錄</el-button>
                </template>
              </div>
              <!-- PA 其他類型 log（威脅、URL、GlobalProtect…） -->
              <div v-if="m.events" class="evidence flex flex-wrap items-center gap-x-2">
                <ShieldAlert :size="13" class="text-warn" />
                <template v-if="m.events.summary">一併參考威脅 / URL / VPN 等 log 的期間摘要</template>
                <template v-else>其他 log 也有這些 IP：{{ m.events.hits.map((h) => `${h.label} ${fmtNum(h.total)} 次`).join('、') }}</template>
              </div>
              <!-- AD 事件記錄 -->
              <div v-if="m.ad" class="evidence flex flex-wrap items-center gap-x-2">
                <Network :size="13" class="text-brand-500" />{{ m.ad.label }}<template v-if="m.ad.total">（{{ fmtNum(m.ad.total) }} 筆）</template>
                <el-button link type="primary" size="small" @click="openSearch(m)"><Search :size="13" class="mr-0.5" />看 AD 事件明細</el-button>
              </div>
              <!-- 這次參考的知識庫筆記 -->
              <div v-if="m.notes?.length" class="evidence flex flex-wrap items-center gap-x-2">
                <BookOpen :size="13" class="text-brand-500" />參考知識庫（{{ m.notes.length }} 則全部附上，粗體為判斷相關）：
                <button v-for="n in m.notes" :key="n.id" type="button" :class="['note-link', { 'font-bold': n.related }]" @click="router.push({ name: 'Knowledge', query: { id: n.id } })">{{ n.title }}</button>
                <span v-if="m.notesOmitted?.length" class="text-warn">另有 {{ m.notesOmitted.length }} 則超過字數上限只附標題（KB_MAX_CHARS）</span>
              </div>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <article v-if="m.content" class="ai-md" v-html="md(m.content)" />
              <div v-if="m.note" class="mt-1 text-xs text-mute flex flex-wrap items-center gap-x-3">
                <span>相關 IP：{{ m.note.ips.join('、') || '（無）' }}</span>
                <span>標籤：{{ m.note.tags.join('、') || '（無）' }}</span>
                <el-button link type="primary" size="small" @click="router.push({ name: 'Knowledge', query: { id: m.note.id } })">到知識庫查看 / 修改</el-button>
              </div>
              <p v-if="m.status" class="flex items-center gap-2 text-sm text-mute m-0 mt-1"><Loader2 :size="15" class="animate-spin text-brand-500" />{{ m.status }}</p>
              <p v-if="m.error" class="m-0 mt-1 text-sm text-danger">{{ m.error }}</p>
              <div v-if="m.content && !m.status" class="flex flex-wrap items-start gap-x-1 mt-1">
                <el-button text size="small" class="!px-1" @click="copy(m.content)"><Copy :size="13" class="mr-1" />複製</el-button>
                <div class="flex-1 min-w-0"><TranslateBox :text="m.content" /></div>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- 輸入 -->
      <div class="border-t border-glow p-3">
        <el-input v-model="input" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" resize="none" maxlength="2000" :disabled="running"
          :placeholder="TEXT.placeholder" @keydown="onKey" />
        <div class="flex flex-wrap items-center gap-3 mt-2">
          <el-tooltip content="先推理再回答，判斷較完整，但需要數分鐘" placement="top">
            <el-checkbox v-model="think" :disabled="running"><Brain :size="14" class="inline mr-1 -mt-0.5" />深入思考（較慢）</el-checkbox>
          </el-tooltip>
          <span class="text-xs text-dim">時間：{{ rangeText }}</span>
          <el-button v-if="running" class="ml-auto" type="danger" plain @click="stop"><Square :size="14" class="mr-1" />停止</el-button>
          <template v-else>
            <el-tooltip v-if="user.kbAdmin" content="把輸入的說明交給 AI 整理成知識庫筆記，之後問答會自動參考（也可以直接輸入「請記錄：…」）" placement="top">
              <el-button class="ml-auto" :disabled="!input.trim() || (service && !service.ok)" @click="record()"><NotebookPen :size="15" class="mr-1" />記錄到知識庫</el-button>
            </el-tooltip>
            <el-button :class="user.kbAdmin ? '' : 'ml-auto'" type="primary" :disabled="!input.trim() || (service && !service.ok)" @click="send()"><Send :size="15" class="mr-1" />送出</el-button>
          </template>
        </div>
        <p class="m-0 mt-1 text-xs text-dim">{{ TEXT.footer }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.avatar {
  width: 30px;
  height: 30px;
  border-radius: 9999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.bubble-user {
  max-width: min(720px, 85%);
  padding: 8px 12px;
  border-radius: 14px 14px 4px 14px;
  background: color-mix(in srgb, var(--color-brand-500) 14%, transparent);
  border: 1px solid var(--color-glow);
  color: var(--color-ink);
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble-ai {
  max-width: 980px;
  padding: 10px 14px;
  border-radius: 14px 14px 14px 4px;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--color-glow);
}
.evidence {
  font-size: calc(0.8125rem * var(--font-scale));
  color: var(--color-mute);
  padding: 6px 10px;
  margin-bottom: 8px;
  border-radius: 8px;
  background: var(--color-brand-50);
}
.note-link {
  color: var(--color-brand-500);
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
}
.note-link:hover {
  text-decoration: underline;
}
.example {
  padding: 6px 12px;
  border-radius: 9999px;
  border: 1px solid var(--color-glow);
  background: var(--color-brand-50);
  color: var(--color-ink);
  font-size: calc(0.875rem * var(--font-scale));
  cursor: pointer;
}
.example:hover {
  border-color: var(--color-brand-500);
}
.ai-md {
  color: var(--color-ink);
  font-size: 0.875rem;
  line-height: 1.7;
}
.ai-md :deep(h1),
.ai-md :deep(h2) {
  font-size: 1.02rem;
  font-weight: 700;
  margin: 1em 0 0.4em;
  padding-bottom: 0.2em;
  border-bottom: 1px solid var(--color-glow);
}
.ai-md :deep(h2:first-child) {
  margin-top: 0;
}
.ai-md :deep(h3) {
  font-size: 0.95rem;
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
</style>
