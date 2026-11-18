<script setup lang="ts">
/**
 * 網通設定 › 網段設定(docs/SEGMENT-SETTINGS-PLAN.md §2、§3 A–B;SG-3 + SG-4 畫面):
 *   - 網段清單(名稱、代碼、類型 VLAN / 核心服務、圖示、多個 CIDR、新增 / 修改 / 刪除 / 拖曳與上下排序)
 *   - 戰情室儀表滿格值(吞吐量、連線數)
 *   - 即時驗證錯誤(新增空白 CIDR 於碰過欄位後顯示)與網段重疊標示
 *   - 流量預覽(近 5 分鐘各網段連線數、未分類內部 IP Top 20)
 *   - 搭配 A(useUnmatchedAssist):未分類 IP 旁顯示設備名稱 / 部門(有權限才查),一鍵「加入某網段」或「依此 IP 建 /24 網段」
 *   - 搭配 B(useIpNameCidrImport):「從 IP 對照表匯入」對話框,勾選對照表中的網段列匯入成網段(已涵蓋者停用勾選)
 *   - 儲存、版本衝突提示(重新載入 / 保留草稿重套)、JSON 匯入 / 匯出
 */
import { computed, getCurrentInstance, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { can, describeError } from '@/api/gateway';
import { fmtNum, fmtTime } from '@/api/format';
import { UI } from '@/api/perms';
import { SEGMENT_LIMITS, type SegmentKind } from '@/api/segments';
import { fmtBps } from '@/composables/paLive';
import { useIpNameCidrImport, useUnmatchedAssist } from '@/composables/useSegmentPairing';
import { useSegmentSettings, type UseSegmentSettingsOptions } from '@/composables/useSegmentSettings';
import { confirm, toast } from '@/ui';

const props = defineProps<{ options?: UseSegmentSettingsOptions }>();

const s = useSegmentSettings(props.options);
const assist = useUnmatchedAssist(s);
const cidrImport = useIpNameCidrImport(s);

const canWrite = computed(() => can(UI.segmentWrite));

const KIND_OPTIONS: { label: string; value: SegmentKind }[] = [
  { label: 'VLAN 網段', value: 'vlan' },
  { label: '核心服務', value: 'service' },
];

const ICON_OPTIONS = [
  { label: '網路 (network)', value: 'network' },
  { label: '辦公 / 電腦 (office)', value: 'office' },
  { label: '個人電腦 (pc)', value: 'pc' },
  { label: '伺服器 (server)', value: 'server' },
  { label: '廠區 (factory)', value: 'factory' },
  { label: '無線網路 (wifi)', value: 'wifi' },
  { label: '全球 / 外部 (globe)', value: 'globe' },
  { label: '雲端 (cloud)', value: 'cloud' },
  { label: '安全防護 (shield)', value: 'shield' },
  { label: '門禁 / 鎖 (lock)', value: 'lock' },
  { label: '金鑰 / 憑證 (key)', value: 'key' },
  { label: '郵件 (mail)', value: 'mail' },
  { label: '管理設備 (gear)', value: 'gear' },
];

// ---------- 欄位碰過(touched)狀態 ----------
const touched = reactive(new Set<string>());
const showAllErrors = ref(false);

function touch(field: string) {
  touched.add(field);
}

function resetTouched() {
  touched.clear();
  showAllErrors.value = false;
}

function fieldError(field: string, force = false): string | null {
  if (!force && !showAllErrors.value && !touched.has(field)) return null;
  const list = s.issuesOf(field);
  return list.find((e) => e.field === field)?.message ?? null;
}

function cidrError(i: number, k: number): string | null {
  const path = `segments[${i}].cidrs[${k}]`;
  const val = s.draft.segments[i]?.cidrs[k] ?? '';
  // 新增的網段 CIDR 預設空白:碰過欄位或點過儲存後才顯示錯誤;已有輸入內容則即時顯示
  if (val === '' && !showAllErrors.value && !touched.has(path)) return null;
  return s.issuesOf(path)[0]?.message ?? null;
}

function onCidrBlur(i: number, k: number) {
  const path = `segments[${i}].cidrs[${k}]`;
  touched.add(path);
  s.normalizeCidrAt(i, k);
}

// ---------- 網段清單編輯與拖曳排序 ----------
const dragFrom = ref<number | null>(null);
const dragOver = ref<number | null>(null);

function onAddSegment() {
  const idx = s.addSegment();
  if (idx < 0) {
    toast.warning(`最多只能設定 ${SEGMENT_LIMITS.segments} 個網段`);
  }
}

function onRemoveSegment(i: number) {
  s.removeSegment(i);
  resetTouched();
}

function onMoveSegment(from: number, to: number) {
  s.moveSegment(from, to);
  resetTouched();
}

function onDragStart(i: number, e: DragEvent) {
  if (!canWrite.value || s.saving) return;
  dragFrom.value = i;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
  }
}

function onDragOver(i: number) {
  if (dragFrom.value === null) return;
  dragOver.value = i;
}

function onDrop(to: number) {
  if (dragFrom.value !== null && dragFrom.value !== to) {
    onMoveSegment(dragFrom.value, to);
  }
  dragFrom.value = null;
  dragOver.value = null;
}

function onDragEnd() {
  dragFrom.value = null;
  dragOver.value = null;
}

function onAddCidr(i: number) {
  s.addCidr(i);
}

function onRemoveCidr(i: number, k: number) {
  s.removeCidr(i, k);
  resetTouched();
}

// ---------- 儲存 / 重設 / 版本衝突 ----------
async function onSave() {
  showAllErrors.value = true;
  if (s.issues.length) {
    toast.warning('設定欄位有誤，請先修正標紅的欄位');
    return;
  }
  const ok = await s.save();
  if (ok) {
    resetTouched();
    toast.success('已儲存網段設定', `版本 v${s.meta?.version ?? ''}`);
  } else if (s.conflict) {
    toast.warning('版本衝突', '網段設定已被其他人修改，請選擇重新載入或保留草稿重套');
  } else if (s.error) {
    toast.fromError(s.error, '儲存失敗');
  }
}

async function onReset() {
  if (s.dirty) {
    const ok = await confirm({
      title: '放棄目前草稿變更？',
      message: '將還原為最後一次載入或儲存的網段設定內容。',
      confirmText: '放棄變更',
      tone: 'danger',
    });
    if (!ok) return;
  }
  s.reset();
  resetTouched();
}

async function onReload() {
  if (s.dirty) {
    const ok = await confirm({
      title: '重新載入網段設定？',
      message: '目前有未儲存的草稿變更，重新載入將會遺失這些修改。',
      confirmText: '重新載入',
      tone: 'danger',
    });
    if (!ok) return;
  }
  await s.load();
  resetTouched();
}

async function onConflictReload() {
  const ok = await confirm({
    title: '放棄草稿並重新載入？',
    message: '將捨棄您目前的修改，載入伺服器上的最新版本。',
    confirmText: '重新載入',
    tone: 'danger',
  });
  if (!ok) return;
  await s.load();
  resetTouched();
  toast.info('已載入最新網段設定');
}

async function onConflictRebase() {
  const ok = await confirm({
    title: '保留草稿並重套最新版本號？',
    message: '套用伺服器最新版本號後，下次按「儲存設定」將會以您的草稿覆蓋他人剛才儲存的修改。',
    confirmText: '保留草稿重套',
    tone: 'danger',
  });
  if (!ok) return;
  const done = await s.rebase();
  if (done) {
    toast.info('已套用最新版本號，請確認內容後再按「儲存設定」');
  } else if (s.error) {
    toast.fromError(s.error, '無法取得最新版本號');
  }
}

// ---------- 流量預覽 & 搭配 A(未分類 IP 協助分類) ----------
const targetSegIndex = reactive<Record<string, number>>({});

function targetIdxOf(ip: string): number {
  const idx = targetSegIndex[ip] ?? 0;
  return idx >= 0 && idx < s.draft.segments.length ? idx : 0;
}

function setTargetIdx(ip: string, val: string) {
  targetSegIndex[ip] = Number(val) || 0;
}

async function onRunPreview() {
  showAllErrors.value = true;
  if (s.issues.length) {
    toast.warning('請先修正設定中的欄位錯誤再執行預覽');
    return;
  }
  await s.runPreview();
}

function onAddIpToSegment(ip: string) {
  const idx = targetIdxOf(ip);
  const seg = s.draft.segments[idx];
  if (!seg) return;
  const ok = assist.addToSegment(ip, idx);
  if (ok) {
    toast.success(`已將 ${ip}/32 加入「${seg.label}」`);
  } else {
    toast.warning(`無法加入「${seg.label}」`, '可能已存在於該網段或已達 CIDR 數量上限');
  }
}

function onCreateSlash24(ip: string) {
  const idx = assist.createSlash24(ip);
  if (idx >= 0) {
    const created = s.draft.segments[idx];
    toast.success('已建立 /24 網段草稿', `${created?.label ?? ''} (${created?.cidrs[0] ?? ''})`);
  } else {
    toast.warning('無法建立 /24 網段', '該 /24 網段已被現有網段涵蓋，或已達網段數量上限');
  }
}

function formatAssistLabel(label: { name: string; department: string; device: string } | null): string {
  if (!label) return '—';
  return [label.device, label.department, label.name].filter(Boolean).join(' · ') || '—';
}

// ---------- 搭配 B(從 IP 對照表匯入網段列) ----------
const cidrModalOpen = ref(false);
const importKind = ref<SegmentKind>('vlan');

async function openCidrModal() {
  cidrModalOpen.value = true;
  await cidrImport.load();
}

const selectableCandidates = computed(() => cidrImport.candidates.filter((c) => !c.coveredBy));

function selectAllUncovered() {
  for (const c of selectableCandidates.value) {
    if (!cidrImport.selected.has(c.key)) cidrImport.toggle(c.key);
  }
}

function clearCidrSelection() {
  for (const key of [...cidrImport.selected]) {
    cidrImport.toggle(key);
  }
}

function onConfirmCidrImport() {
  const added = cidrImport.importSelected(importKind.value);
  if (added > 0) {
    toast.success(`已從 IP 對照表匯入 ${added} 個網段至草稿`);
    cidrModalOpen.value = false;
  } else {
    toast.warning('沒有可匯入的網段項目');
  }
}

// ---------- JSON 匯出 / 匯入 ----------
const jsonInput = ref<HTMLInputElement | null>(null);

function onExport() {
  const { fileName, content, mime } = s.exportFile();
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

async function onImportFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const err = s.importText(text);
    if (err) {
      toast.warning('匯入 JSON 失敗', err);
      return;
    }
    showAllErrors.value = true;
    toast.success('已匯入 JSON 至草稿', `共 ${s.draft.segments.length} 個網段，確認無誤後請按「儲存設定」`);
  } catch (e) {
    toast.fromError(e, '無法讀取 JSON 檔案');
  }
}

// ---------- 離開頁面確認 ----------
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (s.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
}

onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

if (getCurrentInstance()?.appContext.config.globalProperties.$route) {
  onBeforeRouteLeave(async () => {
    if (!s.dirty) return true;
    return await confirm({
      title: '尚有未儲存的網段設定變更',
      message: '離開此頁面將會遺失目前的草稿修改，確定要離開嗎？',
      confirmText: '離開頁面',
      tone: 'danger',
    });
  });
}
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <!-- 頂部工具列與狀態 -->
    <GCard padding="sm">
      <div class="toolbar">
        <div class="meta-bar">
          <template v-if="s.meta">
            <GBadge v-if="s.meta.source === 'file'" tone="success">正式設定 · v{{ s.meta.version }}</GBadge>
            <GBadge v-else-if="s.meta.source === 'example'" tone="info">範例網段 · 尚未儲存正式設定</GBadge>
            <GBadge v-else tone="warning">設定檔格式錯誤 · 暫用範例</GBadge>
            <span v-if="s.meta.updatedAt" class="small muted">
              最後修改：{{ fmtTime(s.meta.updatedAt) }}{{ s.meta.updatedBy ? ` (${s.meta.updatedBy})` : '' }}
            </span>
          </template>
          <span v-else-if="s.loading" class="small muted">載入中…</span>
          <GBadge v-if="s.dirty" tone="warning">未儲存變更</GBadge>
          <GBadge v-if="s.issues.length && showAllErrors" tone="danger">{{ s.issues.length }} 項欄位錯誤</GBadge>
        </div>

        <div class="actions">
          <GButton
            v-if="canWrite"
            variant="primary"
            icon="save"
            :loading="s.saving"
            :disabled="!s.canSave"
            @click="onSave"
          >
            儲存設定
          </GButton>
          <GButton
            v-if="canWrite && s.dirty"
            variant="ghost"
            icon="undo"
            :disabled="s.saving"
            @click="onReset"
          >
            放棄變更
          </GButton>
          <GButton
            icon="eye"
            :loading="s.previewing"
            :disabled="s.issues.length > 0 || s.saving"
            @click="onRunPreview"
          >
            流量預覽
          </GButton>
          <GButton
            v-if="canWrite"
            icon="users"
            :disabled="s.saving"
            @click="openCidrModal"
          >
            從 IP 對照表匯入
          </GButton>
          <GButton
            v-if="canWrite"
            icon="upload"
            :disabled="s.saving"
            @click="jsonInput?.click()"
          >
            匯入 JSON
          </GButton>
          <GButton icon="download" @click="onExport">匯出 JSON</GButton>
          <GButton
            variant="ghost"
            icon="refresh"
            :loading="s.loading"
            :disabled="s.saving"
            aria-label="重新載入"
            @click="onReload"
          />
        </div>
        <input
          ref="jsonInput"
          type="file"
          accept=".json,application/json"
          class="sr-only"
          tabindex="-1"
          aria-hidden="true"
          @change="onImportFile"
        />
      </div>
    </GCard>

    <!-- 尚未載入且發生錯誤 -->
    <GEmpty
      v-if="!s.meta && s.error"
      tone="danger"
      icon="alert"
      title="無法載入網段設定"
      :description="describeError(s.error)"
    >
      <GButton icon="refresh" @click="s.load()">重試</GButton>
    </GEmpty>

    <template v-else>
      <!-- 一般錯誤提示 -->
      <GAlert v-if="s.error" tone="danger" title="操作失敗">
        {{ describeError(s.error) }}
      </GAlert>

      <!-- 原設定檔格式錯誤提示 -->
      <GAlert
        v-if="s.meta?.source === 'invalid'"
        tone="warning"
        title="伺服器上的網段設定檔格式有誤，目前已載入範例網段"
      >
        <p class="note">請修正並儲存以覆寫損壞的設定檔。</p>
        <ul v-if="s.meta.fileErrors.length">
          <li v-for="(err, idx) in s.meta.fileErrors" :key="idx">
            <span class="mono">{{ err.field || '(整份設定)' }}</span>：{{ err.message }}
          </li>
        </ul>
      </GAlert>

      <!-- 版本衝突提示(409) -->
      <GAlert
        v-if="s.conflict"
        tone="danger"
        title="版本衝突：網段設定已被其他人修改"
      >
        <p class="note">
          伺服器目前已是版本 {{ s.conflict.currentVersion ?? '最新' }}，您的草稿尚未寫入。您可以選擇「重新載入」放棄目前草稿，或選擇「保留草稿重套」改用最新版本號（下次儲存將覆蓋對方的修改）。
        </p>
        <div class="conflict-actions">
          <GButton size="sm" icon="refresh" @click="onConflictReload">重新載入</GButton>
          <GButton size="sm" variant="danger" icon="check" @click="onConflictRebase">保留草稿重套</GButton>
          <GButton size="sm" variant="ghost" icon="download" @click="onExport">先匯出草稿 JSON</GButton>
        </div>
      </GAlert>

      <!-- 網段重疊提示 -->
      <GAlert
        v-if="s.overlaps.length"
        tone="warning"
        title="偵測到網段 CIDR 重疊（允許儲存，對照時以最精確的前綴優先）"
      >
        <ul class="overlap-list">
          <li v-for="(ov, idx) in s.overlaps" :key="idx">
            <span class="mono">{{ ov.a.id }} ({{ ov.a.cidr }})</span> 與
            <span class="mono">{{ ov.b.id }} ({{ ov.b.cidr }})</span> 重疊
          </li>
        </ul>
      </GAlert>

      <!-- 戰情室儀表滿格值 -->
      <GCard
        title="戰情室儀表滿格值"
        icon="gauge"
        subtitle="設定戰情室中央吞吐量與連線數儀表弧的 100% 滿格基準"
      >
        <div class="grid2">
          <GInput
            v-model.number="s.draft.gauge.throughputMaxBps"
            type="number"
            label="吞吐量滿格值 (bps)"
            :disabled="!canWrite || s.saving"
            :error="fieldError('gauge.throughputMaxBps', true)"
            :hint="`約 ${fmtBps(Number.isFinite(s.draft.gauge.throughputMaxBps) && s.draft.gauge.throughputMaxBps > 0 ? s.draft.gauge.throughputMaxBps : 0)} · 預設 1,000,000,000 (1 Gbps)`"
            @blur.capture="touch('gauge.throughputMaxBps')"
          />
          <GInput
            v-model.number="s.draft.gauge.sessionMax"
            type="number"
            label="連線數滿格值"
            :disabled="!canWrite || s.saving"
            :error="fieldError('gauge.sessionMax', true)"
            :hint="`目前 ${fmtNum(Number.isFinite(s.draft.gauge.sessionMax) ? s.draft.gauge.sessionMax : 0)} · 預設 64,000`"
            @blur.capture="touch('gauge.sessionMax')"
          />
        </div>
      </GCard>

      <!-- 網段清單 -->
      <GCard
        title="內部網段清單"
        icon="gateway"
        :subtitle="`共 ${fmtNum(s.draft.segments.length)} / ${SEGMENT_LIMITS.segments} 個網段 · 可拖曳卡片或使用上下鍵調整戰情室右側節點順序`"
      >
        <template #actions>
          <GButton
            v-if="canWrite"
            variant="primary"
            size="sm"
            icon="plus"
            :disabled="s.saving || s.draft.segments.length >= SEGMENT_LIMITS.segments"
            @click="onAddSegment"
          >
            新增網段
          </GButton>
        </template>

        <GAlert v-if="fieldError('segments', true)" tone="danger" class="mb-3">
          {{ fieldError('segments', true) }}
        </GAlert>

        <GEmpty
          v-if="!s.draft.segments.length"
          compact
          icon="gateway"
          title="尚未設定任何網段"
          :description="canWrite ? '請點擊右上角「新增網段」或「從 IP 對照表匯入」開始設定' : '目前沒有網段資料'"
        />

        <div v-else class="seg-list" role="list" aria-label="網段設定清單">
          <div
            v-for="(seg, i) in s.draft.segments"
            :key="i"
            role="listitem"
            class="seg-item"
            :class="{
              'is-dragging': dragFrom === i,
              'is-drag-over': dragOver === i && dragFrom !== i,
              'has-overlap': s.overlapIdsOf(seg.id).length > 0,
            }"
            :draggable="canWrite && !s.saving"
            @dragstart="onDragStart(i, $event)"
            @dragover.prevent="onDragOver(i)"
            @drop.prevent="onDrop(i)"
            @dragend="onDragEnd"
          >
            <div class="seg-head">
              <div class="seg-title">
                <span class="seg-order num">#{{ i + 1 }}</span>
                <strong class="seg-name">{{ seg.label || '(未命名網段)' }}</strong>
                <span class="mono small muted">{{ seg.id || '(無代碼)' }}</span>
                <GBadge :tone="seg.kind === 'service' ? 'primary' : 'info'">
                  {{ seg.kind === 'service' ? '核心服務' : 'VLAN' }}
                </GBadge>
                <GBadge v-if="s.overlapIdsOf(seg.id).length" tone="warning">
                  與 {{ s.overlapIdsOf(seg.id).join('、') }} 重疊
                </GBadge>
              </div>
              <div v-if="canWrite" class="seg-actions">
                <GButton
                  size="sm"
                  variant="ghost"
                  icon="arrow-up"
                  :disabled="s.saving || i === 0"
                  :aria-label="`上移 ${seg.label || seg.id}`"
                  @click="onMoveSegment(i, i - 1)"
                />
                <GButton
                  size="sm"
                  variant="ghost"
                  icon="arrow-down"
                  :disabled="s.saving || i === s.draft.segments.length - 1"
                  :aria-label="`下移 ${seg.label || seg.id}`"
                  @click="onMoveSegment(i, i + 1)"
                />
                <GButton
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  :disabled="s.saving"
                  :aria-label="`刪除 ${seg.label || seg.id}`"
                  @click="onRemoveSegment(i)"
                />
              </div>
            </div>

            <div class="seg-grid">
              <GInput
                v-model="seg.label"
                label="網段名稱"
                placeholder="例：辦公網段"
                required
                :disabled="!canWrite || s.saving"
                :error="fieldError(`segments[${i}].label`, true)"
                @blur.capture="touch(`segments[${i}].label`)"
                @update:model-value="touch(`segments[${i}].label`)"
              />
              <GInput
                v-model="seg.id"
                label="代碼 (ID)"
                placeholder="例：office"
                required
                :disabled="!canWrite || s.saving"
                :error="fieldError(`segments[${i}].id`, true)"
                hint="小寫英數與 -，不可為 unmatched"
                @blur.capture="touch(`segments[${i}].id`)"
                @update:model-value="touch(`segments[${i}].id`)"
              />
              <GSelect
                v-model="seg.kind"
                label="類型"
                :options="KIND_OPTIONS"
                :disabled="!canWrite || s.saving"
                :error="fieldError(`segments[${i}].kind`, true)"
                @update:model-value="touch(`segments[${i}].kind`)"
              />
              <GSelect
                v-model="seg.icon"
                label="圖示"
                :options="ICON_OPTIONS"
                :disabled="!canWrite || s.saving"
                :error="fieldError(`segments[${i}].icon`, true)"
                @update:model-value="touch(`segments[${i}].icon`)"
              />
            </div>

            <div class="cidrs-section">
              <div class="cidrs-head">
                <span class="small fw-600">CIDR 範圍 ({{ seg.cidrs.length }} / {{ SEGMENT_LIMITS.cidrs }})</span>
                <span class="small faint">支援 IPv4/0–32，失焦時自動正規化為網路位址</span>
                <div class="spacer" />
                <GButton
                  v-if="canWrite"
                  size="sm"
                  variant="ghost"
                  icon="plus"
                  :disabled="s.saving || seg.cidrs.length >= SEGMENT_LIMITS.cidrs"
                  @click="onAddCidr(i)"
                >
                  新增 CIDR
                </GButton>
              </div>

              <p v-if="fieldError(`segments[${i}].cidrs`, true)" class="small c-danger">
                {{ fieldError(`segments[${i}].cidrs`, true) }}
              </p>

              <div class="cidrs-list">
                <div v-for="(_, k) in seg.cidrs" :key="k" class="cidr-row">
                  <GInput
                    v-model="seg.cidrs[k]"
                    placeholder="例：10.10.112.0/22"
                    class="cidr-input"
                    :disabled="!canWrite || s.saving"
                    :error="cidrError(i, k)"
                    @blur.capture="onCidrBlur(i, k)"
                    @update:model-value="touch(`segments[${i}].cidrs[${k}]`)"
                  />
                  <GButton
                    v-if="canWrite && seg.cidrs.length > 1"
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    :disabled="s.saving"
                    :aria-label="`刪除 CIDR ${seg.cidrs[k] || k + 1}`"
                    @click="onRemoveCidr(i, k)"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </GCard>

      <!-- 流量預覽 & 搭配 A(未分類 IP 協助分類) -->
      <GCard
        title="流量預覽（近 5 分鐘）"
        icon="activity"
        subtitle="儲存前依目前草稿試算近 5 分鐘各網段連線數與仍未分類的內部 IP Top 20（不會寫入設定）"
      >
        <template #actions>
          <GBadge v-if="s.previewStale" tone="warning">預覽已過期，請重新預覽</GBadge>
          <GButton
            size="sm"
            variant="primary"
            icon="play"
            :loading="s.previewing"
            :disabled="s.issues.length > 0 || s.saving"
            @click="onRunPreview"
          >
            執行預覽
          </GButton>
        </template>

        <div class="stack" style="--gap: 12px">
          <GAlert v-if="s.previewError" tone="danger">
            {{ describeError(s.previewError) }}
          </GAlert>

          <GAlert v-if="s.previewStale" tone="warning">
            草稿在預覽之後已修改，預覽結果已過期，請點「執行預覽」更新。
          </GAlert>

          <GAlert v-if="s.preview?.partial" tone="danger">
            {{ s.preview.message || '即時資料庫無法連線，預覽資料不完整' }}
          </GAlert>

          <GAlert v-if="s.preview?.sample && !s.preview.sample.complete" tone="warning">
            流量較大，只讀到最近 {{ s.preview.sample.trafficSec }} 秒的 log（共 {{ fmtNum(s.preview.sample.traffic) }} 筆），數字為推估。
          </GAlert>

          <GEmpty
            v-if="!s.preview && !s.previewing"
            compact
            icon="eye"
            title="尚未執行流量預覽"
            description="點擊右上角「執行預覽」或頂部「流量預覽」檢視依目前草稿分類的近 5 分鐘連線數"
          />

          <div v-else-if="s.preview" class="preview-grid">
            <!-- 各網段連線數 -->
            <div class="preview-box">
              <h4 class="sub-head">各網段近 {{ s.preview.minutes }} 分鐘連線數</h4>
              <table class="mini-table">
                <thead>
                  <tr>
                    <th>網段</th>
                    <th>代碼</th>
                    <th class="right">連線數</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="seg in s.preview.segments" :key="seg.id">
                    <td>{{ seg.label }}</td>
                    <td class="mono small muted">{{ seg.id }}</td>
                    <td class="right num">{{ seg.conn !== null ? fmtNum(seg.conn) : '—' }}</td>
                  </tr>
                  <tr class="unmatched-row">
                    <td><strong>未分類內部 IP</strong></td>
                    <td class="mono small muted">unmatched</td>
                    <td class="right num">
                      <strong>{{ s.preview.unmatched.conn !== null ? fmtNum(s.preview.unmatched.conn) : '—' }}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 未分類內部 IP Top 20 (搭配 A) -->
            <div class="preview-box">
              <h4 class="sub-head">
                仍未分類的內部 IP Top 20
                <span v-if="assist.canSeeNames" class="small muted fw-normal">（已附 IP 對照表設備名稱 / 部門）</span>
              </h4>

              <GEmpty
                v-if="!assist.rows.length"
                compact
                title="沒有未分類的內部 IP"
                description="近 5 分鐘內所有內部 IP 皆已歸入設定的網段"
              />

              <table v-else class="mini-table">
                <thead>
                  <tr>
                    <th>IP 位址</th>
                    <th v-if="assist.canSeeNames">設備名稱 / 部門</th>
                    <th class="right">連線數</th>
                    <th v-if="canWrite" class="right">快速分類</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in assist.rows" :key="row.ip">
                    <td class="mono">{{ row.ip }}</td>
                    <td v-if="assist.canSeeNames" class="small">
                      {{ formatAssistLabel(row.label) }}
                    </td>
                    <td class="right num">{{ fmtNum(row.count) }}</td>
                    <td v-if="canWrite" class="right">
                      <div class="assist-actions">
                        <select
                          v-if="s.draft.segments.length"
                          class="mini-select"
                          :value="targetIdxOf(row.ip)"
                          :disabled="s.saving"
                          :aria-label="`${row.ip} 目標網段`"
                          @change="setTargetIdx(row.ip, ($event.target as HTMLSelectElement).value)"
                        >
                          <option v-for="(seg, idx) in s.draft.segments" :key="idx" :value="idx">
                            {{ seg.label || seg.id }}
                          </option>
                        </select>
                        <GButton
                          size="sm"
                          variant="secondary"
                          :disabled="s.saving || !s.draft.segments.length"
                          @click="onAddIpToSegment(row.ip)"
                        >
                          加入某網段
                        </GButton>
                        <GButton
                          size="sm"
                          variant="ghost"
                          :disabled="s.saving || !row.slash24"
                          @click="onCreateSlash24(row.ip)"
                        >
                          依此 IP 建 /24 網段
                        </GButton>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </GCard>
    </template>

    <!-- 搭配 B:從 IP 對照表匯入對話框 -->
    <GModal
      v-model:open="cidrModalOpen"
      title="從 IP 對照表匯入網段"
      subtitle="列出 IP 對照表中的網段列（/8–/31），同名稱的項目會合併成同一個網段；已被現有網段涵蓋者會自動略過"
      icon="users"
      width="780px"
    >
      <div class="stack" style="--gap: 12px">
        <GAlert v-if="cidrImport.error" tone="danger">
          {{ describeError(cidrImport.error) }}
        </GAlert>

        <div v-if="cidrImport.loading" class="stack" style="--gap: 8px">
          <GSkeleton :lines="4" />
        </div>

        <GEmpty
          v-else-if="!cidrImport.candidates.length"
          compact
          title="IP 對照表中沒有網段列"
          description="對照表目前沒有 /8～/31 的 CIDR 項目可匯入"
        />

        <template v-else>
          <div class="import-toolbar">
            <div class="import-kind">
              <span class="small muted">匯入為類型：</span>
              <GSelect v-model="importKind" :options="KIND_OPTIONS" />
            </div>
            <div class="spacer" />
            <GButton size="sm" variant="ghost" :disabled="!selectableCandidates.length" @click="selectAllUncovered">
              全選可匯入 ({{ selectableCandidates.length }})
            </GButton>
            <GButton size="sm" variant="ghost" :disabled="!cidrImport.selected.size" @click="clearCidrSelection">
              清除選取
            </GButton>
          </div>

          <div class="candidates-wrap">
            <table class="mini-table">
              <thead>
                <tr>
                  <th style="width: 42px" />
                  <th>CIDR</th>
                  <th>匯入網段名稱</th>
                  <th>對照表說明</th>
                  <th>狀態</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="c in cidrImport.candidates"
                  :key="c.key"
                  :class="{ 'is-covered': !!c.coveredBy }"
                >
                  <td>
                    <GCheckbox
                      :model-value="cidrImport.selected.has(c.key)"
                      :disabled="!!c.coveredBy"
                      :aria-label="`選取 ${c.cidr}`"
                      @update:model-value="cidrImport.toggle(c.key)"
                    />
                  </td>
                  <td class="mono">{{ c.cidr }}</td>
                  <td><strong>{{ c.label }}</strong></td>
                  <td class="small muted">
                    {{ [c.entry.department, c.entry.device, c.entry.name, c.entry.note].filter(Boolean).join(' · ') || '—' }}
                  </td>
                  <td>
                    <GBadge v-if="c.coveredBy" tone="neutral">已由 {{ c.coveredBy.label }} 涵蓋</GBadge>
                    <GBadge v-else tone="success">可匯入</GBadge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>

      <template #footer>
        <GButton @click="cidrModalOpen = false">取消</GButton>
        <GButton
          variant="primary"
          icon="check"
          :disabled="!cidrImport.selected.size"
          @click="onConfirmCidrImport"
        >
          匯入選取項目 ({{ cidrImport.selected.size }})
        </GButton>
      </template>
    </GModal>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
}
.meta-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.note {
  margin: 0;
}
.conflict-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.overlap-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.mb-3 {
  margin-bottom: 12px;
}
.seg-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.seg-item {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--glass-border-2);
  border-radius: var(--radius-md);
  background: var(--glass-soft);
  transition:
    border-color var(--dur),
    background var(--dur),
    opacity var(--dur);
}
.seg-item.has-overlap {
  border-color: color-mix(in srgb, var(--c-warning) 55%, var(--glass-border-2));
}
.seg-item.is-dragging {
  opacity: 0.55;
}
.seg-item.is-drag-over {
  border-color: var(--c-primary);
  box-shadow: 0 0 0 2px var(--focus-ring);
}
.seg-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}
.seg-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.seg-order {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 22px;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--field);
  font-size: var(--fs-xs);
  font-weight: 700;
  color: var(--text-2);
}
.seg-name {
  font-size: var(--fs-md);
}
.seg-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.seg-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.cidrs-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.cidrs-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.fw-600 {
  font-weight: 600;
}
.fw-normal {
  font-weight: 400;
}
.cidrs-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
}
.cidr-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.cidr-input {
  flex: 1;
}
.preview-grid {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(380px, 1.6fr);
  gap: 16px;
  align-items: start;
}
.preview-box {
  border: 1px solid var(--glass-border-2);
  border-radius: var(--radius-md);
  background: var(--glass-soft);
  padding: 12px 14px;
  overflow-x: auto;
}
.sub-head {
  margin: 0 0 10px;
  font-size: var(--fs-sm);
  font-weight: 650;
  color: var(--text-2);
}
.mini-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-sm);
}
.mini-table th,
.mini-table td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: middle;
}
.mini-table th {
  font-size: var(--fs-xs);
  color: var(--text-3);
  font-weight: 700;
}
.mini-table tbody tr:last-child td {
  border-bottom: 0;
}
.mini-table .right {
  text-align: right;
}
.unmatched-row td {
  border-top: 1px solid var(--glass-border-2);
  color: var(--c-warning);
}
.assist-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
.mini-select {
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--field-border);
  background: var(--field);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-xs);
}
.import-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.import-kind {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.candidates-wrap {
  max-height: 48vh;
  overflow: auto;
  border: 1px solid var(--glass-border-2);
  border-radius: var(--radius-sm);
}
.is-covered {
  opacity: 0.6;
}
.c-danger {
  color: var(--c-danger);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
@media (max-width: 960px) {
  .seg-grid {
    grid-template-columns: 1fr 1fr;
  }
  .preview-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 640px) {
  .grid2,
  .seg-grid {
    grid-template-columns: 1fr;
  }
}
</style>
