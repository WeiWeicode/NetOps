<script setup lang="ts">
/**
 * 網通知識 › IP 對照表(docs/API.md §11;IMPL-PLAN AC3,ARCHITECTURE D45):
 *   IP / 網段 → 使用者姓名、部門、設備;PA 各畫面 IP 旁邊顯示名稱、Log 明細可用名稱查、AI 會附上名稱。
 *   查詢、匯出、下載範本:netops.ip-name.read(選單 netops.ip-name-page.read,只給網管);
 *   新增 / 修改 / 刪除 / 匯入:按鈕 netops.ip-name-page.write。匯入 = 整份取代,先看預覽差異再確認。
 *   姓名、部門是個資:不放進網址、不存瀏覽器;匯出檔請妥善保管。
 */
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { can, describeError } from '@/api/gateway';
import { fmtNum, fmtTime } from '@/api/format';
import { DEVICE_TYPES, IMPORT_MAX_BYTES, IP_NAME_LIMITS, importFormatOf, ipNames, toBase64, type ImportPreview, type IpNameBody, type IpNameEntry } from '@/api/ipNames';
import { UI } from '@/api/perms';
import { ipFieldError } from '@/composables/ipNameForm';
import { confirm, toast } from '@/ui';

const PAGE_SIZE = 50;
const canWrite = computed(() => can(UI.ipNameWrite));

// ---------- 清單 ----------
const q = ref('');
const rows = shallowRef<IpNameEntry[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const error = ref<unknown>(null);
let seq = 0;

async function load(p = page.value) {
  const my = ++seq;
  loading.value = true;
  try {
    const r = await ipNames.list(q.value, p, PAGE_SIZE);
    if (my !== seq) return;
    rows.value = r.items;
    total.value = r.total;
    page.value = r.page;
    error.value = null;
  } catch (e) {
    if (my === seq) error.value = e;
  } finally {
    if (my === seq) loading.value = false;
  }
}
let debounce: ReturnType<typeof setTimeout> | undefined;
function onSearch() {
  clearTimeout(debounce);
  debounce = setTimeout(() => void load(1), 300);
}
onMounted(() => void load(1));

const COLUMNS = [
  { key: 'ip', label: 'IP / 網段', mono: true, width: '170px' },
  { key: 'name', label: '使用者姓名' },
  { key: 'department', label: '部門' },
  { key: 'device', label: '設備' },
  { key: 'note', label: '備註', hideSm: true },
  { key: 'updatedAt', label: '最後修改', hideSm: true, width: '170px' },
  { key: 'actions', label: '', align: 'right' as const, width: '96px' },
];
const columns = computed(() => (canWrite.value ? COLUMNS : COLUMNS.filter((c) => c.key !== 'actions')));
const asEntry = (r: unknown) => r as IpNameEntry;
const typeTone: Record<string, string> = { 筆電: 'info', 桌機: 'primary', 伺服器: 'warning', 印表機: 'neutral', 網路設備: 'success', 其他: 'neutral' };

// ---------- 單筆新增 / 修改 ----------
const EMPTY: IpNameBody = { ip: '', name: '', department: '', device: '', deviceType: '', note: '' };
const dialog = reactive({ open: false, id: '', saving: false, touched: false, ...EMPTY });
const deviceOptions = DEVICE_TYPES.map((t) => ({ label: t, value: t }));
const ipError = computed(() => (dialog.touched ? ipFieldError(dialog.ip) : ''));
const whoError = computed(() => (dialog.touched && !dialog.name.trim() && !dialog.department.trim() && !dialog.device.trim() ? '使用者姓名、部門、設備名稱至少填一項' : ''));

function openDialog(e?: IpNameEntry) {
  Object.assign(dialog, { open: true, id: e?.id ?? '', saving: false, touched: false, ...EMPTY, ...(e ? { ip: e.ip, name: e.name, department: e.department, device: e.device, deviceType: e.deviceType, note: e.note } : {}) });
}
async function save() {
  dialog.touched = true;
  const err = ipFieldError(dialog.ip) || whoError.value;
  if (err) return toast.warning(err);
  dialog.saving = true;
  const body: IpNameBody = { ip: dialog.ip.trim(), name: dialog.name.trim(), department: dialog.department.trim(), device: dialog.device.trim(), deviceType: dialog.deviceType, note: dialog.note.trim() };
  try {
    const r = dialog.id ? await ipNames.update(dialog.id, body) : await ipNames.create(body);
    toast.success(dialog.id ? '已修改對照' : '已新增對照', r.ip);
    dialog.open = false;
    await load();
  } catch (e) {
    toast.fromError(e, '儲存失敗');
  } finally {
    dialog.saving = false;
  }
}
async function remove(e: IpNameEntry) {
  const ok = await confirm({ title: `刪除 ${e.ip} 的對照?`, message: '刪除後 PA 畫面不再顯示這個 IP 的名稱;不記歷史,無法復原。', confirmText: '刪除', tone: 'danger' });
  if (!ok) return;
  try {
    await ipNames.remove(e.id);
    toast.success('已刪除對照', e.ip);
    await load(rows.value.length === 1 && page.value > 1 ? page.value - 1 : page.value);
  } catch (err) {
    toast.fromError(err, '刪除失敗');
  }
}

// ---------- 匯出 / 範本 ----------
const busy = ref('');
async function fileAction(kind: 'export' | 'template', format: 'xlsx' | 'csv') {
  busy.value = `${kind}-${format}`;
  try {
    await (kind === 'export' ? ipNames.exportFile(format) : ipNames.template(format));
  } catch (e) {
    toast.fromError(e, '下載失敗');
  } finally {
    busy.value = '';
  }
}

// ---------- 匯入(預覽 → 確認) ----------
const fileInput = ref<HTMLInputElement | null>(null);
const preview = shallowRef<ImportPreview | null>(null);
const previewOpen = ref(false);
const uploading = ref(false);
const confirming = ref(false);
const view = ref<'added' | 'changed' | 'removed' | 'errors'>('added');

async function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const format = importFormatOf(file.name);
  if (!format) return toast.warning('只接受 Excel(.xlsx)或 CSV 檔', '請用頁面提供的範本');
  if (file.size > IMPORT_MAX_BYTES) return toast.warning(`檔案超過 ${IMPORT_MAX_BYTES / 1024 / 1024} MB`);
  uploading.value = true;
  try {
    const p = await ipNames.preview(file.name, format, toBase64(await file.arrayBuffer()));
    preview.value = p;
    view.value = p.counts.added ? 'added' : p.counts.changed ? 'changed' : p.counts.removed ? 'removed' : p.errors.length ? 'errors' : 'added';
    previewOpen.value = true;
  } catch (e) {
    toast.fromError(e, '無法讀取檔案');
  } finally {
    uploading.value = false;
  }
}
const hasChanges = computed(() => {
  const c = preview.value?.counts;
  return !!c && c.added + c.changed + c.removed > 0;
});
async function confirmImport() {
  const p = preview.value;
  if (!p) return;
  if (p.counts.removed) {
    const ok = await confirm({ title: `確定刪除 ${fmtNum(p.counts.removed)} 筆對照?`, message: '匯入會以檔案整份取代對照表:檔案裡沒有的 IP 會被刪除,無法復原。', confirmText: '確定匯入', tone: 'danger' });
    if (!ok) return;
  }
  confirming.value = true;
  try {
    const r = await ipNames.confirm(p.id);
    toast.success('已匯入對照表', `新增 ${r.added}、修改 ${r.changed}、刪除 ${r.removed},共 ${r.total} 筆`);
    preview.value = null;
    previewOpen.value = false;
    await load(1);
  } catch (e) {
    toast.fromError(e, '匯入失敗');
  } finally {
    confirming.value = false;
  }
}
/** 關閉預覽(取消、Esc、右上角關閉;沒確認):丟棄伺服器上的預覽 */
watch(previewOpen, (open) => {
  if (open || !preview.value) return;
  const id = preview.value.id;
  preview.value = null;
  void ipNames.discard(id).catch(() => {});
});
const viewOptions = computed(() => {
  const c = preview.value?.counts;
  if (!c) return [];
  return [
    { label: `新增 ${fmtNum(c.added)}`, value: 'added' },
    { label: `修改 ${fmtNum(c.changed)}`, value: 'changed' },
    { label: `刪除 ${fmtNum(c.removed)}`, value: 'removed' },
    { label: `有問題 ${fmtNum(preview.value!.errors.length)}`, value: 'errors' },
  ];
});
const viewCount = computed(() => {
  const p = preview.value;
  if (!p) return 0;
  return view.value === 'errors' ? p.errors.length : p.counts[view.value];
});
const listed = computed(() => {
  const p = preview.value;
  if (!p) return 0;
  return view.value === 'errors' ? p.errors.length : view.value === 'changed' ? p.diff.changed.length : p.diff[view.value].length;
});
const who = (e: IpNameEntry) => [e.name, e.department, [e.device, e.deviceType].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || '—';
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <GCard padding="sm">
      <div class="toolbar">
        <GInput v-model="q" icon="search" placeholder="IP、姓名、部門、設備、備註" clearable class="grow" aria-label="搜尋對照表" @update:model-value="onSearch" />
        <div class="actions">
          <GButton v-if="canWrite" variant="primary" icon="plus" @click="openDialog()">新增</GButton>
          <GButton v-if="canWrite" icon="upload" :loading="uploading" @click="fileInput?.click()">匯入檔案</GButton>
          <GButton icon="download" :loading="busy === 'export-xlsx'" @click="fileAction('export', 'xlsx')">匯出 Excel</GButton>
          <GButton variant="ghost" icon="file-down" :loading="busy === 'export-csv'" @click="fileAction('export', 'csv')">CSV</GButton>
        </div>
        <input ref="fileInput" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" class="sr-only" tabindex="-1" aria-hidden="true" @change="onFile" />
      </div>
    </GCard>

    <GAlert v-if="canWrite" tone="info" title="匯入方式">
      <p class="note">
        下載範本填好後匯入:第一列是欄名,兩列範例會自動略過;設備類型可選 {{ DEVICE_TYPES.join('、') }}。匯入會以檔案<strong>整份取代</strong>對照表(檔案沒有的會刪除),先顯示差異,確認後才寫入。網段重疊時範圍最小的優先。
      </p>
      <div class="tpl">
        <GButton size="sm" icon="file-text" :loading="busy === 'template-xlsx'" @click="fileAction('template', 'xlsx')">下載 Excel 範本</GButton>
        <GButton size="sm" variant="ghost" icon="file-text" :loading="busy === 'template-csv'" @click="fileAction('template', 'csv')">CSV 範本</GButton>
      </div>
    </GAlert>

    <GCard padding="none" title="IP 對照表" icon="users" :subtitle="`共 ${fmtNum(total)} 筆 · PA 畫面的 IP 旁會顯示名稱,看得到 PA 的人都看得到`">
      <GAlert v-if="error" tone="danger" class="pad">{{ describeError(error) }}</GAlert>
      <GTable
        v-model:page="page"
        :loading="loading && !rows.length"
        :rows="rows"
        :total="total"
        :page-size="PAGE_SIZE"
        row-key="id"
        dense
        :columns="columns"
        :empty-title="q ? '沒有符合的對照' : '對照表還沒有資料'"
        :empty-description="q ? '換個關鍵字試試' : canWrite ? '可以單筆新增,或下載範本填好後匯入' : ''"
        @update:page="(p) => load(p)"
      >
        <template #cell-name="{ row }">
          <span>{{ asEntry(row).name || '—' }}</span>
        </template>
        <template #cell-department="{ row }">
          <span>{{ asEntry(row).department || '—' }}</span>
        </template>
        <template #cell-device="{ row }">
          <span class="device">
            <span>{{ asEntry(row).device || '—' }}</span>
            <GBadge v-if="asEntry(row).deviceType" :tone="typeTone[asEntry(row).deviceType] ?? 'neutral'">{{ asEntry(row).deviceType }}</GBadge>
          </span>
        </template>
        <template #cell-note="{ row }">
          <span class="small muted clamp" :title="asEntry(row).note">{{ asEntry(row).note || '' }}</span>
        </template>
        <template #cell-updatedAt="{ row }">
          <span class="small faint nowrap" :title="asEntry(row).updatedBy">{{ fmtTime(asEntry(row).updatedAt) }}</span>
        </template>
        <template #cell-actions="{ row }">
          <span class="row-actions">
            <GButton size="sm" variant="ghost" icon="edit" :aria-label="`修改 ${asEntry(row).ip}`" @click="openDialog(asEntry(row))" />
            <GButton size="sm" variant="ghost" icon="trash" :aria-label="`刪除 ${asEntry(row).ip}`" @click="remove(asEntry(row))" />
          </span>
        </template>
      </GTable>
    </GCard>

    <GModal v-model:open="dialog.open" :title="dialog.id ? '修改對照' : '新增對照'" icon="edit" width="620px" :persistent="dialog.saving">
      <form class="stack form" style="--gap: 12px" @submit.prevent="save">
        <GInput v-model="dialog.ip" label="IP 或網段" placeholder="10.10.1.5 或 10.10.1.0/24" required :error="ipError" hint="網段重疊時範圍最小的優先" @blur="dialog.touched = true" />
        <div class="grid2">
          <GInput v-model="dialog.name" label="使用者姓名" :hint="`最多 ${IP_NAME_LIMITS.name} 字`" :error="whoError" />
          <GInput v-model="dialog.department" label="部門" :hint="`最多 ${IP_NAME_LIMITS.department} 字`" />
          <GInput v-model="dialog.device" label="設備名稱" placeholder="例 IT-NB-001" :hint="`最多 ${IP_NAME_LIMITS.device} 字`" />
          <GSelect v-model="dialog.deviceType" label="設備類型" :options="deviceOptions" placeholder="不指定" />
        </div>
        <GTextarea v-model="dialog.note" label="備註" :rows="2" :hint="`最多 ${IP_NAME_LIMITS.note} 字`" />
        <button type="submit" hidden />
      </form>
      <template #footer>
        <GButton :disabled="dialog.saving" @click="dialog.open = false">取消</GButton>
        <GButton variant="primary" icon="save" :loading="dialog.saving" @click="save">儲存</GButton>
      </template>
    </GModal>

    <GModal v-model:open="previewOpen" title="匯入預覽" :subtitle="preview?.fileName" icon="upload" width="860px" :persistent="confirming">
      <div v-if="preview" class="stack" style="--gap: 12px">
        <div class="stats" role="list" aria-label="匯入差異">
          <div role="listitem" class="stat"><span class="num big c-success">{{ fmtNum(preview.counts.added) }}</span><span class="small muted">新增</span></div>
          <div role="listitem" class="stat"><span class="num big c-primary">{{ fmtNum(preview.counts.changed) }}</span><span class="small muted">修改</span></div>
          <div role="listitem" class="stat"><span class="num big c-danger">{{ fmtNum(preview.counts.removed) }}</span><span class="small muted">刪除</span></div>
          <div role="listitem" class="stat"><span class="num big">{{ fmtNum(preview.counts.unchanged) }}</span><span class="small muted">不變</span></div>
          <div role="listitem" class="stat"><span class="num big c-warning">{{ fmtNum(preview.errors.length) }}</span><span class="small muted">有問題(不匯入)</span></div>
        </div>
        <p class="small muted note">檔案共 {{ fmtNum(preview.total) }} 筆有效資料{{ preview.skipped ? `,已略過 ${preview.skipped} 列範例` : '' }}。預覽保留到 {{ fmtTime(preview.expiresAt) }}。</p>
        <GAlert v-if="preview.counts.removed" tone="warning">檔案裡沒有的 {{ fmtNum(preview.counts.removed) }} 筆會被刪除;如果只是要新增,請先「匯出 Excel」再加上新的列後匯入。</GAlert>
        <GAlert v-if="!hasChanges && !preview.errors.length" tone="info">檔案內容和目前的對照表相同,不需要匯入。</GAlert>
        <GSegmented v-model="view" :options="viewOptions" size="sm" />
        <div class="diff" tabindex="0" :aria-label="`${viewOptions.find((o) => o.value === view)?.label} 清單`">
          <p v-if="!viewCount" class="small muted empty">沒有項目</p>
          <ul v-else-if="view === 'errors'" class="list">
            <li v-for="e in preview.errors" :key="`${e.row}`">
              <span class="small num faint">第 {{ e.row }} 列</span>
              <span class="mono small">{{ e.ip || '(空白)' }}</span>
              <span class="small c-danger">{{ e.message }}</span>
            </li>
          </ul>
          <ul v-else-if="view === 'changed'" class="list">
            <li v-for="c in preview.diff.changed" :key="c.after.ip">
              <span class="mono small ip">{{ c.after.ip }}</span>
              <span class="small muted strike">{{ who(c.before) }}</span>
              <span class="small" aria-hidden="true">→</span>
              <span class="small">{{ who(c.after) }}</span>
            </li>
          </ul>
          <ul v-else class="list">
            <li v-for="e in preview.diff[view]" :key="e.ip">
              <span class="mono small ip">{{ e.ip }}</span>
              <span class="small" :class="{ 'muted strike': view === 'removed' }">{{ who(e) }}</span>
            </li>
          </ul>
          <p v-if="listed < viewCount" class="small faint more">只列出前 {{ fmtNum(listed) }} 筆,共 {{ fmtNum(viewCount) }} 筆</p>
        </div>
      </div>
      <template #footer>
        <GButton :disabled="confirming" @click="previewOpen = false">取消</GButton>
        <GButton :variant="preview?.counts.removed ? 'danger' : 'primary'" icon="check" :loading="confirming" :disabled="!hasChanges" @click="confirmImport">確認匯入</GButton>
      </template>
    </GModal>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 12px;
}
.grow {
  flex: 1 1 260px;
  min-width: 0;
}
.actions,
.tpl {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tpl {
  margin-top: 8px;
}
.note {
  margin: 0;
}
.pad {
  margin: 0 var(--space-4) var(--space-3);
}
.device {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}
.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.row-actions {
  display: inline-flex;
  gap: 2px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--glass-border-2);
  border-radius: 10px;
  background: var(--glass-soft);
}
.big {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.1;
}
.c-success {
  color: var(--c-success);
}
.c-primary {
  color: var(--c-primary-text);
}
.c-warning {
  color: var(--c-warning);
}
.diff {
  max-height: 46vh;
  overflow: auto;
  border: 1px solid var(--glass-border-2);
  border-radius: 10px;
  padding: 4px 0;
}
.diff:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.list li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--glass-border-2);
}
.list li:last-child {
  border-bottom: 0;
}
.ip {
  min-width: 9.5em;
}
.strike {
  text-decoration: line-through;
}
.empty,
.more {
  margin: 0;
  padding: 10px 12px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
@media (max-width: 760px) {
  .grid2 {
    grid-template-columns: 1fr;
  }
  .stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .actions {
    width: 100%;
  }
  .actions > * {
    flex: 1 1 auto;
  }
}
</style>
