<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { BookOpen, Search, Plus, Pencil, Trash2, Download, Bot, Files, Globe } from 'lucide-vue-next'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import PageHeader from '../components/PageHeader.vue'
import http, { apiBase, call } from '../api/http.js'
import { getToken } from '../stores/token.js'

/**
 * 知識庫：管理者在 AI 問答請 AI 記錄的筆記（server 的 uploads/knowledge/*.md）
 * AI 問答 / AI 分析時會依問題的 IP 與關鍵字自動帶入相關筆記
 * 查詢所有人可用；新增 / 修改 / 刪除限管理者（server/.env 的 KB_ADMINS）
 * 匯整檔（_knowledge-all.md）：每次新增 / 修改 / 刪除後重新產生，AI 問答直接使用這份；清單最上面可預覽、下載
 * 外部 IP 自動學習：防火牆 log 的公網 IP 查 RDAP / DNS 反查後由 AI 整理成筆記（標籤「自動學習」），每天自動跑，管理者也可手動執行
 */
const ALL = '__all__'
const route = useRoute()
const router = useRouter()
const q = ref('')
const semantic = ref(false) // 語意搜尋（向量庫 Qdrant NetOpsKb）
const vector = ref(null) // 向量庫狀態 { enabled, ok, points, lastSync, error }
const notes = ref([])
const admin = ref(false)
const all = ref(null) // 匯整檔 { count, updated, chars, limit }
const allText = ref('')
const loading = ref(false)
const currentId = ref(String(route.query.id || ''))
const dialog = reactive({ open: false, saving: false, id: '', title: '', ips: '', tags: '', content: '' })

const md = (text) => DOMPurify.sanitize(marked.parse((text || '').replace(/~/g, '～'), { gfm: true }))
const current = computed(() => notes.value.find((n) => n.id === currentId.value) ?? null)

async function load() {
  loading.value = true
  const res = await call(http.get('/kb', { params: { q: q.value, semantic: semantic.value && q.value.trim() ? 1 : undefined } }))
  loading.value = false
  if (!res) return
  notes.value = res.data.notes
  admin.value = res.data.admin
  all.value = res.data.all
  vector.value = res.data.vector
  if (currentId.value === ALL) loadAll()
  else if (!current.value) currentId.value = notes.value[0]?.id ?? ''
}

/** 匯整檔內容（預覽用） */
async function loadAll() {
  allText.value = (await fetchMd(`${apiBase}/kb/all/md`)) ?? ''
}
function selectAll() {
  currentId.value = ALL
  router.replace({ query: { ...route.query, id: ALL } })
  loadAll()
}

function select(n) {
  currentId.value = n.id
  router.replace({ query: { ...route.query, id: n.id } })
}

function openEdit(n = null) {
  Object.assign(dialog, {
    open: true,
    id: n?.id ?? '',
    title: n?.title ?? '',
    ips: n?.ips.join(', ') ?? '',
    tags: n?.tags.join(', ') ?? '',
    content: n?.content ?? '',
  })
}

async function save() {
  if (!dialog.content.trim()) return ElMessage.warning('請輸入內容')
  dialog.saving = true
  const body = { title: dialog.title, ips: dialog.ips, tags: dialog.tags, content: dialog.content }
  const res = await call(dialog.id ? http.put(`/kb/${dialog.id}`, body) : http.post('/kb', body))
  dialog.saving = false
  if (!res) return
  ElMessage.success(res.message)
  dialog.open = false
  currentId.value = res.data.id
  load()
}

async function remove(n) {
  try {
    await ElMessageBox.confirm(`刪除「${n.title}」？刪除後 AI 問答不會再參考這則筆記，無法復原。`, '刪除筆記', { type: 'warning', confirmButtonText: '刪除', cancelButtonText: '取消' })
  } catch {
    return
  }
  const res = await call(http.delete(`/kb/${n.id}`))
  if (!res) return
  ElMessage.success(res.message)
  if (currentId.value === n.id) currentId.value = ''
  load()
}

/** 讀取 .md（需帶 token，所以用 fetch）；失敗回傳 null */
async function fetchMd(url) {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } catch (err) {
    ElMessage.error(`讀取失敗：${err.message}`)
    return null
  }
}

/** 下載 .md：n = 筆記；null = 匯整檔 */
async function download(n) {
  const text = await fetchMd(n ? `${apiBase}/kb/${n.id}/md` : `${apiBase}/kb/all/md`)
  if (text === null) return
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = n ? `${n.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)}.md` : '網通知識庫匯整.md'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/* ───────── 外部 IP 自動學習 ───────── */
const learn = reactive({ open: false, days: 7, max: 150, st: null })
let learnTimer = null
async function loadLearn() {
  const res = await call(http.get('/kb/learn-ips'))
  if (!res) return
  const wasBusy = learn.st?.busy
  learn.st = res.data
  clearTimeout(learnTimer)
  if (res.data.busy) learnTimer = setTimeout(loadLearn, 3000)
  else if (wasBusy) load() // 跑完重新讀筆記
}
function openLearn() {
  learn.open = true
  loadLearn()
}
async function startLearn() {
  const res = await call(http.post('/kb/learn-ips', { days: learn.days, max: learn.max }))
  if (!res) return
  ElMessage.success(res.message)
  learn.st = res.data
  setTimeout(loadLearn, 1500)
}
onUnmounted(() => clearTimeout(learnTimer))

/** 立即同步向量庫（管理者） */
const vectorSyncing = ref(false)
async function syncVector() {
  vectorSyncing.value = true
  const res = await call(http.post('/kb/vector-sync'))
  vectorSyncing.value = false
  if (!res) return
  ElMessage.success(res.message)
  vector.value = res.data
}

onMounted(load)
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <PageHeader title="知識庫" :icon="BookOpen" subtitle="管理者請 AI 記錄的環境說明，AI 問答與分析會自動參考">
      <el-button size="small" @click="router.push({ name: 'PaAsk' })"><Bot :size="14" class="mr-1" />到 AI 問答記錄</el-button>
      <el-button size="small" @click="openLearn"><Globe :size="14" class="mr-1" />外部 IP 自動學習</el-button>
      <el-button v-if="admin" size="small" type="primary" @click="openEdit()"><Plus :size="14" class="mr-1" />新增筆記</el-button>
    </PageHeader>

    <div class="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-3 flex-1 min-h-[460px]">
      <!-- 清單 -->
      <section class="glass rounded-2xl p-3 flex flex-col min-h-0">
        <el-input v-model="q" placeholder="查詢：IP、標題、內容、標籤（空白分隔多個關鍵字）" clearable @keyup.enter="load" @clear="load">
          <template #append><el-button :loading="loading" @click="load"><Search :size="15" /></el-button></template>
        </el-input>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 my-2 text-xs text-dim">
          <span>共 {{ notes.length }} 則{{ semantic && q.trim() ? '（依意思相近排序）' : '' }}</span>
          <el-checkbox v-if="vector?.enabled" v-model="semantic" size="small" @change="q.trim() && load()">語意搜尋</el-checkbox>
          <span v-if="vector?.enabled" class="ml-auto" :class="vector.ok === false ? 'text-warn' : ''" :title="vector.error || `最後同步 ${vector.lastSync || '－'}`">
            向量庫 {{ vector.collection }}：{{ vector.ok === false ? '連線失敗' : `${vector.points} 筆` }}
            <el-button v-if="admin" link size="small" :loading="vectorSyncing" @click="syncVector">同步</el-button>
          </span>
        </div>
        <ul v-loading="loading" class="flex-1 min-h-0 overflow-y-auto m-0 p-0 list-none space-y-1">
          <li v-if="all?.count" role="button" tabindex="0" :class="['note-item', { active: currentId === ALL }]" @click="selectAll" @keydown.enter="selectAll">
            <p class="m-0 font-semibold text-ink truncate"><Files :size="14" class="inline mr-1 -mt-0.5 text-brand-500" />匯整檔（全部 {{ all.count }} 則）</p>
            <p class="m-0 text-xs text-mute">AI 問答直接使用這份 · {{ all.chars.toLocaleString() }} 字</p>
            <p class="m-0 text-xs text-dim">更新於 {{ all.updated }}</p>
          </li>
          <li v-if="!notes.length && !loading" class="py-8 text-center text-sm text-dim">
            {{ q ? '沒有符合的筆記' : '還沒有筆記。管理者可在 AI 問答輸入「請記錄：…」' }}
          </li>
          <li v-for="n in notes" :key="n.id" role="button" tabindex="0" :class="['note-item', { active: n.id === currentId }]" @click="select(n)" @keydown.enter="select(n)">
            <p class="m-0 font-semibold text-ink truncate"><span v-if="n.score" class="text-xs font-normal text-brand-500 mr-1">{{ Math.round(n.score * 100) }}%</span>{{ n.title }}</p>
            <p class="m-0 text-xs text-mute truncate">{{ n.ips.join('、') || '一般說明' }}</p>
            <p class="m-0 text-xs text-dim">{{ n.updated }} · {{ n.author }}</p>
          </li>
        </ul>
      </section>

      <!-- 內容 -->
      <section class="glass rounded-2xl p-4 min-h-0 overflow-y-auto">
        <template v-if="currentId === ALL">
          <div class="flex flex-wrap items-start gap-2">
            <h2 class="m-0 text-lg font-bold text-ink flex-1 min-w-0">匯整檔（全部筆記）</h2>
            <el-button size="small" @click="download(null)"><Download :size="14" class="mr-1" />下載匯整 .md</el-button>
          </div>
          <p class="m-0 mt-1 text-xs text-dim">
            每次新增、修改、刪除筆記時自動重新產生，AI 問答與分析直接使用這份。{{ all?.count }} 則、{{ all?.chars.toLocaleString() }} 字，更新於 {{ all?.updated }}
            <span v-if="all && all.chars > all.limit" class="text-warn">（超過 {{ all.limit.toLocaleString() }} 字上限，問答時改為挑選相關筆記；可調高 server/.env 的 KB_MAX_CHARS）</span>
          </p>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <article class="ai-md mt-3" v-html="md(allText)" />
        </template>
        <p v-else-if="!current" class="py-12 text-center text-dim">選擇左邊的筆記查看內容</p>
        <template v-else>
          <div class="flex flex-wrap items-start gap-2">
            <h2 class="m-0 text-lg font-bold text-ink flex-1 min-w-0">{{ current.title }}</h2>
            <el-button size="small" @click="download(current)"><Download :size="14" class="mr-1" />下載 .md</el-button>
            <template v-if="admin">
              <el-button size="small" @click="openEdit(current)"><Pencil :size="14" class="mr-1" />修改</el-button>
              <el-button size="small" type="danger" plain @click="remove(current)"><Trash2 :size="14" class="mr-1" />刪除</el-button>
            </template>
          </div>
          <div class="flex flex-wrap gap-1.5 mt-2">
            <span v-for="ip in current.ips" :key="ip" class="status-pill status-run">{{ ip }}</span>
            <span v-for="t in current.tags" :key="t" class="status-pill status-done">{{ t }}</span>
          </div>
          <p class="m-0 mt-2 text-xs text-dim">
            {{ current.author }} 記錄於 {{ current.created }}<template v-if="current.updated !== current.created">，{{ current.updatedBy || current.author }} 修改於 {{ current.updated }}</template>
          </p>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <article class="ai-md mt-3" v-html="md(current.content)" />
          <div v-if="current.source && current.source !== current.content" class="mt-4 pt-3 border-t border-glow">
            <p class="m-0 text-xs text-dim">{{ current.tags.includes('自動學習') ? '資料來源' : '管理者原始說明' }}</p>
            <p class="m-0 mt-1 text-sm text-mute whitespace-pre-wrap">{{ current.source }}</p>
          </div>
        </template>
      </section>
    </div>

    <el-dialog v-model="learn.open" title="外部 IP 自動學習" width="min(680px, 96vw)">
      <p class="m-0 text-sm text-mute leading-relaxed">
        從最近幾天的防火牆 log 挑出外部 IP（10.10、172.16、172.20 與其他私有 IP 除外），查公開的 IP 註冊資料（RDAP）與 DNS 反查，知道它屬於誰（例如 Microsoft 365 寄信伺服器、HiNet、AWS），
        再由 10.10.130.45 的 AI 依組織 / 網段整理成筆記，標籤「自動學習」。查過的 IP 90 天內不重查；管理者手寫筆記已有的 IP 會略過。
        <template v-if="learn.st?.hour >= 0">每天 {{ learn.st.hour }} 點自動執行。</template>
      </p>
      <div v-if="learn.st" class="mt-3 grid grid-cols-3 gap-2 text-center">
        <div class="glass rounded-xl p-2"><p class="m-0 text-xl font-bold text-ink">{{ learn.st.learnedIps.toLocaleString() }}</p><p class="m-0 text-xs text-dim">已學過的 IP</p></div>
        <div class="glass rounded-xl p-2"><p class="m-0 text-xl font-bold text-ink">{{ learn.st.groups }}</p><p class="m-0 text-xs text-dim">組織 / 網段</p></div>
        <div class="glass rounded-xl p-2"><p class="m-0 text-xl font-bold text-ink">{{ learn.st.notes }}</p><p class="m-0 text-xs text-dim">知識庫筆記</p></div>
      </div>
      <p v-if="learn.st?.lastRun" class="m-0 mt-2 text-xs text-dim">
        上次：{{ learn.st.lastRun.at }}（{{ learn.st.lastRun.by }}）· {{ learn.st.lastRun.range }} 共 {{ learn.st.lastRun.candidates }} 個外部 IP，查了 {{ learn.st.lastRun.looked }} 個、寫入 / 更新 {{ learn.st.lastRun.notes }} 則筆記<template v-if="learn.st.lastRun.failed">、失敗 {{ learn.st.lastRun.failed }}</template>
      </p>
      <div v-if="learn.st?.busy || learn.st?.log?.length" class="mt-3">
        <el-progress v-if="learn.st.busy && learn.st.total" :percentage="Math.round((learn.st.done / learn.st.total) * 100)" :stroke-width="8" />
        <p class="m-0 mt-1 text-sm text-ink">{{ learn.st.phase }}</p>
        <pre class="m-0 mt-2 max-h-48 overflow-y-auto text-xs text-mute whitespace-pre-wrap">{{ learn.st.log.join('\n') }}</pre>
      </div>
      <p class="m-0 mt-3 text-xs text-dim">不直接抓 Google 搜尋結果（會被擋、也違反 Google 使用條款）；RDAP 是 IP 登記處官方的公開查詢服務。</p>
      <template #footer>
        <div v-if="admin" class="flex flex-wrap items-center justify-end gap-2">
          <span class="text-xs text-dim">最近</span>
          <el-input-number v-model="learn.days" :min="1" :max="60" size="small" controls-position="right" style="width: 90px" />
          <span class="text-xs text-dim">天、最多查</span>
          <el-input-number v-model="learn.max" :min="10" :max="500" :step="50" size="small" controls-position="right" style="width: 100px" />
          <span class="text-xs text-dim">個新 IP</span>
          <el-button type="primary" :loading="learn.st?.busy" @click="startLearn">{{ learn.st?.busy ? '學習中' : '立即學習' }}</el-button>
        </div>
        <span v-else class="text-xs text-dim">只有知識庫管理者可以執行</span>
      </template>
    </el-dialog>

    <el-dialog v-model="dialog.open" :title="dialog.id ? '修改筆記' : '新增筆記'" width="min(760px, 96vw)">
      <el-form label-position="top">
        <el-form-item label="標題"><el-input v-model="dialog.title" maxlength="120" placeholder="例如：10.10.130.154 是防毒伺服器（空白 = 取內容第一行）" /></el-form-item>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          <el-form-item label="相關 IP（逗號分隔，可寫網段 10.10.130.0/24）"><el-input v-model="dialog.ips" placeholder="空白 = 一般說明，所有問答都會參考" /></el-form-item>
          <el-form-item label="標籤（逗號分隔）"><el-input v-model="dialog.tags" /></el-form-item>
        </div>
        <el-form-item label="內容（Markdown）">
          <el-input v-model="dialog.content" type="textarea" :autosize="{ minRows: 8, maxRows: 20 }" maxlength="20000" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.open = false">取消</el-button>
        <el-button type="primary" :loading="dialog.saving" @click="save">儲存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.note-item {
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid transparent;
  cursor: pointer;
}
.note-item:hover {
  background: var(--color-brand-50);
}
.note-item.active {
  background: color-mix(in srgb, var(--color-brand-500) 14%, transparent);
  border-color: var(--color-glow);
}
.ai-md {
  color: var(--color-ink);
  font-size: 0.9rem;
  line-height: 1.75;
}
.ai-md :deep(h1),
.ai-md :deep(h2),
.ai-md :deep(h3) {
  font-size: 1rem;
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
