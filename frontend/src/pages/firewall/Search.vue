<script setup lang="ts">
/**
 * 防火牆 › Log 明細查詢(docs/API.md §4.3;舊版 src/views/PaSearch.vue):
 *   C3 D43 起後端只查 ClickHouse(保留 30 天)。工作模式(ARCHITECTURE D6):
 *   送出 → 每 1.5 秒查詢進度 → 完成後分頁讀取結果(每頁 50 筆)、匯出 CSV(後端產生)。可隨時停止;離開頁面自動取消。
 *   流量總覽點選會帶 ?from=&to=&src=… 進來並自動查詢;網址條件只收白名單與格式正確的值(composables/searchQuery.ts)。
 *   期間最長 30 天(只用關鍵字最長 1 天);目的 Port 只能是數字與逗號(後端同樣檢查)。
 *   type=THREAT 查威脅 log(需求方 2026-11-13 決定),可再用威脅名稱、嚴重度;國家可分來源 / 目的(srcCountry / dstCountry)。
 *   時段明細抽屜的威脅類會帶 type=THREAT、threat、severity(useSlice.openInSearch;C7);無法套用的條件(不認得的類型等)提示「未套用」(AGENT §5)。
 *   版面是最小可用版(類型、威脅名稱、嚴重度、來源 / 目的國家欄位與威脅欄位),樣式之後交 Gemini。
 */
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { describeError, download } from '@/api/gateway';
import { fmtNum, fmtSize, fmtTime } from '@/api/format';
import {
  actionOf,
  pa,
  PA_FIELD_LABELS,
  PA_SEARCH_KEYS,
  PA_SEARCH_MAX_DAYS,
  paLog,
  type PaLogRow,
  type PaOptions,
  type PaSearchBody,
  type PaSearchKey,
} from '@/api/pa';
import { cameFromApp, ignoredThreatCond as threatCondOf, isPorts, isSearchType, isSeverity, localToIso, pickQuery, toLocalInput } from '@/composables/searchQuery';
import { useJob } from '@/composables/useJob';
import { ipNameOf, ipNameTitle } from '@/composables/ipNames';
import DateRangeField from '@/components/DateRangeField.vue';
import { coverageText } from '@/composables/dateRange';
import type { Coverage } from '@/api/pa';
import { toast } from '@/ui';

const PAGE_SIZE = 50;
const route = useRoute();
/** 網址帶了本頁無法套用的條件:進頁時算一次(自動查詢會改寫網址;C7 第二輪) */
const ignoredThreatCond = threatCondOf(route.query);
const router = useRouter();

const form = reactive<Record<PaSearchKey, string> & { from: string; to: string }>({
  from: '',
  to: '',
  ...(Object.fromEntries(PA_SEARCH_KEYS.map((k) => [k, ''])) as Record<PaSearchKey, string>),
});
/** 使用者 / 部門(IP 對照表名稱搜尋,AC3):個資,不寫進網址,重新整理後要重填 */
const nameQuery = ref('');
/** ClickHouse 實際有資料的範圍(C3 D43) */
const coverage = ref<Coverage | null>(null);
const formError = computed(() => {
  if (!form.from || !form.to) return '請選擇查詢時間';
  if (form.from > form.to) return '開始時間不可晚於結束時間';
  if ((new Date(form.to).getTime() - new Date(form.from).getTime()) / 86_400_000 > PA_SEARCH_MAX_DAYS) return `期間最長 ${PA_SEARCH_MAX_DAYS} 天`;
  if (form.port.trim() && !isPorts(form.port.trim())) return '目的 Port 請輸入數字,多個以逗號分隔';
  return '';
});

// ---------- 下拉選項(期間內出現過的值;網址帶進來的值不在清單時也保留) ----------
const options = shallowRef<PaOptions>({ apps: [], rules: [], zones: [], actions: [] });
let optSeq = 0;
async function loadOptions() {
  const from = form.from.slice(0, 10);
  if (!from) return;
  const my = ++optSeq;
  try {
    const r = await pa.options(from, form.to.slice(0, 10) || from);
    if (my === optSeq) options.value = r;
  } catch {
    // 選項只是方便輸入,失敗時仍可查詢(下拉只剩目前的值)
    if (my === optSeq) options.value = { apps: [], rules: [], zones: [], actions: [] };
  }
}
watch(() => [form.from.slice(0, 10), form.to.slice(0, 10)], loadOptions);
const opts = (list: string[], current: string, label = (v: string) => v) =>
  [...new Set([...(current ? [current] : []), ...list])].map((v) => ({ label: label(v), value: v }));
const actionOptions = computed(() => [
  { label: '允許', value: 'allow' },
  { label: '阻擋(全部)', value: 'block' },
  ...opts(
    options.value.actions.filter((a) => a !== 'allow' && a !== 'block'),
    ['allow', 'block'].includes(form.action) ? '' : form.action,
    (a) => `${actionOf(a).label}(${a})`,
  ),
]);
const PROTOS = ['tcp', 'udp', 'icmp'].map((v) => ({ label: v, value: v }));
const TYPES = [
  { label: '流量(TRAFFIC)', value: 'TRAFFIC' },
  { label: '威脅(THREAT)', value: 'THREAT' },
];
const SEVERITIES = [
  { label: '嚴重', value: 'critical' },
  { label: '高', value: 'high' },
  { label: '中', value: 'medium' },
  { label: '低', value: 'low' },
  { label: '資訊', value: 'info' },
];
const isThreatForm = computed(() => form.type === 'THREAT');

// ---------- 查詢(工作模式) ----------
const job = useJob({ create: paLog.create, get: paLog.get, cancel: paLog.cancel });
const result = job.result;
const progress = computed(() => job.job.value?.progress ?? null);
const rows = shallowRef<PaLogRow[]>([]);
const total = ref(0);
const page = ref(1);
const rowsLoading = ref(false);
const rowsError = ref<Error | null>(null);
let rowsSeq = 0;
/** 畫面上資料的頁碼(GTable 換頁時已先改了 page;失敗要還原) */
let shownPage = 1;

async function fetchRows(p: number) {
  const id = job.job.value?.id;
  if (!id || !result.value) return;
  const my = ++rowsSeq;
  rowsLoading.value = true;
  rowsError.value = null;
  try {
    const r = await paLog.rows(id, p, PAGE_SIZE);
    if (my !== rowsSeq) return;
    rows.value = r.items;
    total.value = r.total;
    page.value = shownPage = r.page;
  } catch (e) {
    if (my === rowsSeq) {
      rowsError.value = e as Error;
      page.value = shownPage;
    }
  } finally {
    if (my === rowsSeq) rowsLoading.value = false;
  }
}
// 工作完成就讀第一頁
watch(result, (r) => {
  rows.value = [];
  total.value = 0;
  if (r) void fetchRows(1);
});

function search() {
  // 查詢中按 Enter 不重送(要重查請先停止)
  if (job.running.value) return;
  if (formError.value) return toast.warning(formError.value);
  // 威脅名稱、嚴重度只有威脅 log 有(後端 TRAFFIC 帶這兩個條件回 400);類型是 TRAFFIC 時不送
  const skip = new Set<PaSearchKey>(isThreatForm.value ? [] : ['threat', 'severity']);
  const cond = Object.fromEntries(PA_SEARCH_KEYS.filter((k) => !skip.has(k)).map((k) => [k, form[k].trim()]).filter(([, v]) => v)) as Partial<Record<PaSearchKey, string>>;
  // 條件記在網址:重新整理或分享連結可還原(時間用本地時間,不含時區)
  void router.replace({ query: { from: form.from, to: form.to, ...cond } });
  const body: PaSearchBody = { from: localToIso(form.from), to: localToIso(form.to), ...cond, ...(nameQuery.value.trim() ? { name: nameQuery.value.trim() } : {}) };
  rowsSeq++;
  rows.value = [];
  total.value = 0;
  page.value = shownPage = 1;
  void job.start(body);
}

function reset() {
  for (const k of PA_SEARCH_KEYS) form[k] = '';
  nameQuery.value = '';
}

const stopText = computed(() => {
  const r = result.value;
  if (!r) return '';
  const partial = r.partial && r.coverage ? `期間有一部分超過保留期限:${r.coverage.from} 之前沒有資料` : '';
  // 兩種提示都要看得到(程式碼審查 #9)
  if (r.stopReason === 'limit') return [`已達上限 ${fmtNum(r.limit)} 筆,後面還有資料,請縮小時間或加條件`, partial].filter(Boolean).join(';');
  if (partial) return partial;
  if (r.stopReason === 'timeout') return `掃描超過時間上限或等不到 FTP 連線,只查了 ${r.filesScanned} / ${r.files} 個檔案,結果不完整;請縮小時間或加條件`;
  if (r.stopReason === 'closed') return `服務正在關閉,只查了 ${r.filesScanned} / ${r.files} 個檔案,結果不完整;請稍後重新查詢`;
  if (r.stopReason === 'error') return `讀取 FTP 時發生錯誤,只查了 ${r.filesScanned} / ${r.files} 個檔案,結果不完整;請稍後重新查詢`;
  return '';
});

const exporting = ref(false);
async function exportCsv() {
  const id = job.job.value?.id;
  const r = result.value;
  if (!id || !r) return;
  exporting.value = true;
  try {
    const stamp = (s: string) => s.slice(0, 16).replace(/\D/g, '');
    await download(paLog.exportPath(id), undefined, `PA_log_${stamp(r.from)}_${stamp(r.to)}.csv`);
  } catch (e) {
    toast.fromError(e, '匯出失敗');
  } finally {
    exporting.value = false;
  }
}

// ---------- 明細 ----------
const detail = ref<PaLogRow | null>(null);
const detailOpen = computed({ get: () => !!detail.value, set: (v) => !v && (detail.value = null) });
const BYTES = new Set(['bytes', 'sent', 'recv']);
/** 明細的 IP 欄位附上 IP 對照表名稱(AC3) */
const IP_FIELDS = new Set<keyof PaLogRow>(['src', 'dst', 'natSrc', 'natDst']);
const withName = (v: string, isIp: boolean) => {
  const l = isIp ? ipNameOf(v) : undefined;
  return l ? `${v}(${ipNameTitle(l)})` : v;
};
const detailFields = computed(() => {
  const d = detail.value;
  if (!d) return [];
  return (Object.keys(PA_FIELD_LABELS) as (keyof PaLogRow)[])
    .filter((k) => d[k] !== '' && d[k] !== 0 && d[k] != null)
    .map((k) => ({
      label: PA_FIELD_LABELS[k],
      value: k === 'time' ? fmtTime(d.time) : BYTES.has(k) ? `${fmtSize(d[k] as number)}(${fmtNum(d[k] as number)})` : withName(String(d[k]), IP_FIELDS.has(k)),
    }));
});

const pad = (n: number) => String(n).padStart(2, '0');
const localMinute = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

onMounted(async () => {
  const q = route.query;
  Object.assign(form, pickQuery(q, PA_SEARCH_KEYS, { proto: (v) => /^[a-z0-9-]{1,16}$/i.test(v), port: isPorts, type: isSearchType, severity: isSeverity }));
  // 威脅名稱、嚴重度只有 THREAT 用:不是 THREAT 時不留在表單(否則之後切到 THREAT 會默默送出;已列在「未套用」提示;程式碼審查)
  if (form.type !== 'THREAT') Object.assign(form, { threat: '', severity: '' });
  // 資料範圍一律先載入(網址帶條件進來時也要顯示可查範圍;程式碼審查 #2),失敗只影響提示
  const days = pa.days().then(
    (r) => ((coverage.value = r.coverage), r),
    (e) => (toast.fromError(e, '無法取得有資料的日期'), null),
  );
  const from = toLocalInput(q.from);
  if (from) {
    Object.assign(form, { from, to: toLocalInput(q.to || q.from, true) || toLocalInput(q.from, true) });
    // 從總覽點選進來才自動查詢;外部連結只填條件
    if (cameFromApp()) search();
    return;
  }
  // 預設:最新一天有資料的最後一小時(今天則是最近 1 小時)
  {
    const r = await days;
    const day = r?.days[0]?.day;
    if (!day) return;
    const end = new Date(Math.min(new Date(`${day}T23:59:00`).getTime(), Date.now()));
    Object.assign(form, { from: localMinute(new Date(end.getTime() - 59 * 60_000)), to: localMinute(end) });
  }
});

const TRAFFIC_COLUMNS = [
  { key: 'time', label: '時間', width: '170px' },
  { key: 'action', label: '動作', width: '100px' },
  { key: 'src', label: '來源 IP', mono: true, ip: true },
  { key: 'dst', label: '目的 IP', mono: true, ip: true },
  { key: 'dport', label: 'Port', width: '90px' },
  { key: 'app', label: '應用程式', hideSm: true },
  { key: 'rule', label: '規則', hideSm: true },
  { key: 'zone', label: '區域', hideSm: true },
  { key: 'srcUser', label: '使用者', hideSm: true },
  { key: 'bytes', label: '流量', align: 'right' as const, width: '90px', hideSm: true },
  { key: 'dstCountry', label: '目的國家', hideSm: true },
];
/** 威脅 log 的欄位(威脅名稱、嚴重度、來源 / 目的、動作;版面之後交 Gemini) */
const THREAT_COLUMNS = [
  { key: 'time', label: '時間', width: '170px' },
  { key: 'severity', label: '嚴重度', width: '90px' },
  { key: 'threat', label: '威脅名稱' },
  { key: 'action', label: '動作', width: '100px' },
  { key: 'src', label: '來源 IP', mono: true, ip: true },
  { key: 'dst', label: '目的 IP', mono: true, ip: true },
  { key: 'dport', label: 'Port', width: '90px' },
  { key: 'app', label: '應用程式', hideSm: true },
  { key: 'srcCountry', label: '來源國家', hideSm: true },
];
const columns = computed(() => (result.value?.type === 'THREAT' ? THREAT_COLUMNS : TRAFFIC_COLUMNS));
const keyed = computed(() => rows.value.map((r, i) => ({ ...r, _k: `${page.value}:${i}` })));
const asRow = (r: unknown) => r as PaLogRow;
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <GAlert v-if="ignoredThreatCond" tone="info">連結帶的條件 {{ ignoredThreatCond }} 本頁無法套用,未套用;其他條件照查。</GAlert>
    <GCard padding="sm">
      <form class="stack" style="--gap: 12px" @submit.prevent="search">
        <div class="filters">
          <DateRangeField v-model:from="form.from" v-model:to="form.to" mode="datetime" label="查詢時間" :max-days="PA_SEARCH_MAX_DAYS" :coverage="coverage" class="dt" />
          <GInput v-model="form.src" label="來源 IP" placeholder="10.10.124.* 或 /16" clearable class="md" />
          <GInput v-model="form.dst" label="目的 IP" clearable class="md" />
          <GInput v-model="form.ip" label="任一方 IP" clearable class="md" />
          <GInput v-model="nameQuery" label="使用者 / 部門" placeholder="IP 對照表的姓名、部門或設備" clearable class="md" />
          <GInput v-model="form.port" label="目的 Port" placeholder="443,3389" clearable class="sm" />
          <GSelect v-model="form.proto" label="協定" :options="PROTOS" placeholder="全部" class="sm" />
          <GSelect v-model="form.action" label="動作" :options="actionOptions" placeholder="全部" class="md" />
          <GSelect v-model="form.app" label="應用程式" :options="opts(options.apps, form.app)" placeholder="全部" class="md" />
          <GSelect v-model="form.rule" label="規則" :options="opts(options.rules, form.rule)" placeholder="全部" class="md" />
          <GSelect v-model="form.fromZone" label="來源區域" :options="opts(options.zones, form.fromZone)" placeholder="全部" class="sm" />
          <GSelect v-model="form.toZone" label="目的區域" :options="opts(options.zones, form.toZone)" placeholder="全部" class="sm" />
          <GInput v-model="form.user" label="使用者" clearable class="sm" />
          <GSelect v-model="form.type" label="類型" :options="TYPES" placeholder="流量(TRAFFIC)" class="sm" />
          <GInput v-if="isThreatForm" v-model="form.threat" label="威脅名稱" clearable class="md" />
          <GSelect v-if="isThreatForm" v-model="form.severity" label="嚴重度" :options="SEVERITIES" placeholder="全部" class="sm" />
          <GInput v-model="form.country" label="國家(任一方)" placeholder="China" clearable class="sm" />
          <GInput v-model="form.srcCountry" label="來源國家" clearable class="sm" />
          <GInput v-model="form.dstCountry" label="目的國家" clearable class="sm" />
          <GInput v-model="form.q" label="關鍵字" placeholder="IP、App、規則等欄位包含" clearable class="md" />
        </div>
        <div class="filters">
          <span class="xs faint">查 ClickHouse({{ coverageText(coverage) }},最長 {{ PA_SEARCH_MAX_DAYS }} 天;只用關鍵字最長 1 天)。IP 可輸入 10.10.124.18、10.10.124.*、10.10.0.0/16;「使用者 / 部門」查 IP 對照表換成 IP 後查詢</span>
          <div class="spacer" />
          <span v-if="formError && (form.from || form.to)" class="small c-danger">{{ formError }}</span>
          <GButton icon="reset" @click="reset">清除條件</GButton>
          <GButton v-if="job.running.value" variant="danger" icon="square" @click="() => void job.cancel()">停止</GButton>
          <GButton v-else type="submit" variant="primary" icon="search">查詢</GButton>
        </div>
      </form>
    </GCard>

    <GCard padding="none" title="查詢結果" icon="list">
      <template #actions>
        <GButton v-if="result?.total" size="sm" icon="download" :loading="exporting" @click="exportCsv">匯出 CSV</GButton>
      </template>
      <div class="pad stack" style="--gap: 8px">
        <p v-if="job.running.value" class="small status">
          <span class="spin" aria-hidden="true" />
          查詢中…(其他人的查詢較多時會排隊)
        </p>
        <p v-else-if="result" class="small muted">
          <strong class="text">符合 {{ fmtNum(result.total) }} 筆</strong>
          · 讀取 {{ fmtNum(result.scanned) }} 列 · {{ result.seconds }} 秒
        </p>
        <p v-else-if="job.job.value?.status === 'cancelled'" class="small muted">已停止查詢</p>
        <p v-else-if="!job.error.value" class="small muted">選擇時間與條件後按「查詢」</p>
        <GAlert v-if="stopText" tone="warning">{{ stopText }}</GAlert>
        <GAlert v-if="job.error.value" tone="danger" title="查詢失敗">{{ describeError(job.error.value) }}</GAlert>
        <GAlert v-if="rowsError" tone="danger">{{ describeError(rowsError) }}</GAlert>
      </div>
      <GTable
        v-model:page="page"
        :loading="rowsLoading && !rows.length"
        :rows="keyed"
        :total="total"
        :page-size="PAGE_SIZE"
        row-key="_k"
        dense
        clickable
        :columns="columns"
        :empty-title="result ? '沒有符合的紀錄' : '尚未查詢'"
        @update:page="fetchRows"
        @row-click="(r) => (detail = asRow(r))"
      >
        <template #cell-time="{ row }">
          <span class="small num nowrap">{{ fmtTime(asRow(row).time) }}</span>
        </template>
        <template #cell-action="{ row }">
          <GBadge :tone="actionOf(asRow(row).action).tone" dot>{{ actionOf(asRow(row).action).label }}</GBadge>
        </template>
        <template #cell-dport="{ row }">
          <span class="small num nowrap">{{ asRow(row).proto }}/{{ asRow(row).dport }}</span>
        </template>
        <template #cell-zone="{ row }">
          <span class="small nowrap">{{ asRow(row).fromZone }} → {{ asRow(row).toZone }}</span>
        </template>
        <template #cell-bytes="{ row }">
          <span class="small num">{{ fmtSize(asRow(row).bytes) }}</span>
        </template>
      </GTable>
    </GCard>

    <GModal v-model:open="detailOpen" title="連線明細" :subtitle="detail ? fmtTime(detail.time) : ''" icon="file-text" width="760px">
      <dl class="detail small">
        <template v-for="f in detailFields" :key="f.label">
          <dt>{{ f.label }}</dt>
          <dd>{{ f.value }}</dd>
        </template>
      </dl>
      <template #footer>
        <GButton @click="detail = null">關閉</GButton>
      </template>
    </GModal>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 12px;
  align-items: flex-end;
}
.dt {
  width: 340px;
  max-width: 100%;
}
.sm {
  width: 130px;
}
.md {
  width: 180px;
}
.pad {
  padding: 0 var(--space-4) var(--space-3);
}
.pad p {
  margin: 0;
}
.text {
  color: var(--text);
}
.status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: var(--c-primary-text);
}
.spin {
  width: 14px;
  height: 14px;
  border: 2px solid var(--line);
  border-top-color: var(--c-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.detail {
  display: grid;
  grid-template-columns: max-content 1fr max-content 1fr;
  gap: 4px 14px;
  margin: 0;
}
.detail dt {
  color: var(--text-3);
}
.detail dd {
  margin: 0;
  word-break: break-all;
}
@media (max-width: 760px) {
  .dt {
    flex: 1 1 100%;
  }
  .sm,
  .md {
    flex: 1 1 140px;
    width: auto;
  }
  .detail {
    grid-template-columns: max-content 1fr;
  }
}
</style>
