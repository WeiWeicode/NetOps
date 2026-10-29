<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search, Download, Square, RotateCcw } from 'lucide-vue-next'
import PageHeader from '../components/PageHeader.vue'
import http, { call } from '../api/http.js'
import { actionLabel, actionPill, downloadCsv, FIELD_LABELS, fmtBytes, fmtNum } from '../utils/format.js'

/**
 * Log 明細查詢：依時間挑出對應的 log 檔，後端從 FTP 串流逐列篩選
 * 總覽頁點排行會帶 ?from=&to=&src=… 進來並自動查詢
 * IP 可輸入 10.10.124.18、10.10.124.*、10.10.0.0/16
 */
const route = useRoute()
const router = useRouter()
const FILTER_KEYS = ['src', 'dst', 'ip', 'port', 'proto', 'app', 'rule', 'action', 'fromZone', 'toZone', 'user', 'country', 'q']

const form = reactive({
  range: [],
  ...Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])),
})
const options = ref({ apps: [], rules: [], zones: [], actions: [] })
const result = ref(null)
const loading = ref(false)
const page = ref(1)
const PAGE_SIZE = 100
let controller = null

const pad = (x) => String(x).padStart(2, '0')
const fmt = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`

async function loadOptions() {
  const day = form.range[0]?.slice(0, 10)
  if (!day) return
  const res = await call(http.get('/palog/options', { params: { from: day, to: form.range[1]?.slice(0, 10) || day } }), { silent: true })
  if (res) options.value = res.data
}

async function search() {
  if (!form.range?.length) return ElMessage.warning('請選擇查詢時間')
  const params = Object.fromEntries(FILTER_KEYS.filter((k) => String(form[k]).trim()).map((k) => [k, String(form[k]).trim()]))
  router.replace({ query: { from: form.range[0], to: form.range[1], ...params } })
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  page.value = 1
  try {
    const res = await http.post('/palog/search', { from: form.range[0], to: form.range[1], ...params }, { timeout: 300000, signal: controller.signal })
    result.value = res.data
  } catch (err) {
    // 按「停止」中斷的不顯示錯誤
    if (!controller.signal.aborted) ElMessage.error(err.message)
  } finally {
    loading.value = false
  }
}

function stop() {
  controller?.abort()
  loading.value = false
}

function reset() {
  for (const k of FILTER_KEYS) form[k] = ''
}

const records = computed(() => {
  const r = result.value
  if (!r) return []
  return r.rows.map((row, i) => Object.fromEntries([['_i', i], ...r.fields.map((f, j) => [f, row[j]])]))
})
const pageRows = computed(() => records.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))

const stopText = computed(() => {
  const r = result.value
  if (!r) return ''
  if (r.stopReason === 'limit') return `已達上限 ${fmtNum(r.limit)} 筆，後面還有資料，請縮小時間或加條件`
  if (r.stopReason === 'timeout') return `掃描超過時間上限，只查了 ${r.filesScanned} / ${r.files} 個檔案，請縮小時間或加條件`
  return ''
})

function exportCsv() {
  const r = result.value
  if (!r?.rows.length) return
  downloadCsv(`PA_log_${r.from.replace(/\D/g, '')}_${r.to.replace(/\D/g, '')}.csv`, r.fields.map((f) => FIELD_LABELS[f] ?? f), r.rows)
}

onMounted(() => {
  const q = route.query
  for (const k of FILTER_KEYS) if (q[k]) form[k] = String(q[k])
  if (q.from && q.to) {
    form.range = [String(q.from), String(q.to)]
    loadOptions()
    search()
  } else {
    // 預設：最新一天有資料的最後一小時
    call(http.get('/palog/days'), { silent: true }).then((res) => {
      const day = res?.data.days?.[0]?.day
      if (!day) return
      const end = new Date(`${day.replace(/\//g, '-')}T23:59:00`)
      form.range = [fmt(new Date(end.getTime() - 59 * 60000)), fmt(end)]
      loadOptions()
    })
  }
})
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <PageHeader title="Log 明細查詢" :icon="Search" subtitle="從 FTP 即時讀取；時間越短、條件越多越快" />

    <section class="glass rounded-2xl p-4 mb-3">
      <el-form inline class="!-mb-[18px]" @submit.prevent="search">
        <el-form-item label="時間">
          <el-date-picker v-model="form.range" type="datetimerange" value-format="YYYY/MM/DD HH:mm" format="YYYY/MM/DD HH:mm" range-separator="~"
            :clearable="false" class="!w-[340px]" @change="loadOptions" />
        </el-form-item>
        <el-form-item label="來源 IP"><el-input v-model="form.src" placeholder="10.10.124.* 或 /16" clearable class="!w-44" /></el-form-item>
        <el-form-item label="目的 IP"><el-input v-model="form.dst" clearable class="!w-44" /></el-form-item>
        <el-form-item label="任一方 IP"><el-input v-model="form.ip" clearable class="!w-40" /></el-form-item>
        <el-form-item label="目的 Port"><el-input v-model="form.port" placeholder="443,3389" clearable class="!w-28" /></el-form-item>
        <el-form-item label="協定">
          <el-select v-model="form.proto" clearable placeholder="全部" class="!w-24">
            <el-option label="tcp" value="tcp" /><el-option label="udp" value="udp" /><el-option label="icmp" value="icmp" />
          </el-select>
        </el-form-item>
        <el-form-item label="動作">
          <el-select v-model="form.action" clearable placeholder="全部" class="!w-36">
            <el-option label="允許" value="allow" />
            <el-option label="阻擋（全部）" value="block" />
            <el-option v-for="a in options.actions.filter((x) => x !== 'allow')" :key="a" :label="`${actionLabel(a)}（${a}）`" :value="a" />
          </el-select>
        </el-form-item>
        <el-form-item label="應用程式">
          <el-select v-model="form.app" filterable allow-create clearable placeholder="全部" class="!w-44">
            <el-option v-for="a in options.apps" :key="a" :label="a" :value="a" />
          </el-select>
        </el-form-item>
        <el-form-item label="規則">
          <el-select v-model="form.rule" filterable allow-create clearable placeholder="全部" class="!w-48">
            <el-option v-for="a in options.rules" :key="a" :label="a" :value="a" />
          </el-select>
        </el-form-item>
        <el-form-item label="區域">
          <el-select v-model="form.fromZone" clearable placeholder="來源" class="!w-28">
            <el-option v-for="z in options.zones" :key="z" :label="z" :value="z" />
          </el-select>
          <span class="mx-1 text-dim">→</span>
          <el-select v-model="form.toZone" clearable placeholder="目的" class="!w-28">
            <el-option v-for="z in options.zones" :key="z" :label="z" :value="z" />
          </el-select>
        </el-form-item>
        <el-form-item label="使用者"><el-input v-model="form.user" clearable class="!w-32" /></el-form-item>
        <el-form-item label="國家"><el-input v-model="form.country" placeholder="China" clearable class="!w-32" /></el-form-item>
        <el-form-item label="關鍵字"><el-input v-model="form.q" placeholder="整列文字包含" clearable class="!w-40" /></el-form-item>
        <el-form-item>
          <el-button v-if="!loading" type="primary" native-type="submit"><Search :size="16" class="mr-1" />查詢</el-button>
          <el-button v-else type="danger" plain @click="stop"><Square :size="14" class="mr-1" />停止</el-button>
          <el-button @click="reset"><RotateCcw :size="14" class="mr-1" />清除條件</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section class="glass rounded-2xl p-4 flex-1 min-h-[460px] flex flex-col">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-mute mb-2">
        <template v-if="result">
          <span class="text-ink font-semibold">符合 {{ fmtNum(result.rows.length) }} 筆</span>
          <span>掃描 {{ fmtNum(result.scanned) }} 列 · {{ result.filesScanned }} / {{ result.files }} 個檔案 · {{ result.seconds }} 秒</span>
          <span v-if="stopText" class="text-warn">{{ stopText }}</span>
        </template>
        <span v-else-if="!loading" class="text-dim">選擇時間與條件後按「查詢」</span>
        <span v-if="loading" class="text-brand-500">從 FTP 讀取中…（一個 log 檔約 6.5 萬列、2 秒）</span>
        <el-button v-if="result?.rows.length" size="small" class="ml-auto" @click="exportCsv"><Download :size="14" class="mr-1" />匯出 CSV</el-button>
      </div>

      <el-table v-loading="loading" :data="pageRows" row-key="_i" size="small" height="100%" class="flex-1 nowrap-table" empty-text="沒有符合的紀錄">
        <el-table-column type="expand">
          <template #default="{ row }">
            <dl class="detail">
              <template v-for="(label, k) in FIELD_LABELS" :key="k">
                <template v-if="row[k] !== '' && row[k] !== 0">
                  <dt>{{ label }}</dt>
                  <dd>{{ ['bytes', 'sent', 'recv'].includes(k) ? `${fmtBytes(row[k])}（${fmtNum(row[k])}）` : row[k] }}</dd>
                </template>
              </template>
            </dl>
          </template>
        </el-table-column>
        <el-table-column prop="time" label="時間" width="150" />
        <el-table-column label="動作" width="96">
          <template #default="{ row }"><span :class="['status-pill', actionPill(row.action)]">{{ actionLabel(row.action) }}</span></template>
        </el-table-column>
        <el-table-column prop="src" label="來源 IP" width="130" />
        <el-table-column prop="dst" label="目的 IP" width="130" />
        <el-table-column label="Port" width="90">
          <template #default="{ row }">{{ row.proto }}/{{ row.dport }}</template>
        </el-table-column>
        <el-table-column prop="app" label="應用程式" min-width="130" show-overflow-tooltip />
        <el-table-column prop="rule" label="規則" min-width="150" show-overflow-tooltip />
        <el-table-column label="區域" width="150">
          <template #default="{ row }">{{ row.fromZone }} → {{ row.toZone }}</template>
        </el-table-column>
        <el-table-column prop="srcUser" label="使用者" width="120" show-overflow-tooltip />
        <el-table-column label="流量" width="90" align="right">
          <template #default="{ row }">{{ fmtBytes(row.bytes) }}</template>
        </el-table-column>
        <el-table-column prop="dstCountry" label="目的國家" width="130" show-overflow-tooltip />
        <el-table-column prop="endReason" label="結束原因" width="120" show-overflow-tooltip />
      </el-table>
      <el-pagination v-if="records.length > PAGE_SIZE" v-model:current-page="page" :page-size="PAGE_SIZE" :total="records.length" layout="total, prev, pager, next" small class="mt-2 justify-end" />
    </section>
  </div>
</template>

<style scoped>
.detail {
  display: grid;
  grid-template-columns: max-content 1fr max-content 1fr max-content 1fr;
  gap: 2px 12px;
  margin: 0;
  padding: 6px 40px;
  font-size: calc(0.8125rem * var(--font-scale));
}
.detail dt {
  color: var(--color-dim);
}
.detail dd {
  margin: 0;
  color: var(--color-ink);
  word-break: break-all;
}
@media (max-width: 900px) {
  .detail {
    grid-template-columns: max-content 1fr;
  }
}
</style>
