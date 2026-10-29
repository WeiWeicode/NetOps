<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { FolderDown, RefreshCw, CloudDownload, RotateCcw, Trash2, FileText, TriangleAlert } from 'lucide-vue-next'
import PageHeader from '../components/PageHeader.vue'
import http, { call } from '../api/http.js'
import { fmtBytes, fmtNum } from '../utils/format.js'

/**
 * AD FTP Log 檔案：FTP /AD_Log_Backup/yyyyMMdd/*.csv（DC 每天匯出）與匯入狀態
 * 同步 = 新的 / 有變動的日期才匯入；重新匯入 = 選取的日期一律重新讀取；刪除匯入結果 = 只刪本系統的資料，FTP 檔案不動
 */
const info = ref({ dir: '', days: [], job: null })
const loading = ref(false)
const busy = ref('')
const selected = ref([])

const STATES = {
  new: { label: '未匯入', cls: 'status-done' },
  changed: { label: '已變更', cls: 'status-wait' },
  done: { label: '已匯入', cls: 'status-run' },
  orphan: { label: 'FTP 上已無', cls: 'status-danger' },
}
const CHANNELS = { Security: '安全性', System: '系統', Directory_Service: '目錄服務', DNS_Server: 'DNS 伺服器' }

async function load() {
  loading.value = true
  const res = await call(http.get('/ad/browse', { timeout: 120000 }))
  loading.value = false
  if (res) info.value = res.data
}

const counts = computed(() => {
  const c = { days: info.value.days.length, files: 0, size: 0, done: 0, pending: 0 }
  for (const d of info.value.days) {
    c.files += d.files.length
    c.size += d.files.reduce((a, f) => a + f.size, 0)
    if (d.state === 'done') c.done++
    else c.pending++
  }
  return c
})

/** 各日期 Security 檔案都是空的 → 提醒（DC 的記錄被覆蓋或沒開稽核） */
const securityEmptyDays = computed(() =>
  info.value.days.filter((d) => d.state !== 'new' && d.files.some((f) => f.channel === 'Security') && d.files.filter((f) => f.channel === 'Security').every((f) => (f.rows ?? 0) === 0)).map((d) => d.day)
)

async function run(kind) {
  if (kind !== 'sync' && !selected.value.length) return ElMessage.warning('請勾選日期')
  const days = selected.value.map((d) => d.day)
  if (kind === 'forget') {
    try {
      await ElMessageBox.confirm(`刪除 ${days.join('、')} 的匯入結果？FTP 上的檔案不會刪除，之後同步會重新匯入。`, '刪除匯入結果', { type: 'warning', confirmButtonText: '刪除', cancelButtonText: '取消' })
    } catch {
      return
    }
  }
  busy.value = kind
  const req = { sync: () => http.post('/ad/sync', null, { timeout: 300000 }), import: () => http.post('/ad/import', { days }, { timeout: 300000 }), forget: () => http.post('/ad/forget', { days }) }[kind]
  const res = await call(req())
  busy.value = ''
  if (res) {
    ElMessage({ type: 'success', message: res.message })
    selected.value = []
    load()
  }
}

onMounted(load)
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <PageHeader title="AD FTP Log 檔案" :icon="FolderDown" :subtitle="info.dir ? `FTP ${info.dir}` : ''">
      <el-button :loading="loading" @click="load"><RefreshCw v-if="!loading" :size="16" class="mr-1" />重新整理</el-button>
      <el-button type="primary" :loading="busy === 'sync'" @click="run('sync')"><CloudDownload v-if="busy !== 'sync'" :size="16" class="mr-1" />同步新檔案</el-button>
    </PageHeader>

    <div v-if="securityEmptyDays.length" class="rounded-xl p-3 mb-3 text-sm bg-warn/10 border border-warn/40 text-ink flex gap-2">
      <TriangleAlert :size="18" class="text-warn shrink-0 mt-0.5" />
      <div>
        <b>{{ securityEmptyDays.join('、') }} 的 Security 檔案沒有事件。</b>
        通常是 DC 的 Security 記錄容量太小、前一天的事件在匯出前就被覆蓋；請看 DC 上 <code>C:\ADLogBackup\Backup-Execution.log</code> 的 WARN（v3 匯出程式會記錄最舊事件的時間），並加大 Security 記錄上限。
      </div>
    </div>

    <section class="glass rounded-2xl p-4 flex-1 min-h-[420px] flex flex-col">
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <el-button type="primary" plain :disabled="!selected.length" :loading="busy === 'import'" @click="run('import')">
          <RotateCcw v-if="busy !== 'import'" :size="14" class="mr-1" />重新匯入選取（{{ selected.length }}）
        </el-button>
        <el-button :disabled="!selected.length" :loading="busy === 'forget'" @click="run('forget')"><Trash2 v-if="busy !== 'forget'" :size="14" class="mr-1" />刪除匯入結果</el-button>
        <span class="ml-auto text-sm text-mute">
          {{ counts.days }} 天、{{ counts.files }} 個檔（{{ fmtBytes(counts.size) }}）·
          <span class="text-run">已匯入 {{ counts.done }}</span> · 未匯入 / 已變更 {{ counts.pending }}
        </span>
      </div>

      <el-table v-loading="loading" :data="info.days" row-key="day" size="small" height="100%" class="flex-1" empty-text="FTP 上沒有 AD log 資料夾"
        @selection-change="(v) => (selected = v)">
        <el-table-column type="selection" width="40" />
        <el-table-column type="expand">
          <template #default="{ row }">
            <el-table :data="row.files" size="small" class="ml-10 mr-4 my-2">
              <el-table-column label="檔案" min-width="260">
                <template #default="{ row: f }"><span class="inline-flex items-center gap-1.5"><FileText :size="14" />{{ f.name }}</span></template>
              </el-table-column>
              <el-table-column label="記錄" width="110"><template #default="{ row: f }">{{ CHANNELS[f.channel] ?? f.channel }}</template></el-table-column>
              <el-table-column label="大小" width="100" align="right"><template #default="{ row: f }">{{ fmtBytes(f.size) }}</template></el-table-column>
              <el-table-column label="修改時間" width="170"><template #default="{ row: f }">{{ f.modified ? new Date(f.modified).toLocaleString() : '' }}</template></el-table-column>
              <el-table-column label="事件數" width="100" align="right">
                <template #default="{ row: f }">
                  <span v-if="f.error" class="text-danger" :title="f.error">讀取失敗</span>
                  <span v-else-if="f.rows === 0 && f.channel === 'Security'" class="text-warn">0（空的）</span>
                  <span v-else>{{ f.rows == null ? '' : fmtNum(f.rows) }}</span>
                </template>
              </el-table-column>
            </el-table>
          </template>
        </el-table-column>
        <el-table-column prop="day" label="日期" width="120" />
        <el-table-column label="狀態" width="90">
          <template #default="{ row }"><span :class="['status-pill', STATES[row.state]?.cls]">{{ STATES[row.state]?.label }}</span></template>
        </el-table-column>
        <el-table-column label="檔案" min-width="280">
          <template #default="{ row }">
            <span class="text-mute text-xs">{{ row.files.map((f) => `${CHANNELS[f.channel] ?? f.channel}${f.rows == null ? '' : ` ${fmtNum(f.rows)}`}`).join('、') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="事件數" width="100" align="right"><template #default="{ row }">{{ row.events == null ? '' : fmtNum(row.events) }}</template></el-table-column>
        <el-table-column label="匯入時間" width="170"><template #default="{ row }">{{ row.importedAt ? new Date(row.importedAt).toLocaleString() : '' }}</template></el-table-column>
      </el-table>
    </section>
  </div>
</template>
