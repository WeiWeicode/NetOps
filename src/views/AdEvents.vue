<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Network, RefreshCw, CloudDownload, TriangleAlert } from 'lucide-vue-next'
import PageHeader from '../components/PageHeader.vue'
import http, { call } from '../api/http.js'
import { fmtNum } from '../utils/format.js'

/**
 * AD 事件總覽：DC 每天匯出到 FTP /AD_Log_Backup/yyyyMMdd/*.csv（Security / System / Directory_Service / DNS_Server）
 * 統計、帳號與特權異動、需要注意的事件；點一列帶條件到「Log 明細查詢」（AdSearch）
 */
const router = useRouter()
const days = ref([])
const meta = ref({ channels: {}, securityEvents: {} })
const range = ref([])
const summary = ref(null)
const loading = ref(false)
const syncing = ref(false)


const LEVELS = {
  critical: { label: '重大', cls: 'status-danger' },
  error: { label: '錯誤', cls: 'status-danger' },
  warning: { label: '警告', cls: 'status-wait' },
  audit_failure: { label: '稽核失敗', cls: 'status-danger' },
  audit_success: { label: '稽核成功', cls: 'status-run' },
  info: { label: '資訊', cls: 'status-done' },
}
const chName = (c) => meta.value.channels[c] ?? c
const evName = (g) => (g.channel === 'Security' ? meta.value.securityEvents[g.eventId] : '') || ''

const dayset = computed(() => new Set(days.value.map((d) => d.day)))
const disabledDate = (d) => {
  const p = (x) => String(x).padStart(2, '0')
  return !dayset.value.has(`${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`)
}
/** 期間內 Security 記錄是空的（匯出排程沒有權限或 DC 沒開稽核） */
const securityEmpty = computed(() => {
  const inRange = days.value.filter((d) => range.value.length && d.day >= range.value[0] && d.day <= range.value[1])
  // 多台 DC 時加總每台的 Security 筆數
  return inRange.length > 0 && inRange.every((d) => d.files.filter((f) => f.channel === 'Security').reduce((a, f) => a + (f.rows ?? 0), 0) === 0)
})

async function loadDays() {
  const res = await call(http.get('/ad/days'))
  if (!res) return
  days.value = res.data.days
  meta.value = res.data
  if (!range.value.length && days.value.length) range.value = [days.value[0].day, days.value[0].day]
}

async function load() {
  if (!range.value?.length) return
  loading.value = true
  const res = await call(http.get('/ad/summary', { params: { from: range.value[0], to: range.value[1] } }))
  loading.value = false
  summary.value = res?.data ?? null
}

async function sync() {
  syncing.value = true
  const res = await call(http.post('/ad/sync', null, { timeout: 180000 }))
  syncing.value = false
  if (!res) return
  ElMessage({ type: res.data.imported?.length ? 'success' : 'info', message: res.message })
  await loadDays()
  load()
}

/** 點統計的一列 / 數字 → 帶條件到 Log 明細查詢 */
const toSearch = (cond) => router.push({ name: 'AdSearch', query: { from: range.value[0], to: range.value[1], ...cond } })
const pick = (g) => toSearch({ channel: g.channel, eventId: String(g.eventId) })
const pickValue = (key, v) => toSearch({ [key]: v })
/** 登入失敗的原因 → 明細查詢：用原因裡的代碼（0x25、0xC000006A）或文字當關鍵字，限登入失敗 / 鎖定事件 */
const pickReason = (reason) => toSearch({ eventId: '4625,4771,4740,4776', q: reason.match(/（(0x[0-9a-f]+)）$/i)?.[1] ?? reason })

const kpi = computed(() => {
  const s = summary.value
  if (!s) return null
  const n = (lv) => s.byLevel[lv] ?? 0
  const ev = (id) => s.events.filter((g) => g.eventId === id && g.channel === 'Security').reduce((a, g) => a + g.n, 0)
  return { total: s.total, error: n('error') + n('critical'), warning: n('warning'), loginFail: ev(4625) + ev(4771), lockout: ev(4740) }
})
/** 新建立的帳號隨即被加入特權群組（入侵後門常見手法） */
const backdoor = computed(() => {
  const ch = summary.value?.accountChanges ?? []
  const created = new Set(ch.filter((c) => c.eventId === 4720).map((c) => c.target))
  return ch.filter((c) => c.privileged && created.has(c.target))
})
const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })

watch(range, load)
onMounted(async () => {
  await loadDays()
  load()
})
</script>

<template>
  <div v-loading="loading && !summary">
    <PageHeader title="AD 事件總覽" :icon="Network" :subtitle="summary ? `${summary.timeMin} ~ ${summary.timeMax}` : ''">
      <el-date-picker v-model="range" type="daterange" value-format="YYYY/MM/DD" range-separator="~" :clearable="false" :disabled-date="disabledDate" size="small" class="!w-60" />
      <el-button size="small" :loading="loading" @click="loadDays().then(load)"><RefreshCw v-if="!loading" :size="14" class="mr-1" />重新整理</el-button>
      <el-button size="small" type="primary" :loading="syncing" @click="sync"><CloudDownload v-if="!syncing" :size="14" class="mr-1" />從 FTP 同步</el-button>
    </PageHeader>

    <section v-if="!days.length && !loading" class="glass rounded-2xl p-10 text-center">
      <p class="m-0 text-lg text-ink font-semibold">尚未匯入 AD 事件記錄</p>
      <p class="m-0 mt-1 text-mute">按「從 FTP 同步」讀取 FTP /AD_Log_Backup 的每日匯出檔。</p>
    </section>

    <div v-if="securityEmpty" class="rounded-xl p-3 mb-3 text-sm bg-warn/10 border border-warn/40 text-ink flex gap-2">
      <TriangleAlert :size="18" class="text-warn shrink-0 mt-0.5" />
      <div>
        <b>這段期間的 Security（安全性）記錄是空的。</b>登入成功 / 失敗、帳號鎖定、密碼變更、群組異動都記錄在 Security，目前無法分析。
        請檢查 DC 的匯出排程帳號是否有讀取 Security 記錄的權限（Event Log Readers 群組或系統管理員），以及 DC 是否已啟用稽核原則（帳戶登入、帳戶管理）。
      </div>
    </div>

    <template v-if="summary">
      <!-- KPI -->
      <section class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 mb-3">
        <div class="glass rounded-2xl p-4">
          <p class="m-0 text-sm text-mute">事件總數</p>
          <p class="m-0 mt-1 text-3xl font-bold text-ink tabular-nums">{{ fmtNum(kpi.total) }}</p>
          <p class="m-0 text-xs text-dim">{{ Object.entries(summary.byChannel).map(([c, n]) => `${chName(c)} ${fmtNum(n)}`).join('、') }}</p>
        </div>
        <div class="glass rounded-2xl p-4 cursor-pointer" role="button" tabindex="0" @click="pickValue('level', 'error')" @keydown.enter="pickValue('level', 'error')">
          <p class="m-0 text-sm text-mute">錯誤 / 重大</p>
          <p :class="['m-0 mt-1 text-3xl font-bold tabular-nums', kpi.error ? 'text-danger' : 'text-run']">{{ fmtNum(kpi.error) }}</p>
        </div>
        <div class="glass rounded-2xl p-4 cursor-pointer" role="button" tabindex="0" @click="pickValue('level', 'warning')" @keydown.enter="pickValue('level', 'warning')">
          <p class="m-0 text-sm text-mute">警告</p>
          <p :class="['m-0 mt-1 text-3xl font-bold tabular-nums', kpi.warning ? 'text-warn' : 'text-run']">{{ fmtNum(kpi.warning) }}</p>
        </div>
        <div class="glass rounded-2xl p-4 cursor-pointer" role="button" tabindex="0" @click="pickValue('eventId', '4625,4771')" @keydown.enter="pickValue('eventId', '4625,4771')">
          <p class="m-0 text-sm text-mute">登入失敗（4625 / 4771）</p>
          <p :class="['m-0 mt-1 text-3xl font-bold tabular-nums', securityEmpty ? 'text-dim' : kpi.loginFail ? 'text-danger' : 'text-run']">{{ securityEmpty ? '—' : fmtNum(kpi.loginFail) }}</p>
        </div>
        <div class="glass rounded-2xl p-4 cursor-pointer" role="button" tabindex="0" @click="scrollTo('ad-priv')" @keydown.enter="scrollTo('ad-priv')">
          <p class="m-0 text-sm text-mute">特權群組異動 / 建立帳號</p>
          <p :class="['m-0 mt-1 text-3xl font-bold tabular-nums', securityEmpty ? 'text-dim' : summary.privilegedChanges ? 'text-danger' : 'text-run']">{{ securityEmpty ? '—' : `${fmtNum(summary.privilegedChanges)} / ${fmtNum(summary.accountsCreated)}` }}</p>
        </div>
        <div class="glass rounded-2xl p-4 cursor-pointer" role="button" tabindex="0" @click="pickValue('eventId', '4740')" @keydown.enter="pickValue('eventId', '4740')">
          <p class="m-0 text-sm text-mute">帳號鎖定（4740）</p>
          <p :class="['m-0 mt-1 text-3xl font-bold tabular-nums', securityEmpty ? 'text-dim' : kpi.lockout ? 'text-danger' : 'text-run']">{{ securityEmpty ? '—' : fmtNum(kpi.lockout) }}</p>
        </div>
      </section>

      <!-- 帳號與特權異動（Security 4720 / 4728 / 4732 / 4756 …） -->
      <section id="ad-priv" class="glass rounded-2xl p-4 mb-3">
        <h2 class="section-title flex justify-between gap-2">
          帳號與特權異動
          <span class="text-xs font-normal text-dim">建立 / 刪除 / 停用帳號、重設密碼、加入或移出群組；【特權】= Domain Admins、Administrators 等高權限群組</span>
        </h2>
        <div v-if="backdoor.length" class="rounded-lg p-3 mb-2 text-sm bg-danger/10 border border-danger/40 text-ink">
          <b class="text-danger">⚠ 新建立的帳號隨即被加入特權群組：</b>
          {{ backdoor.map((c) => `${c.target} → ${c.group}（${c.actor}，${c.time}）`).join('、') }}。這是常見的入侵後門手法，請立即確認是否有核准。
        </div>
        <p v-if="securityEmpty" class="m-0 py-4 text-center text-sm text-dim">Security 記錄是空的，無法列出帳號與特權異動</p>
        <el-table v-else :data="summary.accountChanges" size="small" max-height="360" empty-text="這段期間沒有帳號或群組異動" :row-class-name="({ row }) => (row.privileged ? 'priv-row' : '')">
          <el-table-column prop="time" label="時間" width="150" />
          <el-table-column label="動作" width="150">
            <template #default="{ row }"><span v-if="row.privileged" class="status-pill status-danger mr-1">特權</span>{{ row.action }}</template>
          </el-table-column>
          <el-table-column prop="actor" label="執行者" width="140" show-overflow-tooltip />
          <el-table-column prop="target" label="對象" min-width="160" show-overflow-tooltip />
          <el-table-column prop="group" label="群組" min-width="160" show-overflow-tooltip />
          <el-table-column label="" width="70">
            <template #default="{ row }"><el-button link type="primary" size="small" @click="pickValue('q', row.target || row.group)">明細</el-button></template>
          </el-table-column>
        </el-table>
        <div v-if="summary.privLogons.length" class="mt-3 text-sm">
          <span class="text-mute">特權登入（4672，已排除電腦與系統帳戶）：</span>
          <button v-for="x in summary.privLogons" :key="x.key" type="button" class="priv-chip" @click="pickValue('account', x.key)">{{ x.key }}（{{ fmtNum(x.n) }}）</button>
        </div>
      </section>

      <section class="grid grid-cols-1 xl:grid-cols-2 gap-3 mb-3">
        <!-- 需要注意 -->
        <div class="glass rounded-2xl p-4">
          <h2 class="section-title">需要注意的事件（錯誤、警告、登入失敗、帳號異動）</h2>
          <el-table :data="summary.issues" size="small" max-height="380" empty-text="沒有需要注意的事件" @row-click="pick" class="cursor-pointer">
            <el-table-column label="記錄" width="96"><template #default="{ row }">{{ chName(row.channel) }}</template></el-table-column>
            <el-table-column label="事件" width="70"><template #default="{ row }">{{ row.eventId }}</template></el-table-column>
            <el-table-column label="等級" width="70"><template #default="{ row }"><span :class="['status-pill', LEVELS[row.level]?.cls]">{{ LEVELS[row.level]?.label }}</span></template></el-table-column>
            <el-table-column label="次數" width="70" align="right"><template #default="{ row }">{{ fmtNum(row.n) }}</template></el-table-column>
            <el-table-column label="內容" min-width="260" show-overflow-tooltip>
              <template #default="{ row }"><b v-if="evName(row)">{{ evName(row) }}：</b>{{ row.sample }}</template>
            </el-table-column>
          </el-table>
        </div>
        <!-- 事件排行 -->
        <div class="glass rounded-2xl p-4">
          <h2 class="section-title">事件排行</h2>
          <el-table :data="summary.events.slice(0, 30)" size="small" max-height="380" @row-click="pick" class="cursor-pointer">
            <el-table-column label="記錄" width="96"><template #default="{ row }">{{ chName(row.channel) }}</template></el-table-column>
            <el-table-column label="事件" width="70"><template #default="{ row }">{{ row.eventId }}</template></el-table-column>
            <el-table-column label="等級" width="70"><template #default="{ row }"><span :class="['status-pill', LEVELS[row.level]?.cls]">{{ LEVELS[row.level]?.label }}</span></template></el-table-column>
            <el-table-column label="次數" width="70" align="right"><template #default="{ row }">{{ fmtNum(row.n) }}</template></el-table-column>
            <el-table-column label="內容" min-width="260" show-overflow-tooltip>
              <template #default="{ row }"><b v-if="evName(row)">{{ evName(row) }}：</b>{{ row.sample }}</template>
            </el-table-column>
          </el-table>
        </div>
      </section>

      <!-- 登入失敗的帳號 / IP（有 Security 資料時） -->
      <section v-if="summary.failAccounts.length || summary.failIps.length" class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <div class="glass rounded-2xl p-4">
          <h2 class="section-title">登入失敗 / 鎖定最多的帳號</h2>
          <ul class="m-0 p-0 list-none space-y-1 text-sm">
            <li v-for="x in summary.failAccounts" :key="x.key" class="flex gap-2 cursor-pointer hover:text-brand-500" @click="pickValue('account', x.key)">
              <span class="text-ink">{{ x.key }}</span><span class="ml-auto tabular-nums text-danger">{{ fmtNum(x.n) }}</span>
            </li>
          </ul>
        </div>
        <div class="glass rounded-2xl p-4">
          <h2 class="section-title">登入失敗最多的來源 IP</h2>
          <ul class="m-0 p-0 list-none space-y-1 text-sm">
            <li v-for="x in summary.failIps" :key="x.key" class="flex gap-2 cursor-pointer hover:text-brand-500" @click="pickValue('ip', x.key)">
              <span class="text-ink">{{ x.key }}</span><span class="ml-auto tabular-nums text-danger">{{ fmtNum(x.n) }}</span>
            </li>
          </ul>
        </div>
        <div class="glass rounded-2xl p-4">
          <h2 class="section-title">登入失敗的原因</h2>
          <ul class="m-0 p-0 list-none space-y-2 text-sm">
            <li v-for="x in summary.failReasons" :key="x.key" class="cursor-pointer hover:text-brand-500" role="button" tabindex="0"
              title="點選查看這個原因的登入失敗明細" @click="pickReason(x.key)" @keydown.enter="pickReason(x.key)">
              <div class="flex gap-2">
                <span class="text-ink">{{ x.key }}</span><span class="ml-auto tabular-nums text-danger">{{ fmtNum(x.n) }}</span>
              </div>
              <!-- 這個原因的來源 IP 與帳號 -->
              <p v-if="x.ips?.length || x.accounts?.length" class="m-0 text-xs text-mute leading-snug">
                <template v-if="x.ips?.length">IP {{ x.ips.map((i) => `${i.key}（${i.n}）`).join('、') }}</template>
                <template v-if="x.accounts?.length"><br />帳號 {{ x.accounts.map((a) => `${a.key}（${a.n}）`).join('、') }}</template>
              </p>
            </li>
          </ul>
        </div>
      </section>

    </template>
  </div>
</template>

<style scoped>
:deep(.priv-row) td.el-table__cell {
  background: color-mix(in srgb, var(--color-danger) 10%, transparent) !important;
}
.priv-chip {
  margin: 2px 4px 2px 0;
  padding: 1px 8px;
  border-radius: 9999px;
  border: 1px solid var(--color-glow);
  background: var(--color-brand-50);
  color: var(--color-ink);
  cursor: pointer;
  font-size: calc(0.8125rem * var(--font-scale));
}
</style>
