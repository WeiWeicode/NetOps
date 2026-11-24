<script setup lang="ts">
/**
 * AD 網域 › Log 明細查詢(docs/API.md §6.2;舊版 src/views/AdSearch.vue):
 *   已匯入的 AD 事件依時間與條件篩選(後端分頁,每頁 50 筆),點一列看完整內容,匯出 CSV(後端產生,最多 20,000 筆)。
 *   AD 事件總覽點選會帶 ?from=&to=&channel=&eventId=… 進來並自動查詢;網址條件只收白名單與格式正確的值(composables/searchQuery.ts)。
 *   期間最長 31 天。
 */
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AD_EXPORT_MAX, AD_LEVEL, AD_SEARCH_MAX_DAYS, ad, adLog, type AdDays, type AdEventQuery, type AdEventRow } from '@/api/ad';
import { describeError, download } from '@/api/gateway';
import { fmtNum, fmtTime } from '@/api/format';
import { collectDcOptions, fieldValidationError, isClickHouseUnavailable, isDcToken } from '@/composables/adEvents';
import { cameFromApp, isEventIds, localToIso, pickQuery, toLocalInput } from '@/composables/searchQuery';
import { toast } from '@/ui';

const PAGE_SIZE = 50;
const KEYS = ['channel', 'level', 'eventId', 'account', 'ip', 'q', 'computer', 'dcDomain', 'name'] as const;
type Key = (typeof KEYS)[number];
const route = useRoute();
const router = useRouter();

const meta = shallowRef<AdDays | null>(null);
const agentComputers = ref<string[]>([]);
const isClickHouse = computed(() => meta.value?.source === 'clickhouse');
const dcOptions = computed(() =>
  isClickHouse.value ? collectDcOptions(agentComputers.value, (meta.value?.days ?? []).map((d) => d.computers)) : [],
);
const form = reactive<Record<Key, string> & { from: string; to: string; issueOnly: boolean }>({
  from: '',
  to: '',
  issueOnly: false,
  ...(Object.fromEntries(KEYS.map((k) => [k, ''])) as Record<Key, string>),
});
const channelOptions = computed(() => Object.entries(meta.value?.channels ?? {}).map(([value, label]) => ({ label, value })));
const levelOptions = Object.entries(AD_LEVEL).map(([value, l]) => ({ label: l.label, value }));
const chName = (c: string) => meta.value?.channels[c] ?? c;
const evName = (e: AdEventRow) => (e.channel === 'Security' ? (meta.value?.securityEvents[String(e.eventId)] ?? '') : '');

const formError = computed(() => {
  if (!form.from || !form.to) return '請選擇時間';
  if (form.from > form.to) return '開始時間不可晚於結束時間';
  if ((new Date(form.to).getTime() - new Date(form.from).getTime()) / 86_400_000 > AD_SEARCH_MAX_DAYS) return `期間最長 ${AD_SEARCH_MAX_DAYS} 天`;
  if (form.eventId.trim() && !isEventIds(form.eventId.trim())) return '事件 ID 請輸入數字,多個以逗號分隔';
  if (form.computer.trim() && !isDcToken(form.computer.trim(), 64)) return 'DC 名稱只能包含英數、_、.、-,最長 64 字';
  if (form.dcDomain.trim() && !isDcToken(form.dcDomain.trim(), 253)) return 'DC 網域只能包含英數、_、.、-,最長 253 字';
  if (form.name.trim().length > 100) return '名稱條件最長 100 字';
  return '';
});

// ---------- 查詢 ----------
/** 送出時的條件(換頁、匯出都用這組,避免改了表單沒按查詢就混用) */
const applied = shallowRef<AdEventQuery | null>(null);
const result = shallowRef<{ items: AdEventRow[]; total: number; scanned: number } | null>(null);
const page = ref(1);
const loading = ref(false);
const error = ref<Error | null>(null);
const nameError = ref('');
const errorTitle = computed(() => (isClickHouseUnavailable(error.value) ? 'AD 事件資料庫暫時無法使用' : undefined));
watch(
  () => form.name,
  () => {
    if (nameError.value) nameError.value = '';
  },
);
let seq = 0;
/** 畫面上資料的頁碼(GTable 換頁時已先改了 page;失敗要還原,頁碼才與資料一致) */
let shownPage = 1;

function buildQuery(): AdEventQuery {
  const cond = Object.fromEntries(KEYS.map((k) => [k, form[k].trim()]).filter(([, v]) => v));
  return { from: localToIso(form.from), to: localToIso(form.to), issueOnly: form.issueOnly, ...cond };
}

async function fetchPage(p: number) {
  if (!applied.value) return;
  const my = ++seq;
  loading.value = true;
  error.value = null;
  nameError.value = '';
  try {
    const r = await adLog.search(applied.value, p, PAGE_SIZE);
    if (my !== seq) return;
    result.value = r;
    page.value = shownPage = r.page;
  } catch (e) {
    if (my === seq) {
      const nf = fieldValidationError(e, 'name');
      if (nf) nameError.value = nf;
      else error.value = e as Error;
      if (result.value) page.value = shownPage;
    }
  } finally {
    if (my === seq) loading.value = false;
  }
}

function search() {
  if (formError.value) return toast.warning(formError.value);
  applied.value = buildQuery();
  // 條件記在網址:重新整理或分享連結可還原(時間用本地時間,不含時區)
  const cond = Object.fromEntries(KEYS.map((k) => [k, form[k].trim()]).filter(([, v]) => v));
  void router.replace({ query: { from: form.from, to: form.to, ...cond, issueOnly: form.issueOnly ? '1' : undefined } });
  void fetchPage(1);
}

function reset() {
  for (const k of KEYS) form[k] = '';
  form.issueOnly = false;
  nameError.value = '';
}

const exporting = ref(false);
async function exportCsv() {
  if (!applied.value) return;
  if ((result.value?.total ?? 0) > AD_EXPORT_MAX) return toast.warning(`匯出最多 ${fmtNum(AD_EXPORT_MAX)} 筆`, '請縮小時間或加條件');
  exporting.value = true;
  try {
    const stamp = (s: string) => s.slice(0, 16).replace(/\D/g, '');
    await download(adLog.exportPath, adLog.exportQuery(applied.value), `AD_log_${stamp(applied.value.from)}_${stamp(applied.value.to)}.csv`);
  } catch (e) {
    toast.fromError(e, '匯出失敗');
  } finally {
    exporting.value = false;
  }
}

// ---------- 明細 ----------
const detail = ref<AdEventRow | null>(null);
const detailOpen = computed({ get: () => !!detail.value, set: (v) => !v && (detail.value = null) });

onMounted(async () => {
  try {
    meta.value = await ad.days();
    if (meta.value.source === 'clickhouse') {
      ad.agents()
        .then((r) => {
          agentComputers.value = r.items.map((x) => x.computer);
        })
        .catch(() => undefined);
    }
  } catch (e) {
    toast.fromError(e, '無法取得 AD 記錄名稱與已有資料日期');
  }
  const q = route.query;
  Object.assign(
    form,
    pickQuery(q, KEYS, {
      eventId: isEventIds,
      level: (v) => v in AD_LEVEL,
      computer: (v) => isDcToken(v, 64),
      dcDomain: (v) => isDcToken(v, 253),
      name: (v) => v.length <= 100,
    }),
  );
  form.issueOnly = q.issueOnly === '1';
  const from = toLocalInput(q.from);
  if (from) {
    // 只有日期時補上 00:00 / 23:59
    Object.assign(form, { from, to: toLocalInput(q.to || q.from, true) || toLocalInput(q.from, true) });
    // 從總覽點選進來才自動查詢;外部連結只填條件
    if (cameFromApp()) search();
  } else {
    const day = meta.value?.days[0]?.day;
    if (day) Object.assign(form, { from: `${day}T00:00`, to: `${day}T23:59` });
  }
});

const columns = [
  { key: 'time', label: '時間', width: '165px' },
  { key: 'computer', label: 'DC', width: '125px', hideSm: true },
  { key: 'channel', label: '記錄', width: '96px', hideSm: true },
  { key: 'eventId', label: '事件', width: '160px' },
  { key: 'level', label: '等級', width: '96px' },
  { key: 'account', label: '帳號', width: '130px', hideSm: true },
  { key: 'ip', label: '來源 IP', width: '190px', hideSm: true },
  { key: 'source', label: '資料來源', width: '105px', hideSm: true },
  { key: 'message', label: '訊息' },
];
const asRow = (r: unknown) => r as AdEventRow;
const rows = computed(() => (result.value?.items ?? []).map((e, i) => ({ ...e, _k: `${e.computer}|${e.channel}|${e.recordId}|${i}` })));
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <GCard padding="sm">
      <form class="stack" style="--gap: 12px" @submit.prevent="search">
        <div class="filters">
          <GInput v-model="form.from" type="datetime-local" label="開始時間" class="dt" />
          <GInput v-model="form.to" type="datetime-local" label="結束時間" class="dt" />
          <GSelect v-if="dcOptions.length" v-model="form.computer" label="DC" :options="dcOptions" placeholder="全部" class="sel" />
          <GInput v-else v-model="form.computer" label="DC" placeholder="GSMC-DC1" clearable class="sm" />
          <GInput v-model="form.dcDomain" label="DC 網域" placeholder="gsmc.com.tw" clearable class="sm" />
          <GSelect v-model="form.channel" label="記錄" :options="channelOptions" placeholder="全部" class="sel" />
          <GSelect v-model="form.level" label="等級" :options="levelOptions" placeholder="全部" class="sel" />
          <GInput v-model="form.eventId" label="事件 ID" placeholder="4625,4740" clearable class="sm" />
          <GInput v-model="form.account" label="帳號" placeholder="S094009" clearable class="sm" />
          <GInput v-model="form.ip" label="IP" clearable class="sm" />
          <GInput v-model="form.name" label="姓名 / 部門 / 設備" placeholder="IP 對照表名稱" :error="nameError" clearable class="md" />
          <GInput v-model="form.q" label="關鍵字" placeholder="訊息內容" clearable class="md" />
        </div>
        <div class="filters">
          <GCheckbox v-model="form.issueOnly" label="只看需要注意的" />
          <div class="spacer" />
          <span v-if="formError && (form.from || form.to)" class="small c-danger">{{ formError }}</span>
          <GButton icon="reset" @click="reset">清除條件</GButton>
          <GButton type="submit" variant="primary" icon="search" :loading="loading">查詢</GButton>
        </div>
      </form>
    </GCard>

    <GCard padding="none" title="查詢結果" icon="list">
      <template #actions>
        <GButton v-if="result?.total" size="sm" icon="download" :loading="exporting" @click="exportCsv">匯出 CSV</GButton>
      </template>
      <div class="pad small muted">
        <template v-if="result">
          <strong class="text">符合 {{ fmtNum(result.total) }} 筆</strong> · 期間內共 {{ fmtNum(result.scanned) }} 筆事件
          <span v-if="result.total > AD_EXPORT_MAX" class="c-warning"> · 超過匯出上限 {{ fmtNum(AD_EXPORT_MAX) }} 筆,請縮小時間或加條件</span>
        </template>
        <template v-else-if="!loading && !error">選擇時間與條件後按「查詢」</template>
      </div>
      <GAlert v-if="error" tone="danger" :title="errorTitle" class="pad-x">{{ describeError(error) }}</GAlert>
      <GTable
        v-model:page="page"
        :loading="loading && !result"
        :rows="rows"
        :total="result?.total ?? 0"
        :page-size="PAGE_SIZE"
        row-key="_k"
        dense
        clickable
        :columns="columns"
        :empty-title="error ? '查詢失敗' : result ? '沒有符合的事件' : '尚未查詢'"
        @update:page="fetchPage"
        @row-click="(r) => (detail = asRow(r))"
      >
        <template #cell-time="{ row }">
          <span class="small num nowrap">{{ fmtTime(asRow(row).time) }}</span>
        </template>
        <template #cell-computer="{ row }">
          <span class="small mono nowrap" :title="asRow(row).dcDomain ? `${asRow(row).computer}(${asRow(row).dcDomain})` : asRow(row).computer">
            {{ asRow(row).computer }}
          </span>
        </template>
        <template #cell-channel="{ row }">
          <span class="nowrap">{{ chName(asRow(row).channel) }}</span>
        </template>
        <template #cell-eventId="{ row }">
          <span class="num">{{ asRow(row).eventId }}</span> <span class="muted small">{{ evName(asRow(row)) }}</span>
        </template>
        <template #cell-level="{ row }">
          <GBadge :tone="AD_LEVEL[asRow(row).level]?.tone ?? 'neutral'" dot>{{ AD_LEVEL[asRow(row).level]?.label ?? asRow(row).levelText }}</GBadge>
        </template>
        <template #cell-account="{ row }">
          <span class="who small">
            <GBadge v-if="asRow(row).privileged" tone="danger" variant="solid">特權</GBadge>
            <span class="ellipsis">{{ asRow(row).account || '—' }}</span>
          </span>
        </template>
        <template #cell-ip="{ row }">
          <GIpLabel :ip="asRow(row).ip" inline />
        </template>
        <template #cell-source="{ row }">
          <GSourceBadge :source="asRow(row).source === 'agent' ? 'agent' : 'ftp'" />
        </template>
        <template #cell-message="{ row }">
          <span class="msg small">{{ asRow(row).message.split('\n')[0] }}</span>
        </template>
      </GTable>
    </GCard>

    <GModal
      v-model:open="detailOpen"
      :title="detail ? `${detail.eventId} ${evName(detail)}` : ''"
      :subtitle="detail ? fmtTime(detail.time) : ''"
      icon="file-text"
      width="760px"
    >
      <div v-if="detail" class="stack" style="--gap: 10px">
        <dl class="detail small">
          <dt>記錄</dt>
          <dd>{{ chName(detail.channel) }}</dd>
          <dt>等級</dt>
          <dd>{{ AD_LEVEL[detail.level]?.label ?? detail.levelText }}</dd>
          <dt>資料來源</dt>
          <dd>
            <GSourceBadge :source="detail.source === 'agent' ? 'agent' : 'ftp'" />
            <span v-if="detail.logEpoch != null" class="xs muted"> (世代 {{ detail.logEpoch }})</span>
          </dd>
          <dt>來源</dt>
          <dd>{{ detail.provider }}</dd>
          <dt>主機</dt>
          <dd>
            {{ detail.computer }}<template v-if="detail.dcDomain"> ({{ detail.dcDomain }})</template>(記錄編號 {{ detail.recordId }})
          </dd>
          <template v-if="detail.ip">
            <dt>來源 IP</dt>
            <dd><GIpLabel :ip="detail.ip" inline /></dd>
          </template>
          <template
            v-for="f in [
              ['帳號', detail.domain ? `${detail.domain}\\${detail.account}` : detail.account],
              ['執行者', detail.actor],
              ['對象', detail.target],
              ['群組', detail.group ? `${detail.group}${detail.privileged ? '(特權)' : ''}` : ''],
              ['工作站', detail.workstation],
              ['原因', detail.reason],
            ] as const"
            :key="f[0]"
          >
            <template v-if="f[1]">
              <dt>{{ f[0] }}</dt>
              <dd>{{ f[1] }}</dd>
            </template>
          </template>
        </dl>
        <pre class="ad-msg">{{ detail.message }}</pre>
      </div>
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
.sel {
  width: 140px;
}
.sm {
  width: 140px;
}
.md {
  width: 200px;
}
.pad {
  padding: 0 var(--space-4) var(--space-3);
}
.pad-x {
  margin: 0 var(--space-4) var(--space-3);
}
.text {
  color: var(--text);
}
.who {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 180px;
  min-width: 0;
}
.msg {
  display: block;
  max-width: 520px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  margin: 0;
}
.detail dt {
  color: var(--text-3);
}
.detail dd {
  margin: 0;
  word-break: break-word;
}
.ad-msg {
  margin: 0;
  max-height: 360px;
  overflow: auto;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--field);
  font-family: inherit;
  font-size: var(--fs-sm);
  white-space: pre-wrap;
  word-break: break-word;
}
@media (max-width: 760px) {
  .dt {
    flex: 1 1 100%;
  }
  .sel,
  .sm,
  .md {
    flex: 1 1 140px;
    width: auto;
  }
  .msg {
    max-width: 200px;
  }
}
</style>
