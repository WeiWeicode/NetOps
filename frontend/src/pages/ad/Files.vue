<script setup lang="ts">
/**
 * AD 網域 › FTP Log 檔案(docs/API.md §5.2;舊版 src/views/AdFiles.vue):
 *   FTP /AD_Log_Backup/yyyyMMdd/*.csv(DC 每天匯出)與匯入狀態。清單改工作模式(舊版逐一列出日期資料夾最長 120 秒)。
 *   有管理權限(UI.adFilesManage)可:同步 = 新的 / 有變動的日期才匯入;重新匯入選取 = 一律重新讀取(一次最多 60 天);
 *   刪除匯入結果 = 只刪本系統的資料,FTP 檔案不動。同步與匯入在背景執行,完成後重新列出清單。
 *   列出清單要連 FTP 逐一列日期資料夾(最長 3 分鐘,佔用 FTP 連線):頁面載入時不送出,有管理權限的人按「列出 FTP 資料夾」才送出
 *   (需求方 2026-11-05 決定;D1 驗收 §4.2)。沒有管理權限的人只看得到同步狀態。
 *   「每日自動同步」卡片(AC1):每天對帳後自動匯入 AD,顯示 FTP 保留期限內每天是否已匯入。
 */
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { can, describeError } from '@/api/gateway';
import { AD_CHANNEL, AD_IMPORT_MAX, adFtp, type AdDay, type AdStatus } from '@/api/ftp';
import { fmtNum, fmtSize, fmtTime } from '@/api/format';
import { UI } from '@/api/perms';
import DailySyncCard from '@/components/DailySyncCard.vue';
import { AD_STATE, securityEmptyDays } from '@/composables/ftpFiles';
import { useJob } from '@/composables/useJob';
import { usePolling } from '@/composables/usePolling';
import { confirm, toast } from '@/ui';

const POLL_MS = 2000;
const manage = computed(() => can(UI.adFilesManage));

// ---------- 清單(工作模式) ----------
const listing = useJob({ create: () => adFtp.listings.create(), get: adFtp.listings.get, cancel: adFtp.listings.cancel });
/** 保留上一次成功的清單:重新列出時畫面不清空 */
const last = shallowRef<{ dir: string; days: AdDay[] } | null>(null);
watch(listing.result, (r) => {
  if (!r) return;
  last.value = r;
  const keep = new Set(r.days.map((d) => d.day));
  selected.value = new Set([...selected.value].filter((d) => keep.has(d)));
});
const days = computed(() => last.value?.days ?? []);
const reload = () => listing.start(undefined);

const counts = computed(() => {
  const c = { days: days.value.length, files: 0, size: 0, done: 0, pending: 0 };
  for (const d of days.value) {
    c.files += d.files.length;
    c.size += d.files.reduce((a, f) => a + f.size, 0);
    if (d.state === 'done') c.done++;
    else c.pending++;
  }
  return c;
});
const emptySecurity = computed(() => securityEmptyDays(days.value));

// ---------- 選取 ----------
const selected = ref(new Set<string>());
const allSelected = computed(() => days.value.length > 0 && days.value.every((d) => selected.value.has(d.day)));
function toggle(day: string, on: boolean) {
  const s = new Set(selected.value);
  if (on) s.add(day);
  else s.delete(day);
  selected.value = s;
}
function toggleAll(on: boolean) {
  selected.value = on ? new Set(days.value.map((d) => d.day)) : new Set();
}
const selectedDays = computed(() => days.value.filter((d) => selected.value.has(d.day)).map((d) => d.day));

// ---------- 同步 / 匯入進度 ----------
const status = shallowRef<AdStatus | null>(null);
const statusError = ref<Error | null>(null);
/** 上次輪詢時是否在同步 / 匯入(只在輪詢更新;操作回應改了 status 也不影響「剛結束」的判斷) */
let polledRunning = false;

const poller = usePolling(
  () => adFtp.status(),
  (r) => {
    if (r instanceof Error) statusError.value = r;
    else {
      status.value = r;
      statusError.value = null;
    }
    const running = !!status.value?.running;
    // 同步 / 匯入剛結束:已經列過清單才重新列出(不替沒按「列出」的人連 FTP)
    if (!running && polledRunning && manage.value && last.value) void reload();
    polledRunning = running;
    return running;
  },
  POLL_MS,
);
const poll = () => {
  polledRunning ||= !!status.value?.running;
  void poller.run();
};

// ---------- 操作 ----------
const busy = ref<'' | 'sync' | 'import' | 'forget'>('');

async function sync() {
  busy.value = 'sync';
  try {
    status.value = await adFtp.sync();
    toast.info('已開始同步', '有變更的日期會在背景重新匯入,完成後自動更新清單');
    poll();
  } catch (e) {
    toast.fromError(e, '同步失敗');
  } finally {
    busy.value = '';
  }
}

async function reimport() {
  const list = selectedDays.value;
  if (!list.length) return toast.warning('請勾選日期');
  if (list.length > AD_IMPORT_MAX) return toast.warning(`一次最多重新匯入 ${AD_IMPORT_MAX} 天`, `目前選了 ${list.length} 天`);
  busy.value = 'import';
  try {
    status.value = await adFtp.reimport(list);
    toast.info(`已開始重新匯入 ${list.length} 天`, '在背景執行,完成後自動更新清單');
    selected.value = new Set();
    poll();
  } catch (e) {
    toast.fromError(e, '重新匯入失敗');
  } finally {
    busy.value = '';
  }
}

async function forget() {
  const list = selectedDays.value;
  if (!list.length) return toast.warning('請勾選日期');
  const ok = await confirm({
    title: `刪除 ${list.length} 天的匯入結果?`,
    message: `${list.join('、')}:FTP 上的檔案不會刪除,之後同步會重新匯入。`,
    confirmText: '刪除',
    tone: 'danger',
  });
  if (!ok) return;
  busy.value = 'forget';
  try {
    const r = await adFtp.forget(list);
    toast.success(`已刪除 ${r.deleted} 天的匯入結果`);
    selected.value = new Set();
    void reload();
  } catch (e) {
    toast.fromError(e, '刪除失敗');
  } finally {
    busy.value = '';
  }
}

// ---------- 檔案明細 ----------
const detail = ref<AdDay | null>(null);
const detailOpen = computed({ get: () => !!detail.value, set: (v) => !v && (detail.value = null) });

/** 「列出 FTP 資料夾」(管理權限):送出清單工作並更新同步狀態 */
function listFtp() {
  if (!manage.value || listing.running.value) return;
  void reload();
  poll();
}

// 載入時只查同步狀態(GET,不連 FTP)
onMounted(poll);

const asDay = (r: unknown) => r as AdDay;
const columns = computed(() => [
  ...(manage.value ? [{ key: 'sel', label: '', width: '44px' }] : []),
  { key: 'day', label: '日期', width: '120px' },
  { key: 'state', label: '狀態', width: '110px' },
  { key: 'files', label: '檔案', hideSm: true },
  { key: 'events', label: '事件數', align: 'right' as const, width: '100px' },
  { key: 'importedAt', label: '匯入時間', width: '170px', hideSm: true },
  { key: 'more', label: '', align: 'right' as const, width: '56px' },
]);
const fileColumns = [
  { key: 'name', label: '檔案' },
  { key: 'channel', label: '記錄', width: '110px' },
  { key: 'size', label: '大小', align: 'right' as const, width: '90px' },
  { key: 'modified', label: '修改時間', width: '170px', hideSm: true },
  { key: 'rows', label: '事件數', align: 'right' as const, width: '110px' },
];
type FileRow = AdDay['files'][number];
const asFile = (r: unknown) => r as FileRow;
const channelsText = (d: AdDay) => d.files.map((f) => `${AD_CHANNEL[f.channel] ?? f.channel}${f.rows == null ? '' : ` ${fmtNum(f.rows)}`}`).join('、');
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <Teleport to="#page-actions" defer>
      <GButton v-if="manage" icon="list" :loading="listing.running.value" @click="listFtp">列出 FTP 資料夾</GButton>
      <GButton v-else icon="refresh" @click="poll">重新整理</GButton>
      <GButton v-if="manage" variant="primary" icon="download" :loading="busy === 'sync'" :disabled="!!status?.running" @click="sync">同步新檔案</GButton>
    </Teleport>

    <GAlert v-if="statusError" tone="danger" title="無法取得同步狀態">{{ describeError(statusError) }}</GAlert>
    <GAlert v-if="status?.lastSyncError" tone="warning" title="上次同步失敗,匯入結果可能不完整">{{ status.lastSyncError }}</GAlert>
    <GAlert v-if="status?.running" tone="info" title="同步 / 匯入進行中">在背景執行,完成後自動重新列出清單。</GAlert>
    <!-- 對帳後每日同步(AC1):只看 AD -->
    <DailySyncCard :status="status?.daily" :only="['ad']" />
    <GAlert v-if="emptySecurity.length" tone="warning" :title="`${emptySecurity.join('、')} 的 Security 檔案沒有事件`">
      通常是 DC 的 Security 記錄容量太小、前一天的事件在匯出前就被覆蓋;請看 DC 上 <code>C:\ADLogBackup\Backup-Execution.log</code> 的 WARN(v3
      匯出程式會記錄最舊事件的時間),並加大 Security 記錄上限。
    </GAlert>

    <GCard v-if="listing.error.value && !last">
      <GEmpty tone="danger" icon="folder" title="無法列出 FTP 上的 AD log" :description="describeError(listing.error.value)">
        <GButton icon="refresh" @click="reload">重試</GButton>
      </GEmpty>
    </GCard>
    <GCard v-else padding="none" :title="last ? `FTP ${last.dir}` : status?.dir ? `FTP ${status.dir}` : 'FTP 資料夾'" icon="folder">
      <div class="toolbar stack" style="--gap: 10px">
        <span v-if="!last" class="small muted num">
          尚未列出 FTP 資料夾<template v-if="status?.lastSyncAt"> · 上次同步 {{ fmtTime(status.lastSyncAt) }}</template>
        </span>
        <span v-else class="small muted num">
          {{ counts.days }} 天、{{ counts.files }} 個檔({{ fmtSize(counts.size) }})· <span class="c-success">已匯入 {{ counts.done }}</span> · 未匯入 / 已變更
          {{ counts.pending }}
          <template v-if="status?.lastSyncAt"> · 上次同步 {{ fmtTime(status.lastSyncAt) }}</template>
        </span>
        <GAlert v-if="listing.error.value" tone="danger">重新列出失敗,以下是上次的清單:{{ describeError(listing.error.value) }}</GAlert>
        <div v-if="listing.running.value" class="filters small muted">
          <span class="spin" aria-hidden="true" />
          <span>正在列出 FTP 上的日期資料夾(最長 3 分鐘)…</span>
          <div class="spacer" />
          <GButton size="sm" variant="ghost" icon="square" @click="() => listing.cancel()">取消</GButton>
        </div>
        <div v-if="manage" class="filters">
          <GCheckbox :model-value="allSelected" :disabled="!days.length" label="全選" @update:model-value="toggleAll" />
          <span class="small muted num">已選 {{ selected.size }} 天</span>
          <div class="spacer" />
          <GButton size="sm" variant="primary" icon="reset" :disabled="!selected.size || !!status?.running" :loading="busy === 'import'" @click="reimport">
            重新匯入選取({{ selected.size }})
          </GButton>
          <GButton size="sm" variant="danger" icon="trash" :disabled="!selected.size || !!status?.running" :loading="busy === 'forget'" @click="forget"
            >刪除匯入結果</GButton
          >
        </div>
      </div>

      <GTable
        :loading="listing.running.value && !last"
        :rows="days"
        row-key="day"
        :page-size="31"
        dense
        :columns="columns"
        :empty-title="last ? 'FTP 上沒有 AD log 資料夾' : '尚未列出 FTP 資料夾'"
        :empty-description="
          last
            ? undefined
            : manage
              ? '按右上「列出 FTP 資料夾」列出日期資料夾與匯入狀態(最長 3 分鐘,會佔用 FTP 連線)'
              : '列出 FTP 資料夾需要 AD FTP 管理權限;已匯入的事件請到「AD 事件總覽」查看'
        "
      >
        <template #cell-sel="{ row }">
          <GCheckbox
            :model-value="selected.has(asDay(row).day)"
            :aria-label="`選取 ${asDay(row).day}`"
            @update:model-value="(v: boolean) => toggle(asDay(row).day, v)"
          />
        </template>
        <template #cell-day="{ row }">
          <span class="num strong nowrap">{{ asDay(row).day }}</span>
        </template>
        <template #cell-state="{ row }">
          <GBadge :tone="AD_STATE[asDay(row).state].tone" dot>{{ AD_STATE[asDay(row).state].label }}</GBadge>
        </template>
        <template #cell-files="{ row }">
          <span class="xs muted">{{ channelsText(asDay(row)) }}</span>
        </template>
        <template #cell-events="{ row }">
          <span class="small num">{{ fmtNum(asDay(row).events) }}</span>
        </template>
        <template #cell-importedAt="{ row }">
          <span class="small nowrap num">{{ asDay(row).importedAt ? fmtTime(asDay(row).importedAt) : '' }}</span>
        </template>
        <template #cell-more="{ row }">
          <GButton
            size="sm"
            variant="ghost"
            icon="list"
            square
            :title="`${asDay(row).day} 的檔案`"
            :aria-label="`${asDay(row).day} 的檔案`"
            @click="detail = asDay(row)"
          />
        </template>
      </GTable>
    </GCard>

    <GModal v-model:open="detailOpen" :title="detail ? `${detail.day} 的檔案` : ''" :subtitle="detail?.path" icon="folder" width="760px">
      <GTable v-if="detail" :rows="detail.files" row-key="name" :page-size="0" dense :columns="fileColumns" empty-title="這個資料夾沒有檔案">
        <template #cell-name="{ row }">
          <span class="name"
            ><GIcon name="file-text" :size="15" class="faint" /><span class="ellipsis">{{ asFile(row).name }}</span></span
          >
        </template>
        <template #cell-channel="{ row }">{{ AD_CHANNEL[asFile(row).channel] ?? asFile(row).channel }}</template>
        <template #cell-size="{ row }">
          <span class="small num nowrap">{{ fmtSize(asFile(row).size) }}</span>
        </template>
        <template #cell-modified="{ row }">
          <span class="small num nowrap">{{ fmtTime(asFile(row).modified) }}</span>
        </template>
        <template #cell-rows="{ row }">
          <span v-if="asFile(row).error" class="small c-danger" :title="asFile(row).error">讀取失敗</span>
          <span v-else-if="asFile(row).rows === 0 && asFile(row).channel === 'Security'" class="small c-warning">0(空的)</span>
          <span v-else class="small num">{{ fmtNum(asFile(row).rows) }}</span>
        </template>
      </GTable>
      <template #footer>
        <GButton @click="detail = null">關閉</GButton>
      </template>
    </GModal>
  </div>
</template>

<style scoped>
.toolbar {
  padding: 0 var(--space-4) var(--space-3);
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 360px;
  min-width: 0;
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
</style>
