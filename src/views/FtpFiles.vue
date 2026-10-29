<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { FolderDown, Folder, FileText, RefreshCw, CloudDownload, Play, Trash2, Square, ChevronRight, ChevronLeft, Home } from 'lucide-vue-next'
import PageHeader from '../components/PageHeader.vue'
import http, { call } from '../api/http.js'
import { fmtBytes, fmtNum } from '../utils/format.js'

/**
 * FTP Log 檔案：瀏覽 FTP、把 PA log 加入分析（串流讀取、只存摘要），看分析進度
 * 「同步」= server/.env 的 FTP_LOG_DIR 裡符合 FTP_PATTERN 的新檔 / 已變更檔
 * 檔案依日期分組（每天約 100 個檔），預設顯示最新一天；可切換日期或選「全部日期」
 * 上方按鈕切換 log 類型的目錄：TRAFFIC（FTP_LOG_DIR）與威脅、URL、資料過濾、WildFire、解密、GlobalProtect、User-ID
 * 「同步新檔案」一次同步全部類型；?path= 可直接開某個目錄
 */
const route = useRoute()
const dir = ref('')
const info = ref({ root: '/', logDir: '/', pattern: '', eventDirs: [] })
/** log 類型的目錄按鈕 */
const typeDirs = computed(() => [{ type: '', label: 'TRAFFIC 流量', dir: info.value.logDir }, ...(info.value.eventDirs ?? [])])
const items = ref([])
const loading = ref(false)
const selected = ref([])
const keyword = ref('')
const stateFilter = ref('')
const day = ref('') // 選的日期；'' = 全部日期
const job = ref(null)
let timer = null

const STATES = {
  new: { label: '未分析', cls: 'status-done' },
  changed: { label: '已變更', cls: 'status-wait' },
  queued: { label: '排隊中', cls: 'status-wait' },
  running: { label: '分析中', cls: 'status-run' },
  done: { label: '已分析', cls: 'status-run' },
  error: { label: '失敗', cls: 'status-danger' },
}

async function load(path = dir.value) {
  loading.value = true
  const res = await call(http.get('/ftp/browse', { params: { path }, timeout: 60000 }))
  loading.value = false
  if (!res) return
  const changedDir = dir.value !== res.data.path
  dir.value = res.data.path
  info.value = res.data
  items.value = res.data.items
  selected.value = []
  // 第一次載入或換目錄：預設最新一天；原本選的日期不見了也改回最新一天
  if (changedDir || (day.value && !days.value.some((d) => d.day === day.value))) day.value = days.value[0]?.day ?? ''
}

const crumbs = computed(() => {
  const parts = dir.value.split('/').filter(Boolean)
  return [{ name: '/', path: '/' }, ...parts.map((p, i) => ({ name: p, path: '/' + parts.slice(0, i + 1).join('/') }))]
})

/**
 * 檔案的日期：已分析的用資料時間（f.day）；未分析的從檔名推算
 * PA 匯出檔名是匯出日（PA-560_traffic_2026_10_16_last_calendar_day_0.csv = 10/15 的資料），last_calendar_day 往前一天
 */
function dayOf(f) {
  if (f.dir) return ''
  if (f.day) return f.day
  const m = f.name.match(/(\d{4})[_-](\d{2})[_-](\d{2})/)
  if (!m) return '（無日期）'
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (/last_calendar_day/i.test(f.name)) d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/** 日期清單（新的在前）：{ day, files, done, size } */
const days = computed(() => {
  const map = new Map()
  for (const f of items.value) {
    if (f.dir || !f.isLog) continue
    const d = dayOf(f)
    const v = map.get(d) ?? { day: d, files: 0, done: 0, size: 0 }
    v.files++
    v.size += f.size
    if (f.state === 'done') v.done++
    map.set(d, v)
  }
  return [...map.values()].sort((a, b) => b.day.localeCompare(a.day))
})
const dayIndex = computed(() => days.value.findIndex((d) => d.day === day.value))
/** 往前 / 往後一天（step = 1 是較舊的一天） */
function moveDay(step) {
  const d = days.value[dayIndex.value + step]
  if (d) day.value = d.day
}

const rows = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return items.value.filter(
    (f) => (f.dir || !day.value || dayOf(f) === day.value) && (!k || f.name.toLowerCase().includes(k)) && (!stateFilter.value || (!f.dir && f.state === stateFilter.value))
  )
})

const counts = computed(() => {
  const c = { files: 0, size: 0, done: 0, pending: 0, error: 0 }
  for (const f of items.value) {
    if (!f.isLog) continue
    c.files++
    c.size += f.size
    if (f.state === 'done') c.done++
    else if (f.state === 'error') c.error++
    else c.pending++
  }
  return c
})

const canSelect = (row) => row.isLog

function open(row) {
  if (row.dir) load(row.path)
}

async function analyze(list) {
  if (!list.length) return ElMessage.warning('請勾選要分析的檔案')
  const res = await call(http.post('/ftp/analyze', { items: list.map((f) => ({ path: f.path, size: f.size, modified: f.modified })) }))
  if (res) {
    ElMessage.success(res.message)
    poll()
  }
}

async function sync() {
  const res = await call(http.post('/ftp/sync', null, { timeout: 60000 }))
  if (res) {
    ElMessage({ type: res.data.added ? 'success' : 'info', message: res.message })
    poll()
  }
}

async function forget() {
  const list = selected.value.filter((f) => f.state === 'done' || f.state === 'error')
  if (!list.length) return ElMessage.warning('請勾選已分析的檔案')
  try {
    await ElMessageBox.confirm(`刪除 ${list.length} 個檔案的分析結果？總覽與查詢將不再包含這些檔案（FTP 上的檔案不會刪除）。`, '刪除分析結果', { type: 'warning', confirmButtonText: '刪除', cancelButtonText: '取消' })
  } catch {
    return
  }
  const res = await call(http.post('/ftp/forget', { paths: list.map((f) => f.path) }))
  if (res) {
    ElMessage.success(res.message)
    load()
  }
}

async function cancel() {
  const res = await call(http.post('/ftp/cancel'))
  if (res) ElMessage.info(res.message)
  poll()
}

/** 分析進行中每 2 秒更新進度，結束時重新載入清單 */
async function poll() {
  clearTimeout(timer)
  const res = await call(http.get('/ftp/status'), { silent: true })
  const wasBusy = job.value?.busy
  job.value = res?.data ?? null
  if (job.value?.busy || job.value?.events?.busy) {
    timer = setTimeout(poll, 2000)
    if (!wasBusy) load()
  } else if (wasBusy) load()
}

const pct = (j) => (j?.total ? Math.round(((j.done + j.failed) / j.total) * 100) : 0)
const progress = computed(() => pct(job.value))
/** 兩個匯入程式（TRAFFIC、其他類型）任一還在跑 */
const anyBusy = computed(() => Boolean(job.value?.busy || job.value?.events?.busy))

onMounted(() => {
  load(route.query.path ? String(route.query.path) : '')
  poll()
})
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <PageHeader title="FTP Log 檔案" :icon="FolderDown" :subtitle="`同步目錄 ${info.logDir}`">
      <el-button :loading="loading" @click="load()"><RefreshCw v-if="!loading" :size="16" class="mr-1" />重新整理</el-button>
      <el-button type="primary" @click="sync"><CloudDownload :size="16" class="mr-1" />同步新檔案</el-button>
    </PageHeader>

    <!-- 分析進度 -->
    <section v-if="job && (anyBusy || job.total || job.events?.total)" class="glass rounded-2xl p-4 mb-3">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span class="font-semibold text-ink">{{ job.busy ? '分析中' : '上次分析完成' }}</span>
        <span class="text-mute">完成 {{ job.done }} / {{ job.total }}</span>
        <span v-if="job.failed" class="text-danger">失敗 {{ job.failed }}</span>
        <span v-if="job.busy" class="text-mute">排隊 {{ job.queued }}</span>
        <span v-if="!job.busy && job.finishedAt" class="text-dim">{{ new Date(job.finishedAt).toLocaleString() }}</span>
        <el-button v-if="anyBusy" size="small" class="ml-auto" @click="cancel"><Square :size="14" class="mr-1" />取消</el-button>
      </div>
      <el-progress :percentage="progress" :stroke-width="10" class="mt-2" :status="job.busy ? '' : job.failed ? 'warning' : 'success'" />
      <!-- 其他類型 log（威脅、URL…）的分析進度 -->
      <div v-if="job.events?.total" class="mt-3 text-sm">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span class="font-semibold text-ink">威脅 / URL / VPN 等 log</span>
          <span class="text-mute">完成 {{ job.events.done }} / {{ job.events.total }}</span>
          <span v-if="job.events.failed" class="text-danger">失敗 {{ job.events.failed }}</span>
          <span v-if="job.events.busy" class="text-mute">排隊 {{ job.events.queued }}</span>
          <span v-for="r in job.events.running" :key="r.path" class="text-xs text-mute truncate max-w-[420px]">{{ r.name }}（{{ fmtBytes(r.read) }} / {{ fmtBytes(r.size) }}）</span>
        </div>
        <el-progress :percentage="pct(job.events)" :stroke-width="6" class="mt-1" :status="job.events.busy ? '' : job.events.failed ? 'warning' : 'success'" />
      </div>
      <ul v-if="job.running.length" class="m-0 mt-2 p-0 list-none space-y-1 text-xs text-mute">
        <li v-for="r in job.running" :key="r.path" class="flex flex-wrap gap-x-3">
          <span class="text-ink truncate max-w-[480px]">{{ r.name }}</span>
          <span>{{ fmtBytes(r.read) }} / {{ fmtBytes(r.size) }}</span>
          <span>{{ fmtNum(r.rows) }} 列</span>
          <span>{{ r.seconds }} 秒</span>
        </li>
      </ul>
    </section>

    <section class="glass rounded-2xl p-4 flex-1 min-h-[460px] flex flex-col">
      <!-- log 類型 -->
      <div class="flex flex-wrap gap-1.5 mb-2">
        <el-button v-for="t in typeDirs" :key="t.dir" size="small" round :type="dir === t.dir ? 'primary' : 'default'" :plain="dir !== t.dir" @click="load(t.dir)">{{ t.label }}</el-button>
      </div>
      <!-- 路徑 -->
      <nav class="flex flex-wrap items-center gap-1 text-sm mb-2" aria-label="FTP 路徑">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <ChevronRight v-if="i > 0" :size="14" class="text-dim" />
          <el-button link :type="i === crumbs.length - 1 ? 'primary' : 'default'" @click="load(c.path)">
            <Home v-if="i === 0" :size="14" class="mr-1" />{{ i === 0 ? 'FTP 根目錄' : c.name }}
          </el-button>
        </template>
      </nav>

      <div class="flex flex-wrap items-center gap-2 mb-2">
        <div v-if="days.length" class="flex items-center gap-1">
          <el-button :disabled="!day || dayIndex >= days.length - 1" title="前一天" @click="moveDay(1)"><ChevronLeft :size="16" /></el-button>
          <el-select v-model="day" placeholder="全部日期" class="!w-64" filterable>
            <el-option label="全部日期" value="" />
            <el-option v-for="d in days" :key="d.day" :label="d.day" :value="d.day">
              <span>{{ d.day }}</span>
              <span class="float-right text-xs text-dim">{{ d.files }} 檔 · 已分析 {{ d.done }}</span>
            </el-option>
          </el-select>
          <el-button :disabled="!day || dayIndex <= 0" title="後一天" @click="moveDay(-1)"><ChevronRight :size="16" /></el-button>
        </div>
        <el-input v-model="keyword" placeholder="篩選檔名" clearable class="!w-60" />
        <el-select v-model="stateFilter" placeholder="全部狀態" clearable class="!w-32">
          <el-option v-for="(s, k) in STATES" :key="k" :label="s.label" :value="k" />
        </el-select>
        <el-button type="primary" plain :disabled="!selected.length" @click="analyze(selected)"><Play :size="14" class="mr-1" />分析選取（{{ selected.length }}）</el-button>
        <el-button :disabled="!selected.length" @click="forget"><Trash2 :size="14" class="mr-1" />刪除分析結果</el-button>
        <span class="ml-auto text-sm text-mute">
          <template v-if="day">本日 {{ rows.filter((f) => f.isLog).length }} 個 · </template>{{ days.length }} 天 · log 檔 {{ counts.files }} 個（{{ fmtBytes(counts.size) }}）·
          <span class="text-run">已分析 {{ counts.done }}</span> ·
          <span>未分析 {{ counts.pending }}</span>
          <span v-if="counts.error" class="text-danger"> · 失敗 {{ counts.error }}</span>
        </span>
      </div>

      <el-table v-loading="loading" :data="rows" row-key="path" size="small" height="100%" class="flex-1" empty-text="這個目錄沒有檔案"
        @selection-change="(v) => (selected = v)" @row-dblclick="open">
        <el-table-column type="selection" width="40" :selectable="canSelect" reserve-selection />
        <el-table-column label="名稱" min-width="320">
          <template #default="{ row }">
            <button v-if="row.dir" type="button" class="inline-flex items-center gap-1.5 text-ink hover:text-brand-500" @click="open(row)">
              <Folder :size="16" class="text-warn shrink-0" />{{ row.name }}
            </button>
            <span v-else class="inline-flex items-center gap-1.5" :class="row.isLog ? 'text-ink' : 'text-dim'">
              <FileText :size="16" class="shrink-0" />{{ row.name }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="100" align="right">
          <template #default="{ row }">{{ row.dir ? '' : fmtBytes(row.size) }}</template>
        </el-table-column>
        <el-table-column label="修改時間" width="160">
          <template #default="{ row }">{{ row.modified ? new Date(row.modified).toLocaleString() : '' }}</template>
        </el-table-column>
        <el-table-column label="狀態" width="90">
          <template #default="{ row }">
            <span v-if="row.isLog" :class="['status-pill', STATES[row.state]?.cls]" :title="row.error || undefined">{{ STATES[row.state]?.label }}</span>
          </template>
        </el-table-column>
        <el-table-column label="資料時間" min-width="220">
          <template #default="{ row }">
            <span v-if="row.timeMin" class="tabular-nums">{{ row.timeMin }} ~ {{ row.timeMax.slice(11) }}</span>
            <span v-else-if="row.error" class="text-danger text-xs">{{ row.error }}</span>
          </template>
        </el-table-column>
        <el-table-column label="筆數" width="100" align="right">
          <template #default="{ row }">{{ row.rows == null ? '' : fmtNum(row.rows) }}</template>
        </el-table-column>
        <el-table-column label="耗時" width="70" align="right">
          <template #default="{ row }">{{ row.ms == null ? '' : `${(row.ms / 1000).toFixed(1)}s` }}</template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>
