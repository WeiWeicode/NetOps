<script setup lang="ts">
/**
 * 防火牆 › FTP Log 檔案(docs/API.md §5.1;舊版 src/views/FtpFiles.vue):
 *   瀏覽 FTP(TRAFFIC 與威脅、URL、資料過濾、WildFire、解密、GlobalProtect、User-ID 目錄)與每個檔案的分析狀態;
 *   檔案依資料日期分組,預設顯示最新一天;?path= 可直接開某個目錄。
 *   有管理權限(UI.paFilesManage)可同步新檔案、分析 / 重新分析選取、取消分析、刪除分析結果(只刪本系統摘要,FTP 唯讀)。
 *   只有 TRAFFIC 目錄(FTP_LOG_DIR)與各類型 log 目錄的檔案可以勾選;其他目錄只能瀏覽(後端一定會略過,analyzableDir)。
 *   同步與分析在背景執行:分析中每 2 秒查詢進度,結束時重新載入清單。
 */
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { can, describeError } from '@/api/gateway';
import { PA_BATCH_MAX, paFtp, type PaFile, type PaListing, type PaStatus } from '@/api/ftp';
import { fmtClock, fmtNum, fmtSize, fmtTime } from '@/api/format';
import { UI } from '@/api/perms';
import { analyzableDir, chunk, countFiles, crumbsOf, dayOf, filterFiles, groupDays, PA_STATE, progressPct } from '@/composables/ftpFiles';
import { usePolling } from '@/composables/usePolling';
import { confirm, toast } from '@/ui';

const POLL_MS = 2000;
const route = useRoute();
const manage = computed(() => can(UI.paFilesManage));

// ---------- 目錄清單 ----------
const listing = shallowRef<PaListing | null>(null);
const loading = ref(false);
const loadError = ref<Error | null>(null);
const dir = computed(() => listing.value?.path ?? '');
let loadSeq = 0;

async function load(path: string | undefined = dir.value || undefined) {
  const my = ++loadSeq;
  loading.value = true;
  loadError.value = null;
  try {
    const r = await paFtp.list(path);
    if (my !== loadSeq) return;
    const changedDir = r.path !== listing.value?.path;
    listing.value = r;
    if (changedDir) selected.value = new Set();
    else selected.value = new Set([...selected.value].filter((p) => analyzableDir(r) && r.items.some((f) => f.path === p && f.isLog)));
    // 第一次載入或換目錄:預設最新一天;原本選的日期不見了也改回最新一天
    if (changedDir || (day.value && !days.value.some((d) => d.day === day.value))) day.value = days.value[0]?.day ?? '';
  } catch (e) {
    if (my === loadSeq) loadError.value = e as Error;
  } finally {
    if (my === loadSeq) loading.value = false;
  }
}

const items = computed(() => listing.value?.items ?? []);
const typeDirs = computed(() =>
  listing.value ? [{ label: 'TRAFFIC 流量', value: listing.value.logDir }, ...listing.value.eventDirs.map((d) => ({ label: d.label, value: d.dir }))] : [],
);
/** 目前目錄是否為某個 log 類型的目錄(切換按鈕的選取狀態) */
const typeValue = computed({
  get: () => (typeDirs.value.some((t) => t.value === dir.value) ? dir.value : ''),
  set: (v: string) => v && load(v),
});
const crumbs = computed(() => crumbsOf(dir.value));

// ---------- 篩選 ----------
const day = ref('');
const keyword = ref('');
const stateFilter = ref('');
const days = computed(() => groupDays(items.value));
const dayIndex = computed(() => days.value.findIndex((d) => d.day === day.value));
const dayOptions = computed(() => days.value.map((d) => ({ label: `${d.day} · ${d.files} 檔 · 已分析 ${d.done}`, value: d.day })));
const stateOptions = Object.entries(PA_STATE).map(([value, s]) => ({ label: s.label, value }));
/** 往前 / 往後一天(step = 1 是較舊的一天) */
function moveDay(step: number) {
  const d = days.value[dayIndex.value + step];
  if (d) day.value = d.day;
}
const rows = computed(() => filterFiles(items.value, { day: day.value, keyword: keyword.value, state: stateFilter.value }));
const counts = computed(() => countFiles(items.value));
const dayLogCount = computed(() => rows.value.filter((f) => f.isLog).length);

// ---------- 選取(只有 TRAFFIC / 各類型 log 目錄的 log 檔可選) ----------
const selected = ref(new Set<string>());
const analyzable = computed(() => analyzableDir(listing.value));
const selectable = computed(() => (analyzable.value ? rows.value.filter((f) => f.isLog) : []));
const allSelected = computed(() => selectable.value.length > 0 && selectable.value.every((f) => selected.value.has(f.path)));
function toggle(f: PaFile, on: boolean) {
  const s = new Set(selected.value);
  if (on) s.add(f.path);
  else s.delete(f.path);
  selected.value = s;
}
function toggleAll(on: boolean) {
  const s = new Set(selected.value);
  for (const f of selectable.value) {
    if (on) s.add(f.path);
    else s.delete(f.path);
  }
  selected.value = s;
}
/** 只對目前清單看得到的檔案操作:換日期或篩選時清掉看不到的選取 */
const selectedFiles = computed(() => selectable.value.filter((f) => selected.value.has(f.path)));
watch(selectable, (list) => {
  const visible = new Set(list.map((f) => f.path));
  if ([...selected.value].some((p) => !visible.has(p))) selected.value = new Set([...selected.value].filter((p) => visible.has(p)));
});

// ---------- 分析進度 ----------
const status = shallowRef<PaStatus | null>(null);
const statusError = ref<Error | null>(null);
const anyBusy = computed(() => !!(status.value?.traffic.busy || status.value?.events.busy || status.value?.traffic.syncing || status.value?.events.syncing));
const showProgress = computed(() => !!status.value && (anyBusy.value || status.value.traffic.total > 0 || status.value.events.total > 0));
const syncError = computed(() => [status.value?.traffic.lastSyncError, status.value?.events.lastSyncError].filter(Boolean).join(';'));
/** 上次查詢時是否在分析中(只在輪詢更新;操作回應改了 status 也不影響「剛結束」的判斷) */
let polledBusy = false;

const poller = usePolling(
  () => paFtp.status(),
  (r) => {
    if (r instanceof Error) statusError.value = r;
    else {
      status.value = r;
      statusError.value = null;
    }
    // 分析剛結束:重新載入清單更新狀態欄(進行中不重複列 FTP 目錄,進度看上方卡片)
    if (!anyBusy.value && polledBusy) void load();
    polledBusy = anyBusy.value;
    return anyBusy.value;
  },
  POLL_MS,
);
const poll = () => void poller.run();

// ---------- 操作 ----------
const busy = ref<'' | 'sync' | 'analyze' | 'forget' | 'cancel'>('');

async function sync() {
  busy.value = 'sync';
  try {
    status.value = await paFtp.sync();
    toast.info('已開始同步', '在背景列出 FTP 目錄,新的與已變更的檔案會加入分析佇列');
    polledBusy = true;
    poll();
  } catch (e) {
    toast.fromError(e, '同步失敗');
  } finally {
    busy.value = '';
  }
}

async function analyze() {
  const list = selectedFiles.value;
  if (!list.length) return toast.warning('請勾選要分析的檔案');
  busy.value = 'analyze';
  try {
    let added = 0;
    let skipped = 0;
    for (const part of chunk(
      list.map((f) => f.path),
      PA_BATCH_MAX,
    )) {
      const r = await paFtp.analyze(part);
      added += r.added;
      skipped += r.skipped;
    }
    const why = `略過 ${skipped} 個(不在 FTP 上、不是 log,或不在 TRAFFIC 目錄 ${listing.value?.logDir ?? ''} 與各類型 log 目錄)`;
    if (added) toast.success(`已加入分析佇列 ${added} 個檔案`, skipped ? why : undefined);
    else toast.warning('沒有檔案加入佇列', why);
    selected.value = new Set();
  } catch (e) {
    toast.fromError(e, '分析失敗');
  } finally {
    // 分批送出時前面的批次可能已入列:不論成敗都更新清單與進度
    busy.value = '';
    polledBusy = true;
    void load();
    poll();
  }
}

async function forget() {
  const list = selectedFiles.value.filter((f) => f.state === 'done' || f.state === 'error');
  if (!list.length) return toast.warning('請勾選已分析或分析失敗的檔案');
  const ok = await confirm({
    title: `刪除 ${list.length} 個檔案的分析結果?`,
    message: '總覽與查詢將不再包含這些檔案;FTP 上的檔案不會刪除,之後同步會重新分析。',
    confirmText: '刪除',
    tone: 'danger',
  });
  if (!ok) return;
  busy.value = 'forget';
  try {
    let deleted = 0;
    for (const part of chunk(
      list.map((f) => f.path),
      PA_BATCH_MAX,
    ))
      deleted += (await paFtp.forget(part)).deleted;
    toast.success(`已刪除 ${deleted} 個檔案的分析結果`);
    selected.value = new Set();
  } catch (e) {
    toast.fromError(e, '刪除失敗');
  } finally {
    busy.value = '';
    void load();
  }
}

async function cancel() {
  busy.value = 'cancel';
  try {
    const r = await paFtp.cancel();
    toast.info(r.cancelled ? `已取消 ${r.cancelled} 個檔案的分析` : '沒有進行中的分析');
  } catch (e) {
    toast.fromError(e, '取消失敗');
  } finally {
    busy.value = '';
    poll();
  }
}

function open(f: PaFile) {
  if (f.dir) void load(f.path);
}

function refresh() {
  // 列目錄會連 FTP(測試區只有 1 條連線):載入中不重複送出
  if (!loading.value) void load();
  poll();
}

/** ?path= 指定目錄(同頁改 query 也會重新載入) */
const queryPath = computed(() => (typeof route.query.path === 'string' && route.query.path ? route.query.path : undefined));
watch(queryPath, (p) => void load(p));
onMounted(() => {
  void load(queryPath.value);
  poll();
});

const asFile = (r: unknown) => r as PaFile;
const columns = computed(() => [
  ...(manage.value && analyzable.value ? [{ key: 'sel', label: '', width: '44px' }] : []),
  { key: 'name', label: '名稱' },
  { key: 'size', label: '大小', align: 'right' as const, width: '90px' },
  { key: 'modified', label: '修改時間', width: '170px', hideSm: true },
  { key: 'state', label: '狀態', width: '96px' },
  { key: 'timeMin', label: '資料時間', hideSm: true },
  { key: 'rows', label: '筆數', align: 'right' as const, width: '100px', hideSm: true },
  { key: 'ms', label: '耗時', align: 'right' as const, width: '72px', hideSm: true },
]);
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <Teleport to="#page-actions" defer>
      <GButton icon="refresh" :loading="loading" @click="refresh">重新整理</GButton>
      <GButton v-if="manage" variant="primary" icon="download" :loading="busy === 'sync'" @click="sync">同步新檔案</GButton>
    </Teleport>

    <GAlert v-if="statusError" tone="danger" title="無法取得分析進度">{{ describeError(statusError) }}</GAlert>
    <GAlert v-if="syncError" tone="warning" title="上次同步失敗,清單與分析結果可能不完整">{{ syncError }}</GAlert>

    <!-- 分析進度(TRAFFIC 與其他類型 log 各一個匯入程式) -->
    <GCard v-if="showProgress && status" padding="sm">
      <div class="stack" style="--gap: 12px">
        <div
          v-for="(s, k) in { traffic: status.traffic, events: status.events }"
          v-show="s.busy || s.syncing || s.total"
          :key="k"
          class="stack"
          style="--gap: 6px"
        >
          <div class="prog-head small">
            <strong>{{ k === 'traffic' ? 'TRAFFIC 流量' : '威脅 / URL / VPN 等 log' }}</strong>
            <span>{{ s.busy ? '分析中' : s.syncing ? '同步中' : '上次分析完成' }}</span>
            <span class="muted num">完成 {{ fmtNum(s.done) }} / {{ fmtNum(s.total) }}</span>
            <span v-if="s.failed" class="c-danger num">失敗 {{ fmtNum(s.failed) }}</span>
            <span v-if="s.busy" class="muted num">排隊 {{ fmtNum(s.queued) }}</span>
            <span v-if="!s.busy && s.finishedAt" class="faint">{{ fmtTime(s.finishedAt) }}</span>
            <span v-if="s.lastSyncAt" class="faint hide-sm">上次同步 {{ fmtTime(s.lastSyncAt) }}</span>
          </div>
          <GProgress :value="progressPct(s)" :tone="s.busy ? 'primary' : s.failed ? 'warning' : 'success'" />
          <ul v-if="s.running.length" class="running xs muted">
            <li v-for="r in s.running" :key="r.path">
              <span class="ellipsis strong">{{ r.name }}</span>
              <span class="num">{{ fmtSize(r.read) }} / {{ fmtSize(r.size) }}</span>
              <span class="num">{{ fmtNum(r.rows) }} 列</span>
              <span class="num">{{ r.seconds }} 秒</span>
            </li>
          </ul>
        </div>
        <div v-if="manage && anyBusy" class="row">
          <div class="spacer" />
          <GButton size="sm" icon="square" :loading="busy === 'cancel'" @click="cancel">取消分析</GButton>
        </div>
      </div>
    </GCard>

    <GCard v-if="loadError && !listing">
      <GEmpty tone="danger" icon="folder" title="無法載入 FTP 目錄" :description="describeError(loadError)">
        <GButton icon="refresh" @click="load()">重試</GButton>
      </GEmpty>
    </GCard>
    <GCard v-else padding="none" :title="listing ? `同步目錄 ${listing.logDir}` : 'FTP 目錄'" icon="folder">
      <div class="toolbar stack" style="--gap: 10px">
        <span class="small muted num">
          <template v-if="day">本日 {{ dayLogCount }} 個 · </template>{{ days.length }} 天 · log 檔 {{ counts.files }} 個({{ fmtSize(counts.size) }})·
          <span class="c-success">已分析 {{ counts.done }}</span> · 未分析 {{ counts.pending }}
          <span v-if="counts.error" class="c-danger"> · 失敗 {{ counts.error }}</span>
        </span>
        <GAlert v-if="loadError" tone="danger">重新載入失敗,以下是上次的清單:{{ describeError(loadError) }}</GAlert>
        <GSegmented v-if="typeDirs.length" v-model="typeValue" size="sm" :options="typeDirs" class="types" />
        <nav class="crumbs small" aria-label="FTP 路徑">
          <template v-for="(c, i) in crumbs" :key="c.path">
            <GIcon v-if="i > 0" name="chevron-right" :size="14" class="faint" />
            <button type="button" class="crumb" :class="{ on: i === crumbs.length - 1 }" @click="load(c.path)">
              <GIcon v-if="i === 0" name="home" :size="14" />{{ i === 0 ? 'FTP 根目錄' : c.name }}
            </button>
          </template>
        </nav>
        <div class="filters">
          <div v-if="days.length" class="days">
            <GButton square icon="chevron-left" :disabled="!day || dayIndex >= days.length - 1" aria-label="前一天" title="前一天" @click="moveDay(1)" />
            <GSelect v-model="day" :options="dayOptions" placeholder="全部日期" class="day-select" />
            <GButton square icon="chevron-right" :disabled="!day || dayIndex <= 0" aria-label="後一天" title="後一天" @click="moveDay(-1)" />
          </div>
          <GInput v-model="keyword" icon="search" placeholder="篩選檔名" clearable class="grow" />
          <GSelect v-model="stateFilter" :options="stateOptions" placeholder="全部狀態" class="state-select" />
        </div>
        <GAlert v-if="manage && listing && !analyzable && counts.files" tone="info" title="這個目錄的檔案只能瀏覽,不能分析">
          只分析 TRAFFIC 目錄 <code>{{ listing.logDir }}</code>(FTP_LOG_DIR)與上方各類型 log 目錄裡的檔案;請切換到上方的目錄。
        </GAlert>
        <div v-if="manage && analyzable" class="filters">
          <GCheckbox :model-value="allSelected" :disabled="!selectable.length" label="全選目前清單" @update:model-value="toggleAll" />
          <span class="small muted num">已選 {{ selected.size }} 個</span>
          <div class="spacer" />
          <GButton size="sm" variant="primary" icon="play" :disabled="!selected.size" :loading="busy === 'analyze'" @click="analyze"
            >分析選取({{ selected.size }})</GButton
          >
          <GButton size="sm" variant="danger" icon="trash" :disabled="!selected.size" :loading="busy === 'forget'" @click="forget">刪除分析結果</GButton>
        </div>
      </div>

      <GTable
        :loading="loading && !listing"
        :rows="rows"
        row-key="path"
        :page-size="50"
        dense
        :columns="columns"
        empty-title="這個目錄沒有檔案"
        :empty-description="day ? '可切換日期或選「全部日期」' : undefined"
      >
        <template #cell-sel="{ row }">
          <GCheckbox
            v-if="analyzable && asFile(row).isLog"
            :model-value="selected.has(asFile(row).path)"
            :aria-label="`選取 ${asFile(row).name}`"
            @update:model-value="(v: boolean) => toggle(asFile(row), v)"
          />
          <!-- 插槽內容全是註解時 GTable 會顯示預設值,留空白元素 -->
          <span v-else />
        </template>
        <template #cell-name="{ row }">
          <button v-if="asFile(row).dir" type="button" class="name dir" @click="open(asFile(row))">
            <GIcon name="folder" :size="16" class="c-warning" /><span class="ellipsis">{{ asFile(row).name }}</span>
          </button>
          <span v-else class="name" :class="{ faint: !asFile(row).isLog }" :title="asFile(row).path">
            <GIcon name="file-text" :size="16" class="faint" /><span class="ellipsis">{{ asFile(row).name }}</span>
          </span>
        </template>
        <template #cell-size="{ row }">
          <span class="small nowrap num">{{ asFile(row).dir ? '' : fmtSize(asFile(row).size) }}</span>
        </template>
        <template #cell-modified="{ row }">
          <span class="small nowrap num">{{ asFile(row).modified ? fmtTime(asFile(row).modified) : '' }}</span>
        </template>
        <template #cell-state="{ row }">
          <GBadge v-if="asFile(row).isLog && asFile(row).state" :tone="PA_STATE[asFile(row).state!].tone" dot :title="asFile(row).error || undefined">
            {{ PA_STATE[asFile(row).state!].label }}
          </GBadge>
          <span v-else />
        </template>
        <template #cell-timeMin="{ row }">
          <span v-if="asFile(row).timeMin" class="small nowrap num">{{ fmtTime(asFile(row).timeMin) }} ~ {{ fmtClock(asFile(row).timeMax) }}</span>
          <span v-else-if="asFile(row).error" class="xs c-danger">{{ asFile(row).error }}</span>
          <span v-else-if="asFile(row).isLog" class="xs faint">{{ dayOf(asFile(row)) }}(依檔名)</span>
          <span v-else />
        </template>
        <template #cell-rows="{ row }">
          <span class="small num">{{ fmtNum(asFile(row).rows) }}</span>
        </template>
        <template #cell-ms="{ row }">
          <span class="small num">{{ asFile(row).ms == null ? '' : `${(asFile(row).ms! / 1000).toFixed(1)}s` }}</span>
        </template>
      </GTable>
    </GCard>
  </div>
</template>

<style scoped>
.prog-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 14px;
}
.running {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.running li {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  min-width: 0;
}
.running .ellipsis {
  max-width: 480px;
}
.toolbar {
  padding: 0 var(--space-4, 16px) var(--space-3, 12px);
}
.types {
  max-width: 100%;
  overflow-x: auto;
}
.types :deep(button) {
  white-space: nowrap;
}
.crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.crumb {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-2);
  font: inherit;
  cursor: pointer;
}
.crumb:hover,
.crumb.on {
  color: var(--c-primary-text);
}
.crumb.on {
  font-weight: 700;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.days {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
}
.day-select {
  width: 280px;
  max-width: 100%;
}
.state-select {
  width: 140px;
}
.grow {
  flex: 1 1 200px;
  min-width: 0;
}
.name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 420px;
  min-width: 0;
}
.name.dir {
  padding: 0;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.name.dir:hover {
  color: var(--c-primary-text);
}
@media (max-width: 760px) {
  .hide-sm {
    display: none;
  }
  .name {
    max-width: 180px;
  }
  .day-select {
    width: auto;
    flex: 1 1 auto;
  }
  .days {
    flex: 1 1 100%;
  }
  .state-select {
    flex: 1 1 100%;
    width: auto;
  }
}
</style>
