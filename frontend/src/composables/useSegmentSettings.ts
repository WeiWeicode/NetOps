/**
 * 網段設定頁的狀態與邏輯(SG-2;docs/SEGMENT-SETTINGS-PLAN.md §2、§4)。畫面(SG-3,Gemini)只用這裡,不直接呼叫 api/segments。
 *
 *   const s = useSegmentSettings();            // 回傳 reactive 物件:模板與程式都直接用 s.loading、s.canSave(不用 .value,也不要解構)
 *   s.draft.segments / s.draft.gauge             // 直接 v-model 編輯
 *   s.addSegment() / removeSegment(i) / moveSegment(from, to) / addCidr(i) / removeCidr(i, k) / normalizeCidrAt(i, k)(CIDR 失焦時呼叫)
 *   s.issues / s.issuesOf('segments[0].cidrs[1]') / s.overlaps / s.overlapIdsOf(id)   // 即時驗證
 *     新增的網段 CIDR 預設空白、立即有錯:畫面請在欄位碰過(touched)後才顯示該欄錯誤
 *   s.dirty / s.canSave / s.save()             // 儲存:成功 true。saving 期間請鎖住編輯(成功後草稿換成伺服器內容)
 *   s.conflict                                  // 409:別人剛改過。草稿保留;出口:s.load()(放棄草稿)或 s.rebase()(保留草稿、改用最新版本再存,會覆蓋對方的修改)
 *   s.runPreview() / s.preview / s.previewStale // 依草稿預覽近 5 分鐘(不儲存);草稿有錯回 false 不送出(按鈕請依 s.issues.length 停用)
 *   s.exportFile() / s.importText(text)         // JSON 匯出 / 匯入(同 warroom.json 格式;匯入只改草稿)
 *   load() 不檢查 dirty:頁面離開 / 重新載入前請自行確認
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
/** 固定欄位順序(來源不同、key 順序不同的同內容不算修改) */
const snapshot = (c: SegmentConfig) =>
  JSON.stringify([c.gauge.throughputMaxBps, c.gauge.sessionMax, c.segments.map((x) => [x.id, x.label, x.kind, x.icon, x.cidrs])]);

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
  /** 最後一次載入 / 儲存的內容(reset 用) */
  let baseCfg: SegmentConfig = clone(draft);
  /** 後端 400 回的欄位錯誤(下一次編輯前顯示) */
  const serverIssues = ref<FieldError[]>([]);
  /** 版本衝突:別人已改成 currentVersion;畫面提示「重新載入(放棄草稿)」或「匯出草稿後重新載入」 */
  const conflict = ref<{ currentVersion: number | null } | null>(null);
  const preview = shallowRef<SegmentPreview | null>(null);
  const previewing = ref(false);
  const previewError = ref<Error | null>(null);
  let previewSeq = 0;
  /** 預覽當時的草稿 */
  const previewOf = ref<string | null>(null);

  function apply(s: SegmentSettings) {
    meta.value = { version: s.version, source: s.source, updatedAt: s.updatedAt, updatedBy: s.updatedBy, fileErrors: s.errors ?? [] };
    const c = clone(s);
    draft.gauge = c.gauge;
    draft.segments = c.segments;
    base.value = snapshot(draft);
    baseCfg = clone(s);
    serverIssues.value = [];
    conflict.value = null;
    clearPreview();
  }
  function clearPreview() {
    previewSeq++;
    preview.value = null;
    previewOf.value = null;
    previewing.value = false;
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

  /** 草稿在預覽之後改過(畫面提示「預覽已過期,請重新預覽」) */
  const previewStale = computed(() => !!preview.value && previewOf.value !== snapshot(draft));

  /** 版本衝突後保留草稿:改用伺服器最新版本號(下一次儲存會覆蓋對方的修改,畫面要先確認) */
  async function rebase(): Promise<boolean> {
    if (!conflict.value) return false;
    try {
      const s = await backend.get();
      meta.value = { version: s.version, source: s.source, updatedAt: s.updatedAt, updatedBy: s.updatedBy, fileErrors: s.errors ?? [] };
      base.value = snapshot(clone(s));
      baseCfg = clone(s);
      conflict.value = null;
      return true;
    } catch (e) {
      error.value = e as Error;
      return false;
    }
  }

  /** 依目前草稿預覽;草稿有錯時回 false 不送出;較晚送出的結果才會留下 */
  async function runPreview(): Promise<boolean> {
    if (issues.value.length) return false;
    const my = ++previewSeq;
    const snap = snapshot(draft);
    previewing.value = true;
    previewError.value = null;
    try {
      const r = await backend.preview(clone(draft));
      if (my === previewSeq) {
        preview.value = r;
        previewOf.value = snap;
      }
    } catch (e) {
      if (my === previewSeq) previewError.value = e as Error;
    } finally {
      if (my === previewSeq) previewing.value = false;
    }
    return true;
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
    const c = clone(baseCfg);
    draft.gauge = c.gauge;
    draft.segments = c.segments;
    serverIssues.value = [];
    conflict.value = null;
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
    clearPreview();
    return null;
  }

  if (options.immediate !== false) onMounted(load);

  // reactive:ref / computed 在模板與程式中都自動解包(頁面寫 s.canSave,不用 .value)
  return reactive({
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
    previewStale,
    load,
    save,
    rebase,
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
  });
}

export type SegmentSettingsState = ReturnType<typeof useSegmentSettings>;
