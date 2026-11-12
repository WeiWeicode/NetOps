<script setup lang="ts">
/**
 * 防火牆 › 流量總覽(docs/API.md §4.1;舊版 src/views/PaDashboard.vue):
 *   合併期間內各 TRAFFIC log 檔的摘要(FTP Log 檔案頁分析後才有資料):KPI、每小時連線數 / 流量、流量排行、
 *   資料外流與 AI 應用、阻擋與風險、動作分布、疑似掃描。點排行 / 每小時長條 / KPI 帶條件到 Log 明細查詢(/firewall/search)。
 *   AI 分析(IMPL-PLAN A1):按鈕開對話框分析目前期間(components/AiAnalysis.vue;按鈕權限 netops.pa-dashboard.ai)。期間最長 92 天;結果不完整時要提示(AGENT.md §5)。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { describeError, can } from '@/api/gateway';
import { fmtNum, fmtPct, fmtShort, fmtSize, fmtTime } from '@/api/format';
import { actionOf, pa, type Coverage, type PaDay, type PaOverview, type TopEntry } from '@/api/pa';
import DateRangeField from '@/components/DateRangeField.vue';
import { coverageText } from '@/composables/dateRange';
import { NETOPS, UI } from '@/api/perms';
import AiAnalysis from '@/components/AiAnalysis.vue';
import TopList from '@/components/TopList.vue';
import { daysBetween } from '@/composables/dates';
import { PICK, scanVerdict, withApps, type SearchCond } from '@/composables/paDashboard';

const MAX_DAYS = 92;
const TOP = 15;
const router = useRouter();
/** AI 分析對話框 */
const aiOpen = ref(false);
const canAi = computed(() => can(UI.paDashboardAi));
const canSearch = computed(() => can(NETOPS.paSearch));

// ---------- 有資料的日期 ----------
const days = ref<PaDay[]>([]);
const daysLoaded = ref(false);
const daysError = ref<Error | null>(null);
const range = reactive({ from: '', to: '' });
/** ClickHouse 實際有資料的範圍(C3 D43) */
const coverage = ref<Coverage | null>(null);

async function loadDays() {
  try {
    const r = await pa.days();
    days.value = r.days;
    coverage.value = r.coverage;
    daysError.value = null;
    const latest = days.value[0]?.day;
    if (!range.from && latest) Object.assign(range, { from: latest, to: latest });
  } catch (e) {
    daysError.value = e as Error;
  } finally {
    daysLoaded.value = true;
  }
}

// ---------- 總覽 ----------
const data = shallowRef<PaOverview | null>(null);
const loading = ref(false);
const loadError = ref<Error | null>(null);
const rangeError = computed(() => {
  if (!range.from || !range.to) return days.value.length ? '請選擇開始與結束日期' : '';
  if (range.from > range.to) return '開始日期不可晚於結束日期';
  if (daysBetween(range.from, range.to) > MAX_DAYS) return `期間最長 ${MAX_DAYS} 天`;
  return '';
});
let seq = 0;

async function load() {
  if (rangeError.value) {
    seq++;
    data.value = null;
    loadError.value = null;
    loading.value = false;
    return;
  }
  if (!range.from) return;
  const my = ++seq;
  loading.value = true;
  loadError.value = null;
  try {
    const r = await pa.overview(range.from, range.to, TOP);
    if (my === seq) data.value = r;
  } catch (e) {
    if (my === seq) loadError.value = e as Error;
  } finally {
    if (my === seq) loading.value = false;
  }
}
// 改日期時稍等再送出(期間最長 92 天,連續修改不要每次都送)
const DEBOUNCE_MS = 300;
let debounce: ReturnType<typeof setTimeout> | undefined;
watch(
  () => [range.from, range.to],
  () => {
    clearTimeout(debounce);
    debounce = setTimeout(load, DEBOUNCE_MS);
  },
);
onBeforeUnmount(() => clearTimeout(debounce));

async function refresh() {
  clearTimeout(debounce);
  const before = `${range.from}|${range.to}`;
  await loadDays();
  // 第一次載入時 loadDays 會設定期間,由 watch 載入;期間沒變才自己載入
  if (`${range.from}|${range.to}` === before) await load();
}
onMounted(refresh);

const incomplete = computed(() => {
  const d = data.value;
  if (!d) return '';
  const why = [
    d.topsState === 'not-ready' ? '服務剛啟動,排行還在建立' : '',
    d.topsState === 'stale' ? '排行太久沒更新(ClickHouse 可能停止)' : '',
    d.missing ? `${d.missing} 小時的排行還沒建好` : '',
    d.import.failed && d.topsState === 'ok' ? '上一輪排行更新失敗' : '',
  ];
  return why.filter(Boolean).join('、');
});

// ---------- 帶條件到明細查詢 ----------
/** 明細查詢的時間條件:YYYY-MM-DDTHH:mm(本地時間;明細查詢頁轉成 ISO 8601) */
/** 預設用畫面上資料的期間(換期間載入中時畫面仍是舊資料) */
function search(cond: SearchCond, from = `${data.value?.from ?? range.from}T00:00`, to = `${data.value?.to ?? range.to}T23:59`) {
  if (!canSearch.value) return;
  void router.push({ path: '/firewall/search', query: { from, to, ...cond } });
}
const pick = (name: string, key: string) => {
  const f = PICK[name];
  if (f) search(f(key));
};
/** KPI 卡片可點選時的屬性(滑鼠與鍵盤);沒有明細查詢權限時只顯示數字 */
function clickable(fn: () => void) {
  if (!canSearch.value) return {};
  return {
    role: 'button',
    tabindex: 0,
    class: 'click',
    onClick: fn,
    onKeydown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      fn();
    },
  };
}

// ---------- 每小時 ----------
const metric = ref<'n' | 'bytes'>('n');
const hourChart = computed(() => {
  const h = data.value?.hours ?? [];
  const multiDay = h.length > 24;
  const labels = h.map((x) => (multiDay ? x.hour.slice(5, 13).replace('T', ' ') : x.hour.slice(11, 13)));
  const series =
    metric.value === 'bytes'
      ? [{ name: '流量', values: h.map((x) => x.bytes), tone: 'primary' }]
      : [
          { name: '允許', values: h.map((x) => x.allow), tone: 'success' },
          { name: '阻擋', values: h.map((x) => x.block), tone: 'danger' },
        ];
  // 提示框:完整時間 + 圖上沒有的數字(同舊版:連線數、允許、阻擋與比例、流量)
  const titles = h.map((x) => `${x.hour.slice(0, 10)} ${x.hour.slice(11, 13)}:00`);
  const extra = h.map((x) => [
    { label: '連線數', value: fmtNum(x.n) },
    ...(metric.value === 'bytes'
      ? [
          { label: '允許', value: fmtNum(x.allow) },
          { label: '阻擋', value: fmtNum(x.block) },
        ]
      : [{ label: '流量', value: fmtSize(x.bytes) }]),
    { label: '阻擋比例', value: fmtPct(x.block, x.n) },
  ]);
  return { labels, titles, series, extra, format: metric.value === 'bytes' ? (v: number) => fmtSize(v) : fmtShort, integer: metric.value === 'n' };
});
/** 點長條 → 該小時的明細(hour 為該小時開始時間 +08:00,取「YYYY-MM-DDTHH」) */
function openHour(i: number) {
  const h = data.value?.hours[i];
  if (!h) return;
  const head = h.hour.slice(0, 13);
  search({}, `${head}:00`, `${head}:59`);
}

// ---------- 排行 ----------
const view = reactive<Record<string, 'n' | 'bytes'>>({ src: 'n', dst: 'n', app: 'n', ai: 'n' });
const NB = [
  { label: '次數', value: 'n' },
  { label: '流量', value: 'bytes' },
];
const top = (name: string, by: 'n' | 'bytes' = 'n'): TopEntry[] => (by === 'bytes' ? data.value?.topBytes?.[name] : data.value?.top?.[name]) ?? [];
const pairs = (name: string) => [...top(name), ...top(name, 'bytes')];
const actions = computed(() =>
  Object.entries(data.value?.actions ?? {})
    .map(([k, n]) => ({ k, n }))
    .sort((a, b) => b.n - a.n),
);
const scanColumns = [
  { key: 'src', label: '來源 IP', mono: true },
  { key: 'zone', label: '區域流向', hideSm: true },
  { key: 'n', label: '被擋次數', align: 'right' as const, width: '100px' },
  { key: 'dsts', label: '不同目的 IP', align: 'right' as const, width: '110px' },
  { key: 'ports', label: '不同目的 Port', align: 'right' as const, width: '120px' },
  { key: 'verdict', label: '研判', width: '140px', hideSm: true },
];
type ScanRow = PaOverview['scan'][number];
const asScan = (r: unknown) => r as ScanRow;
const many = (n: number) => (n >= 1000 ? '1000+' : String(n));
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <Teleport to="#page-actions" defer>
      <GButton icon="refresh" :loading="loading" @click="() => void refresh()">重新整理</GButton>
      <GButton v-if="canAi" icon="sparkles" :disabled="!range.from || !!rangeError || !data?.files" @click="aiOpen = true">AI 分析</GButton>
    </Teleport>

    <GCard padding="sm">
      <div class="filters">
        <DateRangeField v-model:from="range.from" v-model:to="range.to" :max-days="MAX_DAYS" :coverage="coverage" :disabled="!days.length" class="date" />
        <p class="small muted hint">
          <template v-if="data?.timeMin">資料時間 {{ fmtTime(data.timeMin) }} ~ {{ fmtTime(data.timeMax) }},{{ data.files }} 小時有資料</template>
          <template v-if="days.length"> · {{ coverageText(coverage) }}</template>
        </p>
      </div>
      <p v-if="rangeError" class="small c-danger err">{{ rangeError }}</p>
    </GCard>

    <GAlert v-if="daysError && days.length" tone="danger">重新取得有資料的日期失敗,以下是上次的清單:{{ describeError(daysError) }}</GAlert>
    <GCard v-if="daysError && !days.length">
      <GEmpty tone="danger" icon="shield-check" title="無法取得有資料的日期" :description="describeError(daysError)">
        <GButton icon="refresh" @click="() => void refresh()">重試</GButton>
      </GEmpty>
    </GCard>
    <GCard v-else-if="daysLoaded && !days.length">
      <GEmpty icon="activity" title="還沒有 PA TRAFFIC 資料" description="PA-560 轉送的 log 會即時寫進 ClickHouse;收到第一筆後這裡就會有資料。" />
    </GCard>
    <GCard v-else-if="loadError && !data">
      <GEmpty tone="danger" icon="shield-check" title="無法載入流量總覽" :description="describeError(loadError)">
        <GButton icon="refresh" @click="load">重試</GButton>
      </GEmpty>
    </GCard>
    <div v-else-if="!data && !rangeError" class="grid grid-auto">
      <GCard v-for="i in 5" :key="i" padding="sm"><GSkeleton :lines="2" /></GCard>
    </div>

    <template v-if="data">
      <GAlert v-if="loadError" tone="danger">重新載入失敗,以下是 {{ data.from }} ~ {{ data.to }} 的結果:{{ describeError(loadError) }}</GAlert>
      <GAlert v-else-if="data.from !== range.from || data.to !== range.to" tone="info">
        以下是 {{ data.from }} ~ {{ data.to }} 的結果{{ loading ? ',新的期間載入中…' : '' }}
      </GAlert>
      <GAlert v-if="!data.files" tone="warning" title="這段期間沒有資料">ClickHouse 這段期間沒有收到 log;{{ coverageText(data.coverage) }}。</GAlert>
      <GAlert v-if="data.partial" tone="info" title="期間有一部分超過保留期限">{{ data.coverage.from }} 之前沒有資料,統計只含 {{ data.coverage.from }} 起。</GAlert>
      <GAlert v-if="incomplete" tone="warning" title="排行不完整">{{ incomplete }};筆數與每小時統計是完整的。</GAlert>

      <!-- KPI -->
      <div class="grid kpis">
        <GStatCard label="連線紀錄" :value="fmtShort(data.rows)" icon="activity" :hint="`${fmtNum(data.rows)} 筆`" />
        <GStatCard
          v-bind="clickable(() => search({ action: 'allow' }))"
          label="允許"
          :value="fmtShort(data.allow)"
          icon="check-circle"
          tone="success"
          :hint="fmtPct(data.allow, data.rows)"
        />
        <GStatCard
          v-bind="clickable(() => search({ action: 'block' }))"
          label="阻擋(deny / drop / reset)"
          :value="fmtShort(data.block)"
          icon="x-circle"
          tone="danger"
          :hint="fmtPct(data.block, data.rows)"
        />
        <GStatCard label="總流量" :value="fmtSize(data.bytes)" icon="gauge" :hint="`送出 ${fmtSize(data.sent)} · 接收 ${fmtSize(data.recv)}`" />
        <GStatCard
          label="目標分散的被擋來源"
          :value="data.scan.length"
          icon="alert"
          :tone="data.scan.length ? 'warning' : 'success'"
          hint="被擋且目的 IP 或 Port ≥ 20 個"
        />
      </div>

      <!-- 每小時 -->
      <GCard :title="`每小時${metric === 'bytes' ? '流量' : '連線數'}`" icon="clock">
        <template #actions>
          <GSegmented
            v-model="metric"
            size="sm"
            :options="[
              { label: '連線數', value: 'n' },
              { label: '流量', value: 'bytes' },
            ]"
          />
        </template>
        <GStackedBars
          :labels="hourChart.labels"
          :titles="hourChart.titles"
          :integer="hourChart.integer"
          :series="hourChart.series"
          :extra="hourChart.extra"
          :format="hourChart.format"
          :clickable="canSearch"
          pick-hint="點長條查看該小時明細"
          @pick="openHour"
        />
      </GCard>

      <!-- 流量排行 -->
      <div class="grid tops">
        <TopList
          v-for="t in [
            { key: 'src', title: '來源 IP' },
            { key: 'dst', title: '目的 IP' },
            { key: 'app', title: '應用程式' },
          ]"
          :key="t.key"
          :title="t.title"
          :items="top(t.key, view[t.key])"
          :by-bytes="view[t.key] === 'bytes'"
          show-bytes
          :pickable="() => canSearch"
          @pick="(k) => pick(t.key, k)"
        >
          <template #extra><GSegmented v-model="view[t.key]!" size="sm" :options="NB" /></template>
        </TopList>
        <TopList
          v-for="t in [
            { key: 'dport', title: '目的 Port' },
            { key: 'zone', title: '區域流向' },
            { key: 'dstCountry', title: '目的國家 / 區段' },
          ]"
          :key="t.key"
          :title="t.title"
          :items="top(t.key)"
          show-bytes
          :pickable="() => canSearch"
          @pick="(k) => pick(t.key, k)"
        />
      </div>

      <!-- 資料外流與 AI 應用(依上傳 = 送出位元組;內部 IP → 公網 IP 且允許的連線) -->
      <h2 class="section">資料外流與 AI 應用</h2>
      <div class="grid tops">
        <TopList
          title="上傳到外部最多的內部 IP"
          tone="warning"
          by-bytes
          :items="top('upSrc', 'bytes')"
          hint="內部 IP 送到公網的資料量(只算送出,不含下載);大量集中上傳可能是異地備份,也可能是資料外流"
          :pickable="() => canSearch"
          @pick="(k) => pick('upSrc', k)"
        />
        <TopList
          title="高風險管道上傳的內部 IP"
          tone="danger"
          by-bytes
          :items="withApps(top('upRiskSrc', 'bytes'), pairs('upRiskPair'))"
          hint="檔案分享、雲端儲存、加密通道(SSH / VPN)、郵件、遠端存取、即時通訊、P2P"
          :pickable="() => canSearch"
          @pick="(k) => pick('upRiskSrc', k)"
        />
        <TopList
          title="上傳管道(App)排行"
          tone="danger"
          by-bytes
          :items="top('upRiskApp', 'bytes')"
          :pickable="() => canSearch"
          @pick="(k) => pick('upRiskApp', k)"
        />
        <TopList
          title="上傳最多的外部目的地"
          tone="warning"
          by-bytes
          :items="top('upDst', 'bytes')"
          :pickable="() => canSearch"
          @pick="(k) => pick('upDst', k)"
        />
        <TopList
          title="使用 AI 應用的內部 IP"
          :by-bytes="view.ai === 'bytes'"
          show-bytes
          :items="withApps(top('aiSrc', view.ai), pairs('aiPair'))"
          hint="PA App-ID 子分類 artificial-intelligence(ChatGPT、Gemini、Claude、Copilot…);流量為上傳到 AI 的資料量"
          :pickable="() => canSearch"
          @pick="(k) => pick('aiSrc', k)"
        >
          <template #extra
            ><GSegmented
              v-model="view.ai!"
              size="sm"
              :options="[
                { label: '次數', value: 'n' },
                { label: '上傳量', value: 'bytes' },
              ]"
          /></template>
        </TopList>
        <TopList title="AI 應用排行" show-bytes :items="top('aiApp')" :pickable="() => canSearch" @pick="(k) => pick('aiApp', k)" />
      </div>

      <!-- 阻擋與風險 -->
      <h2 class="section">阻擋與風險</h2>
      <div class="grid tops">
        <TopList title="被擋最多的來源 IP" tone="danger" :items="top('blockSrc')" :pickable="() => canSearch" @pick="(k) => pick('blockSrc', k)" />
        <TopList title="被擋最多的目的 IP" tone="danger" :items="top('blockDst')" :pickable="() => canSearch" @pick="(k) => pick('blockDst', k)" />
        <TopList title="被擋最多的目的 Port" tone="danger" :items="top('blockDport')" :pickable="() => canSearch" @pick="(k) => pick('blockDport', k)" />
        <TopList
          title="外部(公網)被擋的來源"
          tone="danger"
          hint="來源區域為 WAN、來源為公網 IP 的阻擋紀錄"
          :items="top('inboundBlockSrc')"
          :pickable="() => canSearch"
          @pick="(k) => pick('inboundBlockSrc', k)"
        />
        <TopList
          title="外部(公網)允許連入"
          tone="warning"
          hint="來源為公網 IP 且被允許連入,請確認都是預期對外開放的服務"
          :items="top('inboundAllow')"
          :pickable="() => canSearch"
          @pick="(k) => pick('inboundAllow', k)"
        />
        <TopList
          title="高風險應用程式(風險 ≥ 4,允許)"
          tone="warning"
          hint="不含 ssl、web-browsing、ms-update 等一般上網 / 更新"
          :items="top('riskApp')"
          show-bytes
          :pickable="() => canSearch"
          @pick="(k) => pick('riskApp', k)"
        />
        <TopList title="阻擋規則" tone="danger" :items="top('blockRule')" :pickable="() => canSearch" @pick="(k) => pick('blockRule', k)" />
        <TopList title="規則命中" :items="top('rule')" :pickable="() => canSearch" @pick="(k) => pick('rule', k)" />
        <GCard title="動作分布" padding="sm">
          <ul class="acts">
            <li v-for="a in actions" :key="a.k">
              <button type="button" :disabled="!canSearch" @click="search({ action: a.k })">
                <GBadge :tone="actionOf(a.k).tone" dot>{{ actionOf(a.k).label }}</GBadge>
                <span class="muted small">{{ a.k }}</span>
                <span class="num n">{{ fmtNum(a.n) }}</span>
                <span class="num faint pct">{{ fmtPct(a.n, data.rows) }}</span>
              </button>
            </li>
          </ul>
          <h4 class="sub">連線結束原因</h4>
          <ul class="ends small">
            <li v-for="x in top('endReason').slice(0, 8)" :key="x.key">
              <span class="ellipsis">{{ x.key }}</span
              ><span class="num muted">{{ fmtNum(x.n) }}</span>
            </li>
          </ul>
        </GCard>
      </div>

      <!-- 疑似掃描 -->
      <GCard
        padding="none"
        title="被擋且目標分散的來源(疑似掃描 / 異常連線)"
        subtitle="同一來源被擋的連線中,目的 IP 或目的 Port 有 20 個以上。Port 多 = 疑似 Port 掃描;IP 多 = 疑似主機掃描或程式不斷嘗試連線。數量為各 log 檔中的最大值。"
        icon="alert"
      >
        <GTable
          :rows="data.scan"
          row-key="src"
          :page-size="10"
          dense
          :clickable="canSearch"
          :columns="scanColumns"
          empty-title="沒有發現"
          @row-click="(r) => search({ src: asScan(r).src, action: 'block' })"
        >
          <template #cell-n="{ row }"
            ><span class="num">{{ fmtNum(asScan(row).n) }}</span></template
          >
          <template #cell-dsts="{ row }"
            ><span class="num" :class="{ 'c-danger strong': asScan(row).dsts >= 100 }">{{ many(asScan(row).dsts) }}</span></template
          >
          <template #cell-ports="{ row }"
            ><span class="num" :class="{ 'c-danger strong': asScan(row).ports >= 50 }">{{ many(asScan(row).ports) }}</span></template
          >
          <template #cell-verdict="{ row }">
            <GBadge :tone="scanVerdict(asScan(row)).tone" dot>{{ scanVerdict(asScan(row)).label }}</GBadge>
          </template>
        </GTable>
      </GCard>
    </template>
    <AiAnalysis v-model="aiOpen" :from="range.from" :to="range.to" />
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  align-items: flex-end;
}
.date {
  width: 300px;
  max-width: 100%;
}
.hint {
  margin: 0 0 8px;
}
.err {
  margin: 8px 0 0;
}
.kpis {
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
}
.click {
  cursor: pointer;
}
.click:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.tops {
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
}
.section {
  margin: var(--space-2) 0 0;
  font-size: var(--fs-lg);
}
.acts,
.ends {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.acts button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.acts button:hover:not(:disabled) {
  background: var(--glass-soft);
}
.acts button:disabled {
  cursor: default;
}
.acts .n {
  margin-left: auto;
}
.acts .pct {
  width: 4em;
  text-align: right;
}
.sub {
  margin: var(--space-4) 0 var(--space-2);
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.ends li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 6px;
  min-width: 0;
}
@media (max-width: 760px) {
  .date {
    flex: 1 1 100%;
    width: auto;
  }
  .tops {
    grid-template-columns: 1fr;
  }
}
</style>
