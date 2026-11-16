<script setup lang="ts">
/**
 * AD 網域 › AD 事件總覽(docs/API.md §6.1;舊版 src/views/AdEvents.vue):
 *   DC 每天匯出到 FTP /AD_Log_Backup/yyyyMMdd/*.csv(Security / System / Directory_Service / DNS_Server)的統計、
 *   帳號與特權異動、需要注意的事件;點一列 / 數字帶條件到「Log 明細查詢」(/ad/search)。
 *   期間預設最新一天、最長 92 天;期間內有日期沒匯入、Security 記錄是空的都要明確提示(AGENT.md §5)。
 *   有 FTP 管理權限(UI.adFilesManage)可「從 FTP 同步」(背景執行,完成後重新載入)。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { AD_LEVEL, ad, type AdDays, type AdEventGroup, type AdOverview } from '@/api/ad';
import { adFtp } from '@/api/ftp';
import { can, describeError } from '@/api/gateway';
import { fmtNum, fmtTime } from '@/api/format';
import { NETOPS, UI } from '@/api/perms';
import { reasonQuery } from '@/composables/adEvents';
import { daysBetween } from '@/composables/dates';
import { usePolling } from '@/composables/usePolling';
import { confirm, toast } from '@/ui';

const MAX_DAYS = 92;
const POLL_MS = 2000;
const router = useRouter();
const manage = computed(() => can(UI.adFilesManage));
const canSearch = computed(() => can(NETOPS.adSearch));

// ---------- 已匯入的日期 ----------
const meta = shallowRef<AdDays | null>(null);
const metaError = ref<Error | null>(null);
const range = reactive({ from: '', to: '' });

async function loadDays() {
  try {
    meta.value = await ad.days();
    metaError.value = null;
    const latest = meta.value.days[0]?.day;
    if (!range.from && latest) Object.assign(range, { from: latest, to: latest });
  } catch (e) {
    metaError.value = e as Error;
  }
}
const dayList = computed(() => meta.value?.days ?? []);
const minDay = computed(() => dayList.value.at(-1)?.day ?? '');
const maxDay = computed(() => dayList.value[0]?.day ?? '');
const chName = (c: string) => meta.value?.channels[c] ?? c;
const evName = (g: AdEventGroup) => g.name || (g.channel === 'Security' ? (meta.value?.securityEvents[String(g.eventId)] ?? '') : '');

// ---------- 總覽 ----------
const summary = shallowRef<AdOverview | null>(null);
const loading = ref(false);
const loadError = ref<Error | null>(null);
const rangeError = computed(() => {
  if (!range.from || !range.to) return '';
  if (range.from > range.to) return '開始日期不可晚於結束日期';
  if (daysBetween(range.from, range.to) > MAX_DAYS) return `期間最長 ${MAX_DAYS} 天`;
  return '';
});
let seq = 0;

async function load() {
  if (!range.from || !range.to || rangeError.value) return;
  const my = ++seq;
  loading.value = true;
  loadError.value = null;
  try {
    const r = await ad.overview(range.from, range.to);
    if (my === seq) summary.value = r;
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

/** 期間天數 vs 已匯入天數:少了就是資料不完整 */
const periodDays = computed(() => (summary.value ? daysBetween(summary.value.from, summary.value.to) : 0));
const missingDays = computed(() => (summary.value ? Math.max(0, periodDays.value - summary.value.days) : 0));

/** 期間內 Security 記錄是空的(匯出排程沒有權限或 DC 沒開稽核);多台 DC 時加總 */
const securityEmpty = computed(() => {
  const inRange = dayList.value.filter((d) => d.day >= range.from && d.day <= range.to);
  return inRange.length > 0 && inRange.every((d) => d.files.filter((f) => f.channel === 'Security').reduce((a, f) => a + (f.rows ?? 0), 0) === 0);
});

const kpi = computed(() => {
  const s = summary.value;
  if (!s) return null;
  const n = (lv: keyof AdOverview['byLevel']) => s.byLevel[lv] ?? 0;
  const ev = (id: number) => s.events.filter((g) => g.eventId === id && g.channel === 'Security').reduce((a, g) => a + g.n, 0);
  return { total: s.total, error: n('error') + n('critical'), warning: n('warning'), loginFail: ev(4625) + ev(4771), lockout: ev(4740) };
});
const byChannelText = computed(() =>
  Object.entries(summary.value?.byChannel ?? {})
    .map(([c, n]) => `${chName(c)} ${fmtNum(n)}`)
    .join('、'),
);
/** 新建立的帳號隨即被加入特權群組(入侵後門常見手法) */
const backdoor = computed(() => {
  const ch = summary.value?.accountChanges ?? [];
  const created = new Set(ch.filter((c) => c.eventId === 4720).map((c) => c.target));
  return ch.filter((c) => c.privileged && created.has(c.target));
});

// ---------- 帶條件到明細查詢 ----------
function toSearch(cond: Record<string, string>) {
  if (!canSearch.value) return;
  void router.push({ path: '/ad/search', query: { from: range.from, to: range.to, ...cond } });
}
const pick = (g: AdEventGroup) => toSearch({ channel: g.channel, eventId: String(g.eventId) });
/** 登入失敗的原因 → 用原因裡的代碼(0x25、0xC000006A)或文字當關鍵字,限登入失敗 / 鎖定事件 */
const pickReason = (reason: string) => toSearch({ eventId: '4625,4771,4740,4776', q: reasonQuery(reason) });
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
/** KPI 卡片可點選時的屬性(滑鼠與鍵盤);沒有明細查詢權限時只顯示數字 */
function clickable(fn: () => void, always = false) {
  if (!always && !canSearch.value) return {};
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

// ---------- 從 FTP 同步 ----------
const syncing = ref(false);
let syncErrors = 0;
const syncPoller = usePolling(
  () => adFtp.status(),
  (r) => {
    if (r instanceof Error) {
      // 暫時性錯誤再試幾次,同步可能還在跑
      if (++syncErrors < 3) return true;
      toast.fromError(r, '無法取得同步結果');
    } else if (r.running) return true;
    else if (r.lastSyncError) toast.error('同步失敗', r.lastSyncError);
    else toast.success('同步完成', r.lastResult?.imported.length ? `匯入 ${r.lastResult.imported.length} 天` : '沒有新的資料');
    syncing.value = false;
    void refresh();
    return false;
  },
  POLL_MS,
);

async function sync() {
  const ok = await confirm({
    title: '從 FTP 同步 AD 事件?',
    message: '在背景比對 FTP 上的每日資料夾,有變更的日期會重新匯入;完成後自動更新總覽。',
    confirmText: '同步',
  });
  if (!ok) return;
  syncing.value = true;
  try {
    syncErrors = 0;
    await adFtp.sync();
    toast.info('已開始同步', '完成後自動更新總覽');
    void syncPoller.run();
  } catch (e) {
    syncing.value = false;
    toast.fromError(e, '同步失敗');
  }
}

async function refresh() {
  const before = `${range.from}|${range.to}`;
  await loadDays();
  // 第一次載入時 loadDays 會設定期間,由 watch 載入;期間沒變才自己載入
  if (`${range.from}|${range.to}` === before) await load();
}

onMounted(refresh);

const groupColumns = [
  { key: 'channel', label: '記錄', width: '110px' },
  { key: 'eventId', label: '事件', width: '72px', mono: true },
  { key: 'level', label: '等級', width: '96px' },
  { key: 'n', label: '次數', align: 'right' as const, width: '80px' },
  { key: 'sample', label: '內容', hideSm: true },
];
const changeColumns = [
  { key: 'time', label: '時間', width: '160px' },
  { key: 'action', label: '動作', width: '170px' },
  { key: 'actor', label: '執行者', hideSm: true },
  { key: 'target', label: '對象' },
  { key: 'group', label: '群組', hideSm: true },
  { key: 'more', label: '', align: 'right' as const, width: '72px' },
];
/** 事件群組表(同一事件 ID 可能出現在不同記錄或等級,列的 key 要組合) */
type GroupRow = AdEventGroup & { _k: string };
const keyed = (list: AdEventGroup[]): GroupRow[] => list.map((g) => ({ ...g, _k: `${g.channel}:${g.eventId}:${g.level}:${g.provider}` }));
const groupSections = computed(() =>
  summary.value
    ? [
        {
          key: 'issues',
          title: '需要注意的事件',
          subtitle: '錯誤、警告、登入失敗、帳號異動',
          icon: 'alert',
          rows: keyed(summary.value.issues),
          empty: '沒有需要注意的事件',
        },
        {
          key: 'events',
          title: '事件排行',
          subtitle: '前 30 名',
          icon: 'list-ordered',
          rows: keyed(summary.value.events.slice(0, 30)),
          empty: '這段期間沒有事件',
        },
      ]
    : [],
);
/** 帳號異動表(recordId 在多台 DC 間可能重複) */
const changes = computed(() =>
  (summary.value?.accountChanges ?? []).map((c, i) => ({ ...c, _k: `${c.computer}:${c.recordId}:${c.time}:${c.eventId}:${c.target}:${i}` })),
);
const failSections = computed(() =>
  summary.value
    ? [
        { key: 'account', title: '登入失敗 / 鎖定最多的帳號', rows: summary.value.failAccounts },
        { key: 'ip', title: '登入失敗最多的來源 IP', rows: summary.value.failIps },
      ]
    : [],
);
const asGroup = (r: unknown) => r as GroupRow;
const asChange = (r: unknown) => r as AdOverview['accountChanges'][number];
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <Teleport to="#page-actions" defer>
      <GButton icon="refresh" :loading="loading" @click="refresh">重新整理</GButton>
      <GButton v-if="manage" variant="primary" icon="download" :loading="syncing" @click="sync">從 FTP 同步</GButton>
    </Teleport>

    <GCard padding="sm">
      <div class="filters">
        <GInput v-model="range.from" type="date" label="開始日期" class="date" />
        <GInput v-model="range.to" type="date" label="結束日期" class="date" />
        <p class="small muted hint">
          <template v-if="summary?.timeMin">資料時間 {{ fmtTime(summary.timeMin) }} ~ {{ fmtTime(summary.timeMax) }}</template>
          <template v-if="maxDay"> · 已匯入 {{ minDay }} ~ {{ maxDay }}({{ dayList.length }} 天)</template>
        </p>
      </div>
      <p v-if="rangeError" class="small c-danger err">{{ rangeError }}</p>
    </GCard>

    <GAlert v-if="metaError" tone="danger" title="無法取得已匯入的日期">{{ describeError(metaError) }}</GAlert>
    <GAlert v-if="meta?.import.lastSyncError" tone="warning" title="上次同步失敗,資料可能不完整">
      {{ meta.import.lastSyncError }}
    </GAlert>
    <GAlert v-if="missingDays" tone="warning" :title="`期間 ${periodDays} 天,只有 ${summary?.days} 天有匯入資料`">
      其餘日期沒有資料不代表沒有事件;請到「FTP Log 檔案」確認是否已匯入。
    </GAlert>
    <GAlert v-if="securityEmpty" tone="warning" title="這段期間的 Security(安全性)記錄是空的">
      登入成功 / 失敗、帳號鎖定、密碼變更、群組異動都記錄在 Security,目前無法分析。請檢查 DC 的匯出排程帳號是否有讀取 Security 記錄的權限(Event Log Readers
      群組或系統管理員),以及 DC 是否已啟用稽核原則(帳戶登入、帳戶管理)。
    </GAlert>

    <GCard v-if="meta && !dayList.length">
      <GEmpty icon="inbox" title="尚未匯入 AD 事件記錄" description="到「FTP Log 檔案」從 FTP /AD_Log_Backup 同步每日匯出檔" />
    </GCard>
    <GCard v-else-if="metaError && !meta">
      <GEmpty tone="danger" icon="activity" title="無法取得已匯入的日期" :description="describeError(metaError)">
        <GButton icon="refresh" @click="refresh">重試</GButton>
      </GEmpty>
    </GCard>
    <GCard v-else-if="loadError && !summary">
      <GEmpty tone="danger" icon="activity" title="無法載入 AD 事件總覽" :description="describeError(loadError)">
        <GButton icon="refresh" @click="load">重試</GButton>
      </GEmpty>
    </GCard>
    <div v-else-if="!summary" class="grid grid-auto">
      <GCard v-for="i in 6" :key="i" padding="sm"><GSkeleton :lines="2" /></GCard>
    </div>

    <template v-if="summary && kpi">
      <GAlert v-if="loadError" tone="danger">重新載入失敗,以下是 {{ summary.from }} ~ {{ summary.to }} 的結果:{{ describeError(loadError) }}</GAlert>
      <GAlert v-else-if="rangeError || summary.from !== range.from || summary.to !== range.to" tone="info">
        以下是 {{ summary.from }} ~ {{ summary.to }} 的結果{{ loading ? ',新的期間載入中…' : '' }}
      </GAlert>
      <!-- KPI:點選帶條件到明細查詢 -->
      <div class="grid kpis">
        <GStatCard label="事件總數" :value="kpi.total" icon="activity" :hint="byChannelText" />
        <GStatCard
          v-bind="clickable(() => toSearch({ level: 'error' }))"
          label="錯誤 / 重大"
          :value="kpi.error"
          icon="x-circle"
          :tone="kpi.error ? 'danger' : 'success'"
        />
        <GStatCard
          v-bind="clickable(() => toSearch({ level: 'warning' }))"
          label="警告"
          :value="kpi.warning"
          icon="alert"
          :tone="kpi.warning ? 'warning' : 'success'"
        />
        <GStatCard
          v-bind="clickable(() => toSearch({ eventId: '4625,4771' }))"
          label="登入失敗(4625 / 4771)"
          :value="securityEmpty ? '—' : kpi.loginFail"
          icon="user-x"
          :tone="securityEmpty ? 'neutral' : kpi.loginFail ? 'danger' : 'success'"
        />
        <GStatCard
          v-bind="clickable(() => scrollTo('ad-priv'), true)"
          label="特權群組異動 / 建立帳號"
          :value="securityEmpty ? '—' : `${fmtNum(summary.privilegedChanges)} / ${fmtNum(summary.accountsCreated)}`"
          icon="key"
          :tone="securityEmpty ? 'neutral' : summary.privilegedChanges ? 'danger' : 'success'"
        />
        <GStatCard
          v-bind="clickable(() => toSearch({ eventId: '4740' }))"
          label="帳號鎖定(4740)"
          :value="securityEmpty ? '—' : kpi.lockout"
          icon="lock"
          :tone="securityEmpty ? 'neutral' : kpi.lockout ? 'danger' : 'success'"
        />
      </div>

      <!-- 帳號與特權異動(Security 4720 / 4728 / 4732 / 4756 …) -->
      <GCard
        id="ad-priv"
        padding="none"
        title="帳號與特權異動"
        subtitle="建立 / 刪除 / 停用帳號、重設密碼、加入或移出群組;【特權】= Domain Admins、Administrators 等高權限群組"
        icon="key"
      >
        <div class="pad stack" style="--gap: 10px">
          <GAlert v-if="backdoor.length" tone="danger" title="新建立的帳號隨即被加入特權群組">
            {{ backdoor.map((c) => `${c.target} → ${c.group}(${c.actor},${fmtTime(c.time)})`).join('、') }}。這是常見的入侵後門手法,請立即確認是否有核准。
          </GAlert>
          <p v-if="securityEmpty" class="small muted center">Security 記錄是空的,無法列出帳號與特權異動</p>
        </div>
        <GTable v-if="!securityEmpty" :rows="changes" row-key="_k" :page-size="10" dense :columns="changeColumns" empty-title="這段期間沒有帳號或群組異動">
          <template #cell-time="{ row }">
            <span class="small num nowrap">{{ fmtTime(asChange(row).time) }}</span>
          </template>
          <template #cell-action="{ row }">
            <span class="action">
              <GBadge v-if="asChange(row).privileged" tone="danger" variant="solid">特權</GBadge>
              <span>{{ asChange(row).action }}</span>
            </span>
          </template>
          <template #cell-more="{ row }">
            <GButton v-if="canSearch" size="sm" variant="ghost" @click="toSearch({ q: asChange(row).target || asChange(row).group })">明細</GButton>
            <span v-else />
          </template>
        </GTable>
        <div v-if="summary.privLogons.length" class="pad chips small">
          <span class="muted">特權登入(4672,已排除電腦與系統帳戶):</span>
          <GButton v-for="x in summary.privLogons" :key="x.key" size="sm" variant="secondary" :disabled="!canSearch" @click="toSearch({ account: x.key })">
            {{ x.key }}({{ fmtNum(x.n) }})
          </GButton>
        </div>
      </GCard>

      <div class="grid grid-2">
        <GCard v-for="sec in groupSections" :key="sec.key" padding="none" :title="sec.title" :subtitle="sec.subtitle" :icon="sec.icon">
          <GTable
            :rows="sec.rows"
            row-key="_k"
            :page-size="10"
            dense
            :clickable="canSearch"
            :columns="groupColumns"
            :empty-title="sec.empty"
            @row-click="(r) => pick(asGroup(r))"
          >
            <template #cell-channel="{ row }"
              ><span class="nowrap">{{ chName(asGroup(row).channel) }}</span></template
            >
            <template #cell-level="{ row }">
              <GBadge :tone="AD_LEVEL[asGroup(row).level]?.tone ?? 'neutral'" dot>{{ AD_LEVEL[asGroup(row).level]?.label ?? asGroup(row).level }}</GBadge>
            </template>
            <template #cell-n="{ row }">
              <span class="num">{{ fmtNum(asGroup(row).n) }}</span>
            </template>
            <template #cell-sample="{ row }">
              <span class="sample small" :title="asGroup(row).sample">
                <strong v-if="evName(asGroup(row))">{{ evName(asGroup(row)) }}:</strong>{{ asGroup(row).sample }}
              </span>
            </template>
          </GTable>
        </GCard>
      </div>

      <!-- 登入失敗的帳號 / IP / 原因(有 Security 資料時) -->
      <div v-if="summary.failAccounts.length || summary.failIps.length || summary.failReasons.length" class="grid grid-3">
        <GCard v-for="sec in failSections" :key="sec.key" :title="sec.title" icon="user-x">
          <ul class="ranks">
            <li v-for="x in sec.rows" :key="x.key">
              <button type="button" :disabled="!canSearch" @click="toSearch({ [sec.key]: x.key })">
                <span class="ellipsis">{{ x.key }}</span
                ><span class="num c-danger">{{ fmtNum(x.n) }}</span>
              </button>
            </li>
          </ul>
          <p v-if="!sec.rows.length" class="small muted">沒有資料</p>
        </GCard>
        <GCard title="登入失敗的原因" icon="alert-circle">
          <ul class="ranks">
            <li v-for="x in summary.failReasons" :key="x.key">
              <button type="button" :disabled="!canSearch" title="查看這個原因的登入失敗明細" @click="pickReason(x.key)">
                <span>{{ x.key }}</span
                ><span class="num c-danger">{{ fmtNum(x.n) }}</span>
              </button>
              <p v-if="x.ips?.length || x.accounts?.length" class="xs muted sub">
                <template v-if="x.ips?.length">IP {{ x.ips.map((i) => `${i.key}(${i.n})`).join('、') }}</template>
                <template v-if="x.accounts?.length"><br />帳號 {{ x.accounts.map((a) => `${a.key}(${a.n})`).join('、') }}</template>
              </p>
            </li>
          </ul>
          <p v-if="!summary.failReasons.length" class="small muted">沒有資料</p>
        </GCard>
      </div>
    </template>
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
  width: 180px;
}
.hint {
  margin: 0 0 8px;
}
.err {
  margin: 8px 0 0;
}
.kpis {
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
}
.click {
  cursor: pointer;
}
.click:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.pad {
  padding: 0 var(--space-4) var(--space-3);
}
.center {
  text-align: center;
  margin: 0;
  padding: var(--space-4) 0;
}
.action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sample {
  display: block;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-top: var(--space-3);
}
.ranks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.ranks button {
  display: flex;
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
.ranks button:hover:not(:disabled) {
  background: var(--glass-soft);
  color: var(--c-primary-text);
}
.ranks button:disabled {
  cursor: default;
}
.ranks button .num {
  margin-left: auto;
}
.sub {
  margin: 0 6px 4px;
  line-height: 1.5;
}
@media (max-width: 760px) {
  .date {
    flex: 1 1 140px;
    width: auto;
  }
  .sample {
    max-width: 200px;
  }
}
</style>
