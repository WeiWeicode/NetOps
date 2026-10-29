<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ShieldAlert, RefreshCw, FolderDown, Bot } from 'lucide-vue-next'
import PageHeader from '../components/PageHeader.vue'
import TopList from '../components/TopList.vue'
import http, { call } from '../api/http.js'
import { fmtNum, fmtShort } from '../utils/format.js'

/**
 * 安全事件：PA-560 TRAFFIC 以外的 log（威脅、URL 過濾、資料過濾、WildFire、解密、GlobalProtect、User-ID）
 * 每種類型一個分頁：KPI、每小時事件數、排行；資料來自 FTP 各類型目錄，FTP Log 檔案頁同步分析後才有
 * 點排行中的 IP → 帶到 AI 問答詢問這個 IP
 */
const route = useRoute()
const router = useRouter()
const types = ref([]) // [{ type, label, dir, files, rows, days }]
const type = ref(String(route.query.type || 'threat'))
const range = ref([])
const data = ref(null)
const loading = ref(false)

const current = computed(() => types.value.find((t) => t.type === type.value))
const dayset = computed(() => new Set(current.value?.days ?? []))
const disabledDate = (d) => {
  const p = (x) => String(x).padStart(2, '0')
  return !dayset.value.has(`${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`)
}

// 排行的語氣（危險 / 注意）
const DANGER = new Set(['highName', 'extSrc', 'blockHost', 'blockSrc', 'failIp', 'failUser', 'error', 'bad'])
const WARN = new Set(['upload', 'upSrc', 'name', 'thrCategory'])
const tone = (k) => (DANGER.has(k) ? 'danger' : WARN.has(k) ? 'warn' : 'brand')
// KPI 值的顏色
const BAD_VALUES = /^(critical|high|failure|block|block-url|deny|drop|reset|Blocked|malware|phishing|grayware)/i

async function loadTypes() {
  const res = await call(http.get('/pa-events'))
  types.value = res?.data ?? []
  if (!current.value && types.value.length) type.value = types.value[0].type
  resetRange()
}

/** 換類型：預設該類型最新一天 */
function resetRange() {
  const d = current.value?.days?.[0]
  range.value = d ? [d, d] : []
  if (!d) data.value = null
}

async function load() {
  if (!range.value?.length) return
  loading.value = true
  const res = await call(http.get('/pa-events/summary', { params: { type: type.value, from: range.value[0], to: range.value[1], top: 15 } }))
  loading.value = false
  data.value = res?.data ?? null
}

watch(type, (t) => {
  router.replace({ query: { ...route.query, type: t } })
  resetRange()
})
watch(range, load)

/* 每小時事件數（簡單長條） */
const hourMax = computed(() => Math.max(1, ...(data.value?.hours ?? []).map((h) => h.n)))

/** 排行點選：內容含 IP 就帶到 AI 問答 */
function pick(key) {
  const ip = String(key).match(/(?:\d{1,3}\.){3}\d{1,3}/)?.[0]
  if (!ip) return
  router.push({ name: 'PaAsk', query: { q: `${ip} 在${current.value?.label ?? ''} log 的狀況，有沒有問題？`, from: range.value[0], to: range.value[1] } })
}

onMounted(loadTypes)
</script>

<template>
  <div v-loading="loading && !data">
    <PageHeader title="安全事件" :icon="ShieldAlert" :subtitle="data ? `${data.label}：${data.timeMin} ~ ${data.timeMax}，${data.files} 個 log 檔` : 'PA-560 威脅、URL、資料過濾、WildFire、解密、GlobalProtect、User-ID log'">
      <el-date-picker v-model="range" type="daterange" value-format="YYYY/MM/DD" range-separator="~" :clearable="false" :disabled-date="disabledDate"
        size="small" class="!w-60" placeholder="選擇日期" :disabled="!current?.days.length" />
      <el-button size="small" :loading="loading" @click="loadTypes"><RefreshCw v-if="!loading" :size="14" class="mr-1" />重新整理</el-button>
    </PageHeader>

    <el-segmented v-if="types.length" v-model="type" :options="types.map((t) => ({ label: `${t.label}${t.rows ? `（${fmtShort(t.rows)}）` : ''}`, value: t.type }))" class="mb-3 max-w-full overflow-x-auto" />

    <section v-if="current && !current.days.length && !loading" class="glass rounded-2xl p-10 text-center">
      <p class="m-0 text-lg text-ink font-semibold">還沒有{{ current.label }} log 的分析資料</p>
      <p class="m-0 mt-1 text-mute">FTP 目錄 {{ current.dir }}。到「FTP Log 檔案」按「同步新檔案」，系統會從 FTP 讀取並產生統計（原始 log 不存本機）。</p>
      <el-button type="primary" class="mt-4" @click="router.push({ name: 'FtpFiles', query: { path: current.dir } })"><FolderDown :size="16" class="mr-1" />前往 FTP Log 檔案</el-button>
    </section>

    <template v-if="data && current?.days.length">
      <!-- KPI -->
      <section class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-3">
        <div class="glass rounded-2xl p-4">
          <p class="m-0 text-sm text-mute">事件數</p>
          <p class="m-0 mt-1 text-3xl font-bold text-ink tabular-nums">{{ fmtShort(data.rows) }}</p>
          <p class="m-0 text-xs text-dim">{{ fmtNum(data.rows) }} 次（已乘上重複次數）</p>
        </div>
        <div v-for="k in data.kpis" :key="k.key" class="glass rounded-2xl p-4 min-w-0">
          <p class="m-0 text-sm text-mute">{{ k.title }}</p>
          <ul class="m-0 mt-1 p-0 list-none text-sm space-y-0.5">
            <li v-for="x in k.items.slice(0, 6)" :key="x.key" class="flex justify-between gap-2">
              <span class="truncate" :class="BAD_VALUES.test(x.key) ? 'text-danger font-semibold' : 'text-ink'">{{ x.key }}</span>
              <span class="tabular-nums text-mute">{{ fmtNum(x.n) }}</span>
            </li>
          </ul>
        </div>
      </section>

      <!-- 每小時 -->
      <section v-if="data.hours.length > 1" class="glass rounded-2xl p-4 mb-3">
        <h2 class="section-title !mb-2">每小時事件數</h2>
        <div class="hours">
          <div v-for="h in data.hours" :key="h.hour" class="bar-wrap" :title="`${h.hour} 時：${fmtNum(h.n)} 次`">
            <div class="bar" :style="{ height: `${(h.n / hourMax) * 100}%` }" />
          </div>
        </div>
        <div class="flex justify-between text-xs text-dim mt-1">
          <span>{{ data.hours[0].hour }} 時</span>
          <span>{{ data.hours.at(-1).hour }} 時</span>
        </div>
      </section>

      <!-- 排行 -->
      <section class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
        <TopList v-for="t in data.tops.filter((x) => x.items.length)" :key="t.key" :title="t.title" :items="t.items" :tone="tone(t.key)" @pick="pick" />
      </section>
      <p class="m-0 mt-3 text-xs text-dim"><Bot :size="12" class="inline -mt-0.5" /> 點排行中含 IP 的項目，會帶到 AI 問答查詢這個 IP（同時參考防火牆流量與這些 log）。</p>
    </template>
  </div>
</template>

<style scoped>
.hours {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 120px;
}
.bar-wrap {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
  min-width: 2px;
}
.bar {
  width: 100%;
  background: var(--color-brand-500);
  border-radius: 3px 3px 0 0;
  min-height: 1px;
}
.bar-wrap:hover .bar {
  background: var(--color-warn);
}
</style>
