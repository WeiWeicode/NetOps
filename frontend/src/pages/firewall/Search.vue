<script setup lang="ts">
/**
 * 防火牆 › Log 明細查詢(docs/API.md §4.3;舊版 src/views/PaSearch.vue):
 *   依時間挑出已分析的檔案,後端從 FTP 串流逐列篩選(原始 log 不落地)。改成工作模式(ARCHITECTURE D6):
 *   送出 → 每 1.5 秒查詢進度 → 完成後分頁讀取結果(每頁 50 筆)、匯出 CSV(後端產生)。可隨時停止;離開頁面自動取消。
 *   流量總覽點選會帶 ?from=&to=&src=… 進來並自動查詢;網址條件只收白名單與格式正確的值(composables/searchQuery.ts)。
 *   **待後端**:§4.3 在 feature/netops-b2-logs 尚未合併,目前只接本機假 API(mock/paLog.ts)。
 */
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { describeError, download } from '@/api/gateway';
import { fmtNum, fmtSize, fmtTime } from '@/api/format';
import { actionOf, pa, PA_FIELD_LABELS, PA_SEARCH_KEYS, paLog, type PaLogRow, type PaOptions, type PaSearchBody, type PaSearchKey } from '@/api/pa';
import { localToIso, pickQuery, toLocalInput } from '@/composables/searchQuery';
import { useJob } from '@/composables/useJob';
import { toast } from '@/ui';

const PAGE_SIZE = 50;
const route = useRoute();
const router = useRouter();

const form = reactive<Record<PaSearchKey, string> & { from: string; to: string }>({
  from: '',
  to: '',
  ...(Object.fromEntries(PA_SEARCH_KEYS.map((k) => [k, ''])) as Record<PaSearchKey, string>),
});
const formError = computed(() => {
  if (!form.from || !form.to) return '請選擇查詢時間';
  if (form.from > form.to) return '開始時間不可晚於結束時間';
  return '';
});

// ---------- 下拉選項(期間內出現過的值;網址帶進來的值不在清單時也保留) ----------
const options = shallowRef<PaOptions>({ apps: [], rules: [], zones: [], actions: [] });
async function loadOptions() {
  const from = form.from.slice(0, 10);
  if (!from) return;
  try {
    options.value = await pa.options(from, form.to.slice(0, 10) || from);
  } catch {
    // 選項只是方便輸入,失敗時仍可查詢(下拉只剩目前的值)
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
    page.value = r.page;
  } catch (e) {
    if (my === rowsSeq) rowsError.value = e as Error;
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
  if (formError.value) return toast.warning(formError.value);
  const cond = Object.fromEntries(PA_SEARCH_KEYS.map((k) => [k, form[k].trim()]).filter(([, v]) => v)) as Partial<Record<PaSearchKey, string>>;
  // 條件記在網址:重新整理或分享連結可還原(時間用本地時間,不含時區)
  void router.replace({ query: { from: form.from, to: form.to, ...cond } });
  const body: PaSearchBody = { from: localToIso(form.from), to: localToIso(form.to), ...cond };
  rowsSeq++;
  rows.value = [];
  total.value = 0;
  void job.start(body);
}

function reset() {
  for (const k of PA_SEARCH_KEYS) form[k] = '';
}

const stopText = computed(() => {
  const r = result.value;
  if (!r) return '';
  if (r.stopReason === 'limit') return `已達上限 ${fmtNum(r.limit)} 筆,後面還有資料,請縮小時間或加條件`;
  if (r.stopReason === 'timeout') return `掃描超過時間上限,只查了 ${r.filesScanned} / ${r.files} 個檔案,結果不完整;請縮小時間或加條件`;
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
const detailFields = computed(() => {
  const d = detail.value;
  if (!d) return [];
  return (Object.keys(PA_FIELD_LABELS) as (keyof PaLogRow)[])
    .filter((k) => d[k] !== '' && d[k] !== 0 && d[k] != null)
    .map((k) => ({
      label: PA_FIELD_LABELS[k],
      value: k === 'time' ? fmtTime(d.time) : BYTES.has(k) ? `${fmtSize(d[k] as number)}(${fmtNum(d[k] as number)})` : String(d[k]),
    }));
});

const pad = (n: number) => String(n).padStart(2, '0');
const localMinute = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

onMounted(async () => {
  const q = route.query;
  Object.assign(form, pickQuery(q, PA_SEARCH_KEYS, { proto: (v) => /^[a-z0-9-]{1,16}$/i.test(v), port: (v) => /^\d{1,5}(\s*,\s*\d{1,5})*$/.test(v) }));
  const from = toLocalInput(q.from);
  if (from) {
    Object.assign(form, { from, to: toLocalInput(q.to || q.from, true) || toLocalInput(q.from, true) });
    search();
    return;
  }
  // 預設:最新一天有資料的最後一小時(同舊版)
  try {
    const day = (await pa.days()).days[0]?.day;
    if (!day) return;
    const end = new Date(`${day}T23:59:00`);
    Object.assign(form, { from: localMinute(new Date(end.getTime() - 59 * 60_000)), to: localMinute(end) });
  } catch (e) {
    toast.fromError(e, '無法取得已分析的日期');
  }
});

const columns = [
  { key: 'time', label: '時間', width: '170px' },
  { key: 'action', label: '動作', width: '100px' },
  { key: 'src', label: '來源 IP', mono: true },
  { key: 'dst', label: '目的 IP', mono: true },
  { key: 'dport', label: 'Port', width: '90px' },
  { key: 'app', label: '應用程式', hideSm: true },
  { key: 'rule', label: '規則', hideSm: true },
  { key: 'zone', label: '區域', hideSm: true },
  { key: 'srcUser', label: '使用者', hideSm: true },
  { key: 'bytes', label: '流量', align: 'right' as const, width: '90px', hideSm: true },
  { key: 'dstCountry', label: '目的國家', hideSm: true },
];
const keyed = computed(() => rows.value.map((r, i) => ({ ...r, _k: `${page.value}:${i}` })));
const asRow = (r: unknown) => r as PaLogRow;
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <GAlert tone="info" title="待後端">明細查詢 API(docs/API.md §4.3)尚未合併,本機以假資料示範;測試區要等後端 feature/netops-b2-logs 上線。</GAlert>

    <GCard padding="sm">
      <form class="stack" style="--gap: 12px" @submit.prevent="search">
        <div class="filters">
          <GInput v-model="form.from" type="datetime-local" label="開始時間" class="dt" />
          <GInput v-model="form.to" type="datetime-local" label="結束時間" class="dt" />
          <GInput v-model="form.src" label="來源 IP" placeholder="10.10.124.* 或 /16" clearable class="md" />
          <GInput v-model="form.dst" label="目的 IP" clearable class="md" />
          <GInput v-model="form.ip" label="任一方 IP" clearable class="md" />
          <GInput v-model="form.port" label="目的 Port" placeholder="443,3389" clearable class="sm" />
          <GSelect v-model="form.proto" label="協定" :options="PROTOS" placeholder="全部" class="sm" />
          <GSelect v-model="form.action" label="動作" :options="actionOptions" placeholder="全部" class="md" />
          <GSelect v-model="form.app" label="應用程式" :options="opts(options.apps, form.app)" placeholder="全部" class="md" />
          <GSelect v-model="form.rule" label="規則" :options="opts(options.rules, form.rule)" placeholder="全部" class="md" />
          <GSelect v-model="form.fromZone" label="來源區域" :options="opts(options.zones, form.fromZone)" placeholder="全部" class="sm" />
          <GSelect v-model="form.toZone" label="目的區域" :options="opts(options.zones, form.toZone)" placeholder="全部" class="sm" />
          <GInput v-model="form.user" label="使用者" clearable class="sm" />
          <GInput v-model="form.country" label="國家" placeholder="China" clearable class="sm" />
          <GInput v-model="form.q" label="關鍵字" placeholder="整列文字包含" clearable class="md" />
        </div>
        <div class="filters">
          <span class="xs faint">從 FTP 即時讀取;時間越短、條件越多越快。IP 可輸入 10.10.124.18、10.10.124.*、10.10.0.0/16</span>
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
          從 FTP 讀取中…
          <template v-if="progress"
            >已掃描 {{ progress.filesScanned }} / {{ progress.files }} 個檔案、{{ fmtNum(progress.rows) }} 列,找到 {{ fmtNum(progress.found) }} 筆</template
          >
          <template v-else>(匯入進行中時會排隊等候 FTP 連線)</template>
        </p>
        <p v-else-if="result" class="small muted">
          <strong class="text">符合 {{ fmtNum(result.total) }} 筆</strong>
          · 掃描 {{ fmtNum(result.scanned) }} 列 · {{ result.filesScanned }} / {{ result.files }} 個檔案 · {{ result.seconds }} 秒
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
  width: 210px;
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
