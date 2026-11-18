/**
 * 網段設定頁的狀態與邏輯(SG-2;docs/SEGMENT-SETTINGS-PLAN.md §2、§4)。畫面(SG-3,Gemini)只用這裡,不直接呼叫 api/segments。
 *
 *   const s = useSegmentSettings();            // 掛載時自動 load()
 *   s.draft.segments / s.draft.gauge             // 直接 v-model 編輯(reactive)
 *   s.addSegment() / removeSegment(i) / moveSegment(from, to) / addCidr(i) / removeCidr(i, k)
 *   s.issues / s.issuesOf('segments[0].cidrs[1]') / s.overlaps / s.overlapIdsOf(id)   // 即時驗證
 *   s.dirty / s.canSave / s.save()             // 儲存:成功 true;版本衝突時 conflict 有值、草稿保留
 *   s.runPreview() / s.preview / s.previewing   // 依草稿預覽近 5 分鐘(不儲存)
 *   s.exportFile() / s.importText(text)         // JSON 匯出 / 匯入(同 warroom.json 格式;匯入只改草稿)
 *
 * mock 模式(開發建置 ?mock=1 或 options.mock):用記憶體假後端(segmentsMock),可模擬版本衝突。
 */
import { computed, onMounted, reactive, ref, shallowRef } from 'vue';
import { ApiError } from '@/api/gateway';
import { segmentsApi, SEGMENTS_VERSION_CONFLICT, SEGMENT_LIMITS, type FieldError, type SegmentConfig, type SegmentDef, type SegmentPreview, type SegmentSettings, type SegmentsSource } from '@/api/segments';
import { DEFAULT_GAUGE, exportJson, findOverlaps, normalizeCidr, parseImport, suggestId, validateConfig } from './segmentRules';
import { createSegmentsMock } from './segmentsMock';
import { resolveMock } from './warroomMock';

export type SegmentsBackend = typeof segmentsApi;

export interface UseSegmentSettingsOptions {
  /** 強制開關 mock;沒給時依 warroomMockEnabled()(正式建置一律關閉) */
  mock?: boolean;
  /** 測試注入 */
  backend?: SegmentsBackend;
  /** 預設 true:掛載時載入 */
  immediate?: boolean;
}

const clone = (c: SegmentConfig): SegmentConfig => ({ gauge: { ...c.gauge }, segments: c.segments.map((s) => ({ ...s, cidrs: [...s.cidrs] })) });
const snapshot = (c: SegmentConfig) => JSON.stringify({ gauge: c.gauge, segments: c.segments });

export function useSegmentSettings(options: UseSegmentSettingsOptions = {}) {
  const backend: SegmentsBackend = options.backend ?? (resolveMock(options.mock) ? createSegmentsMock() : segmentsApi);

  const loading = ref(false);
  const saving = ref(false);
  /** 載入 / 儲存失敗(非驗證、非衝突);畫面用 GEmpty / toast 顯示 */
  const error = ref<Error | null>(null);
  /** 伺服器端資訊(最後一次載入 / 儲存) */
  const meta = ref<{ version: number; source: SegmentsSource; updatedAt: string | null; updatedBy: string | null; fileErrors: FieldError[] } | null>(null);
  const draft = reactive<SegmentConfig>({ gauge: { ...DEFAULT_GAUGE }, segments: [] });
  const base = ref(snapshot(draft));
  /** 後端 400 回的欄位錯誤(下一次編輯前顯示) */
  const serverIssues = ref<FieldError[]>([]);
  /** 版本衝突:別人已改成 currentVersion;畫面提示「重新載入(放棄草稿)」或「匯出草稿後重新載入」 */
  const conflict = ref<{ currentVersion: number | null } | null>(null);
  const preview = shallowRef<SegmentPreview | null>(null);
  const previewing = ref(false);
  const previewError = ref<Error | null>(null);
  let previewSeq = 0;

  function apply(s: SegmentSettings) {
    meta.value = { version: s.version, source: s.source, updatedAt: s.updatedAt, updatedBy: s.updatedBy, fileErrors: s.errors ?? [] };
    const c = clone(s);
    draft.gauge = c.gauge;
    draft.segments = c.segments;
    base.value = snapshot(draft);
    serverIssues.value = [];
    conflict.value = null;
    preview.value = null;
  }

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      apply(await backend.get());
    } catch (e) {
      error.value = e as Error;
    } finally {
      loading.value = false;
    }
  }

  const dirty = computed(() => snapshot(draft) !== base.value);
  const issues = computed<FieldError[]>(() => validateConfig(draft));
  const overlaps = computed(() => findOverlaps(draft.segments));
  const canSave = computed(() => !!meta.value && dirty.value && !issues.value.length && !saving.value && !conflict.value);

  /** 某欄位(或其下層)的錯誤;前端驗證優先,沒有時顯示後端回的 */
  const issuesOf = (field: string): FieldError[] => {
    const hit = (e: FieldError) => e.field === field || e.field.startsWith(`${field}.`) || e.field.startsWith(`${field}[`);
    const local = issues.value.filter(hit);
    return local.length ? local : serverIssues.value.filter(hit);
  };
  /** 與某網段重疊的其他網段 id */
  const overlapIdsOf = (id: string): string[] => [...new Set(overlaps.value.flatMap((o) => (o.a.id === id ? [o.b.id] : o.b.id === id ? [o.a.id] : [])))];

  async function save(): Promise<boolean> {
    if (!meta.value || issues.value.length || saving.value) return false;
    saving.value = true;
    error.value = null;
    try {
      apply(await backend.save(meta.value.version, clone(draft)));
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === SEGMENTS_VERSION_CONFLICT) {
        const v = (e.details as { currentVersion?: unknown } | undefined)?.currentVersion;
        conflict.value = { currentVersion: typeof v === 'number' ? v : null };
      } else if (e instanceof ApiError && e.status === 400 && Array.isArray(e.details)) {
        serverIssues.value = e.details as FieldError[];
      } else error.value = e as Error;
      return false;
    } finally {
      saving.value = false;
    }
  }

  /** 依目前草稿預覽(草稿有錯時不送出);較晚送出的結果才會留下 */
  async function runPreview(): Promise<void> {
    if (issues.value.length) return;
    const my = ++previewSeq;
    previewing.value = true;
    previewError.value = null;
    try {
      const r = await backend.preview(clone(draft));
      if (my === previewSeq) preview.value = r;
    } catch (e) {
      if (my === previewSeq) previewError.value = e as Error;
    } finally {
      if (my === previewSeq) previewing.value = false;
    }
  }

  // ---------- 編輯 ----------
  function addSegment(init: Partial<SegmentDef> = {}): number {
    if (draft.segments.length >= SEGMENT_LIMITS.segments) return -1;
    const label = init.label ?? '新網段';
    const kind = init.kind ?? 'vlan';
    draft.segments.push({
      id: init.id ?? suggestId(label, draft.segments.map((s) => s.id)),
      label,
      kind,
      icon: init.icon ?? (kind === 'service' ? 'server' : 'network'),
      cidrs: init.cidrs ? [...init.cidrs] : [''],
    });
    return draft.segments.length - 1;
  }
  const removeSegment = (i: number) => void draft.segments.splice(i, 1);
  /** 拖曳排序:把 from 移到 to */
  function moveSegment(from: number, to: number) {
    const n = draft.segments.length;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
    const [s] = draft.segments.splice(from, 1);
    draft.segments.splice(to, 0, s!);
  }
  function addCidr(i: number, cidr = '') {
    const s = draft.segments[i];
    if (s && s.cidrs.length < SEGMENT_LIMITS.cidrs) s.cidrs.push(cidr);
  }
  function removeCidr(i: number, k: number) {
    draft.segments[i]?.cidrs.splice(k, 1);
  }
  /** 失焦時正規化(10.1.2.3/24 → 10.1.2.0/24);不合法的保留原字串讓驗證標出 */
  function normalizeCidrAt(i: number, k: number) {
    const s = draft.segments[i];
    const n = s ? normalizeCidr(s.cidrs[k] ?? '') : null;
    if (s && n) s.cidrs[k] = n;
  }
  /** 放棄草稿,回到最後一次載入 / 儲存的內容 */
  function reset() {
    const c = JSON.parse(base.value) as SegmentConfig;
    draft.gauge = c.gauge;
    draft.segments = c.segments;
    serverIssues.value = [];
  }

  // ---------- 匯入 / 匯出 ----------
  /** 匯出目前草稿;回傳檔名與內容,畫面用 Blob 下載 */
  function exportFile(): { fileName: string; content: string; mime: string } {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return { fileName: `網段設定_${stamp}.json`, content: exportJson(draft), mime: 'application/json' };
  }
  /** 匯入 JSON 取代草稿(還沒儲存);格式錯誤回訊息,欄位錯誤由 issues 標出 */
  function importText(text: string): string | null {
    const r = parseImport(text);
    if ('error' in r) return r.error;
    draft.gauge = r.cfg.gauge;
    draft.segments = r.cfg.segments;
    serverIssues.value = [];
    preview.value = null;
    return null;
  }

  if (options.immediate !== false) onMounted(load);

  return {
    loading,
    saving,
    error,
    meta,
    draft,
    dirty,
    issues,
    issuesOf,
    overlaps,
    overlapIdsOf,
    canSave,
    conflict,
    preview,
    previewing,
    previewError,
    load,
    save,
    runPreview,
    addSegment,
    removeSegment,
    moveSegment,
    addCidr,
    removeCidr,
    normalizeCidrAt,
    reset,
    exportFile,
    importText,
  };
}

export type SegmentSettingsState = ReturnType<typeof useSegmentSettings>;
