<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search, Download, RotateCcw } from 'lucide-vue-next'
import PageHeader from '../components/PageHeader.vue'
import http, { call } from '../api/http.js'
import { downloadCsv, fmtNum } from '../utils/format.js'

/**
 * AD Log 明細查詢：已匯入的 AD 事件（uploads/adlogs），依時間與條件篩選，可匯出 CSV
 * AD 事件總覽點一列會帶 ?from=&to=&channel=&eventId=… 進來並自動查詢
 */
const route = useRoute()
const router = useRouter()
const KEYS = ['channel', 'level', 'eventId', 'account', 'ip', 'q']
const form = reactive({ range: [], issueOnly: false, ...Object.fromEntries(KEYS.map((k) => [k, ''])) })
const meta = ref({ channels: {}, securityEvents: {} })
const result = ref(null) // { total, scanned, rows, limited }
const loading = ref(false)
const page = ref(1)
const PAGE = 100

const LEVELS = {
  critical: { label: '重大', cls: 'status-danger' },
  error: { label: '錯誤', cls: 'status-danger' },
  warning: { label: '警告', cls: 'status-wait' },
  audit_failure: { label: '稽核失敗', cls: 'status-danger' },
  audit_success: { label: '稽核成功', cls: 'status-run' },
  info: { label: '資訊', cls: 'status-done' },
}
const chName = (c) => meta.value.channels[c] ?? c
const evName = (e) => (e.channel === 'Security' ? meta.value.securityEvents[e.eventId] : '') || ''

async function search() {
  if (!form.range?.length) return ElMessage.warning('請選擇時間')
  const params = { from: form.range[0], to: form.range[1], issueOnly: form.issueOnly ? '1' : '', ...Object.fromEntries(KEYS.filter((k) => String(form[k]).trim()).map((k) => [k, String(form[k]).trim()])) }
  router.replace({ query: { ...params, issueOnly: params.issueOnly || undefined } })
  loading.value = true
  page.value = 1
  const res = await call(http.get('/ad/events', { params: { ...params, limit: 5000 } }))
  loading.value = false
  result.value = res?.data ?? null
}

function reset() {
  for (const k of KEYS) form[k] = ''
  form.issueOnly = false
}

const pageRows = computed(() => (result.value?.rows ?? []).slice((page.value - 1) * PAGE, page.value * PAGE))

function exportCsv() {
  const rows = result.value?.rows ?? []
  if (!rows.length) return
  downloadCsv(
    `AD_log_${form.range[0].replace(/\D/g, '')}_${form.range[1].replace(/\D/g, '')}.csv`,
    ['時間', '記錄', '事件 ID', '等級', '來源', '主機', '帳號', '執行者', '對象', '群組', '來源 IP', '工作站', '原因', '訊息'],
    rows.map((e) => [e.time, chName(e.channel), e.eventId, LEVELS[e.level]?.label ?? e.level, e.provider, e.computer, e.account ?? '', e.actor ?? '', e.target ?? '', e.group ?? '', e.ip ?? '', e.workstation ?? '', e.reason ?? '', e.message])
  )
}

const pad = (x) => String(x).padStart(2, '0')
onMounted(async () => {
  const res = await call(http.get('/ad/days'))
  if (res) meta.value = res.data
  const q = route.query
  for (const k of KEYS) if (q[k]) form[k] = String(q[k])
  form.issueOnly = q.issueOnly === '1'
  // 只有日期時補上 00:00 / 23:59
  const at = (v, end) => (String(v).length <= 10 ? `${v} ${end ? '23:59' : '00:00'}` : String(v))
  if (q.from) {
    form.range = [at(q.from, false), at(q.to || q.from, true)]
    search()
  } else {
    const day = res?.data.days?.[0]?.day
    if (day) form.range = [`${day} 00:00`, `${day} 23:59`]
  }
})
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <PageHeader title="AD Log 明細查詢" :icon="Search" subtitle="已匯入的 AD 事件記錄（Security / System / 目錄服務 / DNS）" />

    <section class="glass rounded-2xl p-4 mb-3">
      <el-form inline class="!-mb-[18px]" @submit.prevent="search">
        <el-form-item label="時間">
          <el-date-picker v-model="form.range" type="datetimerange" value-format="YYYY/MM/DD HH:mm" format="YYYY/MM/DD HH:mm" range-separator="~" :clearable="false" class="!w-[340px]" />
        </el-form-item>
        <el-form-item label="記錄">
          <el-select v-model="form.channel" clearable placeholder="全部" class="!w-32">
            <el-option v-for="(n, c) in meta.channels" :key="c" :label="n" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="等級">
          <el-select v-model="form.level" clearable placeholder="全部" class="!w-28">
            <el-option v-for="(l, k) in LEVELS" :key="k" :label="l.label" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item label="事件 ID"><el-input v-model="form.eventId" placeholder="4625,4740" clearable class="!w-32" /></el-form-item>
        <el-form-item label="帳號"><el-input v-model="form.account" placeholder="S094009" clearable class="!w-32" /></el-form-item>
        <el-form-item label="IP"><el-input v-model="form.ip" clearable class="!w-36" /></el-form-item>
        <el-form-item label="關鍵字"><el-input v-model="form.q" placeholder="訊息內容" clearable class="!w-40" /></el-form-item>
        <el-form-item><el-checkbox v-model="form.issueOnly">只看需要注意的</el-checkbox></el-form-item>
        <el-form-item>
          <el-button type="primary" native-type="submit" :loading="loading"><Search v-if="!loading" :size="15" class="mr-1" />查詢</el-button>
          <el-button @click="reset"><RotateCcw :size="14" class="mr-1" />清除條件</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section class="glass rounded-2xl p-4 flex-1 min-h-[460px] flex flex-col">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-mute mb-2">
        <template v-if="result">
          <span class="text-ink font-semibold">符合 {{ fmtNum(result.total) }} 筆</span>
          <span>共 {{ fmtNum(result.scanned) }} 筆</span>
          <span v-if="result.limited" class="text-warn">只顯示前 {{ fmtNum(result.rows.length) }} 筆，請縮小時間或加條件</span>
        </template>
        <span v-else class="text-dim">選擇時間與條件後按「查詢」</span>
        <el-button v-if="result?.rows.length" size="small" class="ml-auto" @click="exportCsv"><Download :size="14" class="mr-1" />匯出 CSV</el-button>
      </div>
      <el-table v-loading="loading" :data="pageRows" :row-key="(r) => `${r.computer}|${r.channel}|${r.recordId}`" size="small" height="100%" class="flex-1" empty-text="沒有符合的事件">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="px-10 py-2 text-sm space-y-1">
              <p class="m-0 text-xs text-dim">{{ row.provider }} · {{ row.computer }} · 記錄編號 {{ row.recordId }}</p>
              <p v-if="row.actor || row.target || row.group || row.ip" class="m-0 text-xs text-mute">
                <template v-if="row.actor">執行者 {{ row.actor }}　</template>
                <template v-if="row.target">對象 {{ row.target }}　</template>
                <template v-if="row.group">群組 {{ row.group }}<b v-if="row.privileged" class="text-danger">（特權）</b>　</template>
                <template v-if="row.ip">來源 IP {{ row.ip }}　</template>
                <template v-if="row.workstation">工作站 {{ row.workstation }}　</template>
                <template v-if="row.reason">原因 {{ row.reason }}</template>
              </p>
              <pre class="ad-msg">{{ row.message }}</pre>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="time" label="時間" width="150" />
        <el-table-column label="記錄" width="96"><template #default="{ row }">{{ chName(row.channel) }}</template></el-table-column>
        <el-table-column label="事件" width="150"><template #default="{ row }">{{ row.eventId }}<span v-if="evName(row)" class="text-mute"> {{ evName(row) }}</span></template></el-table-column>
        <el-table-column label="等級" width="80"><template #default="{ row }"><span :class="['status-pill', LEVELS[row.level]?.cls]">{{ LEVELS[row.level]?.label }}</span></template></el-table-column>
        <el-table-column label="帳號 / IP" width="180" show-overflow-tooltip>
          <template #default="{ row }"><span v-if="row.privileged" class="status-pill status-danger mr-1">特權</span>{{ [row.account, row.ip].filter(Boolean).join(' / ') }}</template>
        </el-table-column>
        <el-table-column label="訊息" min-width="320" show-overflow-tooltip><template #default="{ row }">{{ row.message.split('\n')[0] }}</template></el-table-column>
      </el-table>
      <el-pagination v-if="(result?.rows.length ?? 0) > PAGE" v-model:current-page="page" :page-size="PAGE" :total="result.rows.length" layout="total, prev, pager, next" small class="mt-2 justify-end" />
    </section>
  </div>
</template>

<style scoped>
.ad-msg {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: calc(0.8125rem * var(--font-scale));
  color: var(--color-ink);
  background: var(--color-brand-50);
  border-radius: 8px;
  padding: 8px 10px;
  max-height: 360px;
  overflow: auto;
}
</style>
