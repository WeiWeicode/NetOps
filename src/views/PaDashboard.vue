<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ShieldCheck, RefreshCw, FolderDown, Radar, Sparkles } from 'lucide-vue-next'
import PageHeader from '../components/PageHeader.vue'
import TopList from '../components/TopList.vue'
import AiAnalysis from '../components/AiAnalysis.vue'
import http, { call } from '../api/http.js'
import { actionLabel, actionPill, fmtBytes, fmtNum, fmtShort, pct } from '../utils/format.js'

/**
 * 流量總覽：合併期間內各 log 檔的摘要（FTP Log 檔案頁分析後才有資料）
 * 點排行 / 每小時長條 → 帶條件到 Log 明細查詢
 */
const router = useRouter()
const days = ref([])
const range = ref([])
const data = ref(null)
const loading = ref(false)
const metric = ref('n') // n 連線數 / bytes 流量
const aiOpen = ref(false)
const view = reactive({ src: 'n', dst: 'n', app: 'n' })

const dayset = computed(() => new Set(days.value.map((d) => d.day)))
const disabledDate = (d) => {
  const p = (x) => String(x).padStart(2, '0')
  return !dayset.value.has(`${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`)
}

async function loadDays() {
  const res = await call(http.get('/palog/days'))
  days.value = res?.data.days ?? []
  if (!range.value.length && days.value.length) range.value = [days.value[0].day, days.value[0].day]
}

async function load() {
  if (!range.value?.length) return
  loading.value = true
  const res = await call(http.get('/palog/summary', { params: { from: range.value[0], to: range.value[1], top: 15 } }))
  loading.value = false
  data.value = res?.data ?? null
}

watch(range, load)

/* ───── 每小時長條圖（允許 / 阻擋堆疊） ───── */
const tip = reactive({ show: false, x: 0, y: 0, rows: [] })
const chart = computed(() => {
  const W = 960
  const H = 220
  const L = 52
  const R = 8
  const T = 12
  const B = 26
  const hours = data.value?.hours ?? []
  const val = (h) => (metric.value === 'bytes' ? h.bytes : h.n)
  const max = Math.max(1, ...hours.map(val))
  // 刻度取 1、2、5 × 10^n
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)
  const top = Math.ceil(max / step) * step
  const y = (v) => T + (H - T - B) * (1 - v / top)
  const bw = (W - L - R) / Math.max(hours.length, 1)
  const barW = Math.max(2, Math.min(24, bw * 0.7))
  const ticks = []
  for (let v = 0; v <= top + step / 2; v += step) ticks.push({ v, y: y(v), label: metric.value === 'bytes' ? fmtBytes(v) : fmtShort(v) })
  const labelEvery = Math.ceil(hours.length / 24) * (hours.length > 24 ? 6 : 3)
  const bars = hours.map((h, i) => {
    const cx = L + bw * i + bw / 2
    const x0 = cx - barW / 2
    let segs
    if (metric.value === 'bytes') {
      segs = [{ c: 'var(--color-brand-500)', y: y(h.bytes), h: y(0) - y(h.bytes) }]
    } else {
      const yA = y(h.allow)
      const yT = y(h.n)
      segs = [
        { c: 'var(--color-run)', y: yA, h: y(0) - yA },
        { c: 'var(--color-danger)', y: yT, h: Math.max(0, yA - yT - (h.allow ? 1 : 0)) },
      ]
    }
    const hh = h.hour.slice(11, 13)
    return {
      ...h,
      x0,
      w: barW,
      segs,
      label: hours.length <= 24 || i % labelEvery === 0 ? (hours.length > 24 ? `${h.hour.slice(5, 10)} ${hh}` : hh) : '',
      cx,
      hit: { x: L + bw * i, w: bw },
    }
  })
  return { W, H, L, R, T, B, ticks, bars }
})

function showTip(e, b) {
  const box = e.currentTarget.closest('.chart-wrap').getBoundingClientRect()
  Object.assign(tip, {
    show: true,
    x: e.clientX - box.left + 12,
    y: e.clientY - box.top - 10,
    rows: [
      [`${b.hour}:00`, ''],
      ['連線數', fmtNum(b.n)],
      ['允許', fmtNum(b.allow)],
      ['阻擋', `${fmtNum(b.block)}（${pct(b.block, b.n)}）`],
      ['流量', fmtBytes(b.bytes)],
    ],
  })
}

/* ───── 帶條件到明細查詢 ───── */
const dayFrom = () => `${range.value[0]} 00:00`
const dayTo = () => `${range.value[1]} 23:59`
function search(cond, from = dayFrom(), to = dayTo()) {
  router.push({ name: 'PaSearch', query: { from, to, ...cond } })
}
const openHour = (b) => search({}, `${b.hour}:00`, `${b.hour}:59`)
const portCond = (key) => {
  const [proto, port] = key.split('/')
  return port ? { proto, port } : { proto }
}
const zoneCond = (key) => {
  const [fromZone, toZone] = key.split(' → ')
  return { fromZone: fromZone === '?' ? '' : fromZone, toZone: toZone === '?' ? '' : toZone }
}
const stripNote = (key) => key.replace(/（.*$/, '')

const PICK = {
  src: (k) => ({ src: k }),
  dst: (k) => ({ dst: k }),
  dport: portCond,
  app: (k) => ({ app: k }),
  rule: (k) => ({ rule: k }),
  zone: zoneCond,
  dstCountry: (k) => ({ country: k }),
  user: (k) => ({ user: k }),
  blockSrc: (k) => ({ src: k, action: 'block' }),
  blockDst: (k) => ({ dst: k, action: 'block' }),
  blockDport: (k) => ({ ...portCond(k), action: 'block' }),
  blockRule: (k) => ({ rule: k, action: 'block' }),
  inboundBlockSrc: (k) => ({ src: stripNote(k), action: 'block' }),
  inboundAllow: (k) => {
    const m = k.match(/^(\S+) → (\S+):(\w+)\/(\d+)$/)
    return m ? { src: m[1], dst: m[2], proto: m[3], port: m[4], action: 'allow' } : { q: k }
  },
  riskApp: (k) => ({ app: stripNote(k), action: 'allow' }),
  // 資料外流 / AI 應用
  upSrc: (k) => ({ src: k, action: 'allow' }),
  upDst: (k) => ({ dst: stripNote(k), action: 'allow' }),
  upRiskSrc: (k) => ({ src: k, action: 'allow' }),
  upRiskApp: (k) => ({ app: stripNote(k), action: 'allow' }),
  aiSrc: (k) => ({ src: k, action: 'allow' }),
  aiApp: (k) => ({ app: k, action: 'allow' }),
}
const pick = (name, key) => search(PICK[name](key))

const top = (name, by = 'n') => (by === 'bytes' ? data.value?.topBytes?.[name] : data.value?.top?.[name]) ?? []

/**
 * IP 排行加上「用了哪些 App」：pairName 的 key 是「IP → App」（依次數與依上傳量各取前幾名合併）
 * 例：10.10.112.74（openai-chatgpt、google-gemini）
 */
function withApps(name, pairName, by) {
  const apps = new Map()
  for (const p of [...top(pairName), ...top(pairName, 'bytes')]) {
    const [ip, app] = p.key.split(' → ')
    const set = apps.get(ip) ?? new Set()
    set.add(app)
    apps.set(ip, set)
  }
  return top(name, by).map((x) => ({ ...x, sub: apps.has(x.key) ? [...apps.get(x.key)].slice(0, 3).join('、') : '' }))
}
const aiView = ref('n') // AI 應用的 IP：依次數 / 依上傳量

const actions = computed(() =>
  Object.entries(data.value?.actions ?? {})
    .map(([k, n]) => ({ k, n }))
    .sort((a, b) => b.n - a.n)
)

onMounted(async () => {
  await loadDays()
  if (range.value.length) load()
})
</script>

<template>
  <div v-loading="loading && !data">
    <PageHeader title="流量總覽" :icon="ShieldCheck" :subtitle="data ? `${data.timeMin} ~ ${data.timeMax}，${data.files} 個 log 檔` : ''">
      <el-date-picker v-model="range" type="daterange" value-format="YYYY/MM/DD" range-separator="~" :clearable="false" :disabled-date="disabledDate"
        size="small" class="!w-60" placeholder="選擇日期" />
      <el-button size="small" :loading="loading" @click="loadDays().then(load)"><RefreshCw v-if="!loading" :size="14" class="mr-1" />重新整理</el-button>
      <el-button size="small" type="primary" :disabled="!data" @click="aiOpen = true"><Sparkles :size="14" class="mr-1" />AI 分析</el-button>
    </PageHeader>
    <AiAnalysis v-if="range.length" v-model="aiOpen" :from="range[0]" :to="range[1]"
      :title="`AI 分析：${range[0] === range[1] ? range[0] : `${range[0]} ~ ${range[1]}`} 防火牆狀況`" />

    <!-- 還沒有分析過的資料 -->
    <section v-if="!days.length && !loading" class="glass rounded-2xl p-10 text-center">
      <p class="m-0 text-lg text-ink font-semibold">尚未分析任何 PA log</p>
      <p class="m-0 mt-1 text-mute">到「FTP Log 檔案」按「同步新檔案」，系統會從 FTP 讀取 log 並產生統計。</p>
      <el-button type="primary" class="mt-4" @click="router.push({ name: 'FtpFiles' })"><FolderDown :size="16" class="mr-1" />前往 FTP Log 檔案</el-button>
    </section>

    <template v-if="data">
      <!-- KPI -->
      <section class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
        <div class="glass rounded-2xl p-4">
          <p class="m-0 text-sm text-mute">連線紀錄</p>
          <p class="m-0 mt-1 text-3xl font-bold text-ink tabular-nums">{{ fmtShort(data.rows) }}</p>
          <p class="m-0 text-xs text-dim">{{ fmtNum(data.rows) }} 筆</p>
        </div>
        <div class="glass rounded-2xl p-4 cursor-pointer" role="button" tabindex="0" @click="search({ action: 'allow' })" @keydown.enter="search({ action: 'allow' })">
          <p class="m-0 text-sm text-mute">允許</p>
          <p class="m-0 mt-1 text-3xl font-bold text-run tabular-nums">{{ fmtShort(data.allow) }}</p>
          <p class="m-0 text-xs text-dim">{{ pct(data.allow, data.rows) }}</p>
        </div>
        <div class="glass rounded-2xl p-4 cursor-pointer" role="button" tabindex="0" @click="search({ action: 'block' })" @keydown.enter="search({ action: 'block' })">
          <p class="m-0 text-sm text-mute">阻擋（deny / drop / reset）</p>
          <p class="m-0 mt-1 text-3xl font-bold text-danger tabular-nums">{{ fmtShort(data.block) }}</p>
          <p class="m-0 text-xs text-dim">{{ pct(data.block, data.rows) }}</p>
        </div>
        <div class="glass rounded-2xl p-4">
          <p class="m-0 text-sm text-mute">總流量</p>
          <p class="m-0 mt-1 text-3xl font-bold text-ink tabular-nums">{{ fmtBytes(data.bytes) }}</p>
          <p class="m-0 text-xs text-dim">送出 {{ fmtBytes(data.sent) }} · 接收 {{ fmtBytes(data.recv) }}</p>
        </div>
        <div class="glass rounded-2xl p-4">
          <p class="m-0 text-sm text-mute">目標分散的被擋來源</p>
          <p :class="['m-0 mt-1 text-3xl font-bold tabular-nums', data.scan.length ? 'text-warn' : 'text-run']">{{ data.scan.length }}</p>
          <p class="m-0 text-xs text-dim">被擋且目的 IP 或 Port ≥ 20 個</p>
        </div>
      </section>

      <!-- 每小時 -->
      <section class="glass rounded-2xl p-4 mb-3">
        <h2 class="section-title flex justify-between">
          每小時{{ metric === 'bytes' ? '流量' : '連線數' }}
          <el-radio-group v-model="metric" size="small">
            <el-radio-button value="n">連線數</el-radio-button>
            <el-radio-button value="bytes">流量</el-radio-button>
          </el-radio-group>
        </h2>
        <div v-if="metric === 'n'" class="legend">
          <span><i class="sw" style="background: var(--color-run)" />允許</span>
          <span><i class="sw" style="background: var(--color-danger)" />阻擋</span>
          <span class="text-dim">點長條查看該小時明細</span>
        </div>
        <div class="chart-wrap relative" @mouseleave="tip.show = false">
          <svg :viewBox="`0 0 ${chart.W} ${chart.H}`" class="block w-full h-auto overflow-visible" role="img" aria-label="每小時連線數">
            <g v-for="t in chart.ticks" :key="t.v">
              <line :x1="chart.L" :x2="chart.W - chart.R" :y1="t.y" :y2="t.y" :stroke="t.v === 0 ? 'var(--color-dim)' : 'var(--color-glow)'" stroke-width="1" />
              <text :x="chart.L - 6" :y="t.y + 4" text-anchor="end" font-size="11" fill="var(--color-dim)">{{ t.label }}</text>
            </g>
            <g v-for="b in chart.bars" :key="b.hour">
              <rect v-for="(s, k) in b.segs" :key="k" :x="b.x0" :y="s.y" :width="b.w" :height="Math.max(0, s.h)" :fill="s.c" rx="2" />
              <text v-if="b.label" :x="b.cx" :y="chart.H - 8" text-anchor="middle" font-size="11" fill="var(--color-dim)">{{ b.label }}</text>
              <rect :x="b.hit.x" :y="chart.T" :width="b.hit.w" :height="chart.H - chart.T - chart.B" fill="transparent" class="cursor-pointer"
                @mousemove="showTip($event, b)" @click="openHour(b)" />
            </g>
          </svg>
          <div v-show="tip.show" class="chart-tip" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }">
            <div v-for="(r, i) in tip.rows" :key="i" class="flex justify-between gap-4"><span :class="i ? 'text-mute' : 'font-bold'">{{ r[0] }}</span><b>{{ r[1] }}</b></div>
          </div>
        </div>
      </section>

      <!-- 流量排行 -->
      <section class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-3">
        <TopList title="來源 IP" :items="top('src', view.src)" :by-bytes="view.src === 'bytes'" show-bytes @pick="(k) => pick('src', k)">
          <template #extra>
            <el-radio-group v-model="view.src" size="small"><el-radio-button value="n">次數</el-radio-button><el-radio-button value="bytes">流量</el-radio-button></el-radio-group>
          </template>
        </TopList>
        <TopList title="目的 IP" :items="top('dst', view.dst)" :by-bytes="view.dst === 'bytes'" show-bytes @pick="(k) => pick('dst', k)">
          <template #extra>
            <el-radio-group v-model="view.dst" size="small"><el-radio-button value="n">次數</el-radio-button><el-radio-button value="bytes">流量</el-radio-button></el-radio-group>
          </template>
        </TopList>
        <TopList title="應用程式" :items="top('app', view.app)" :by-bytes="view.app === 'bytes'" show-bytes @pick="(k) => pick('app', k)">
          <template #extra>
            <el-radio-group v-model="view.app" size="small"><el-radio-button value="n">次數</el-radio-button><el-radio-button value="bytes">流量</el-radio-button></el-radio-group>
          </template>
        </TopList>
        <TopList title="目的 Port" :items="top('dport')" show-bytes @pick="(k) => pick('dport', k)" />
        <TopList title="區域流向" :items="top('zone')" show-bytes @pick="(k) => pick('zone', k)" />
        <TopList title="目的國家 / 區段" :items="top('dstCountry')" show-bytes @pick="(k) => pick('dstCountry', k)" />
      </section>

      <!-- 資料外流與 AI 應用（依上傳 = 送出位元組；內部 IP → 公網 IP 且允許的連線） -->
      <h2 class="section-title mt-1">資料外流與 AI 應用</h2>
      <section class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-3">
        <TopList title="上傳到外部最多的內部 IP" tone="warn" by-bytes :items="top('upSrc', 'bytes')"
          hint="內部 IP 送到公網的資料量（只算送出，不含下載）；大量集中上傳可能是異地備份，也可能是資料外流" @pick="(k) => pick('upSrc', k)" />
        <TopList title="高風險管道上傳的內部 IP" tone="danger" by-bytes :items="withApps('upRiskSrc', 'upRiskPair', 'bytes')"
          hint="檔案分享、雲端儲存、加密通道（SSH / VPN）、郵件、遠端存取、即時通訊、P2P" @pick="(k) => pick('upRiskSrc', k)" />
        <TopList title="上傳管道（App）排行" tone="danger" by-bytes :items="top('upRiskApp', 'bytes')" @pick="(k) => pick('upRiskApp', k)" />
        <TopList title="上傳最多的外部目的地" tone="warn" by-bytes :items="top('upDst', 'bytes')" @pick="(k) => pick('upDst', k)" />
        <TopList title="使用 AI 應用的內部 IP" :by-bytes="aiView === 'bytes'" show-bytes :items="withApps('aiSrc', 'aiPair', aiView)"
          hint="PA App-ID 子分類 artificial-intelligence（ChatGPT、Gemini、Claude、Copilot…）；流量為上傳到 AI 的資料量" @pick="(k) => pick('aiSrc', k)">
          <template #extra>
            <el-radio-group v-model="aiView" size="small"><el-radio-button value="n">次數</el-radio-button><el-radio-button value="bytes">上傳量</el-radio-button></el-radio-group>
          </template>
        </TopList>
        <TopList title="AI 應用排行" show-bytes :items="top('aiApp')" @pick="(k) => pick('aiApp', k)" />
      </section>

      <!-- 阻擋與風險 -->
      <section class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-3">
        <TopList title="被擋最多的來源 IP" tone="danger" :items="top('blockSrc')" @pick="(k) => pick('blockSrc', k)" />
        <TopList title="被擋最多的目的 IP" tone="danger" :items="top('blockDst')" @pick="(k) => pick('blockDst', k)" />
        <TopList title="被擋最多的目的 Port" tone="danger" :items="top('blockDport')" @pick="(k) => pick('blockDport', k)" />
        <TopList title="外部（公網）被擋的來源" tone="danger" hint="來源區域為 WAN、來源為公網 IP 的阻擋紀錄" :items="top('inboundBlockSrc')" @pick="(k) => pick('inboundBlockSrc', k)" />
        <TopList title="外部（公網）允許連入" tone="warn" hint="來源為公網 IP 且被允許連入，請確認都是預期對外開放的服務" :items="top('inboundAllow')" @pick="(k) => pick('inboundAllow', k)" />
        <TopList title="高風險應用程式（風險 ≥ 4，允許）" tone="warn" hint="不含 ssl、web-browsing、ms-update 等一般上網 / 更新" :items="top('riskApp')" show-bytes @pick="(k) => pick('riskApp', k)" />
        <TopList title="阻擋規則" tone="danger" :items="top('blockRule')" @pick="(k) => pick('blockRule', k)" />
        <TopList title="規則命中" :items="top('rule')" @pick="(k) => pick('rule', k)" />
        <div class="glass rounded-2xl p-4">
          <h2 class="section-title !mb-2">動作分布</h2>
          <ul class="m-0 p-0 list-none space-y-1.5">
            <li v-for="a in actions" :key="a.k" class="flex items-center gap-2 text-sm cursor-pointer" role="button" tabindex="0"
              @click="search({ action: a.k })" @keydown.enter="search({ action: a.k })">
              <span :class="['status-pill', actionPill(a.k)]">{{ actionLabel(a.k) }}</span>
              <span class="text-mute">{{ a.k }}</span>
              <span class="ml-auto tabular-nums text-ink">{{ fmtNum(a.n) }}</span>
              <span class="w-14 text-right tabular-nums text-dim">{{ pct(a.n, data.rows) }}</span>
            </li>
          </ul>
          <h2 class="section-title !mb-2 mt-4">連線結束原因</h2>
          <ul class="m-0 p-0 list-none space-y-1 text-sm">
            <li v-for="x in top('endReason').slice(0, 8)" :key="x.key" class="flex gap-2">
              <span class="text-ink">{{ x.key }}</span><span class="ml-auto tabular-nums text-mute">{{ fmtNum(x.n) }}</span>
            </li>
          </ul>
        </div>
      </section>

      <!-- 疑似掃描 -->
      <section class="glass rounded-2xl p-4 mb-3">
        <h2 class="section-title"><Radar :size="18" />被擋且目標分散的來源（疑似掃描 / 異常連線）</h2>
        <p class="m-0 mb-2 text-xs text-dim">同一來源被擋的連線中，目的 IP 或目的 Port 有 20 個以上。目的 Port 多 = 疑似 Port 掃描；目的 IP 多 = 疑似主機掃描或程式不斷嘗試連線。數量為各 log 檔中的最大值。</p>
        <el-table :data="data.scan" size="small" max-height="420" empty-text="沒有發現" @row-click="(r) => search({ src: r.src, action: 'block' })">
          <el-table-column prop="src" label="來源 IP" min-width="150" />
          <el-table-column prop="zone" label="區域流向" min-width="150" />
          <el-table-column label="被擋次數" width="110" align="right"><template #default="{ row }">{{ fmtNum(row.n) }}</template></el-table-column>
          <el-table-column label="不同目的 IP" width="120" align="right">
            <template #default="{ row }"><span :class="row.dsts >= 100 ? 'text-danger font-bold' : ''">{{ row.dsts >= 1000 ? '1000+' : row.dsts }}</span></template>
          </el-table-column>
          <el-table-column label="不同目的 Port" width="120" align="right">
            <template #default="{ row }"><span :class="row.ports >= 50 ? 'text-danger font-bold' : ''">{{ row.ports >= 1000 ? '1000+' : row.ports }}</span></template>
          </el-table-column>
          <el-table-column label="研判" min-width="160">
            <template #default="{ row }">
              <span v-if="row.ports >= 50" class="status-pill status-danger">疑似 Port 掃描</span>
              <span v-else-if="row.dsts >= 100" class="status-pill status-wait">疑似主機掃描</span>
              <span v-else class="status-pill status-done">持續嘗試連線</span>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  font-size: calc(0.8125rem * var(--font-scale));
  color: var(--color-mute);
  margin-bottom: 0.25rem;
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.sw {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 3px;
}
.chart-tip {
  position: absolute;
  z-index: 10;
  pointer-events: none;
  min-width: 180px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: calc(0.8125rem * var(--font-scale));
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--color-glow);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  color: var(--color-ink);
}
</style>
