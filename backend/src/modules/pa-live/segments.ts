/**
 * 網段設定(SG-1,docs/SEGMENT-SETTINGS-PLAN.md §2、§4):戰情室右側內部網段改由畫面維護。不依賴 Fastify。
 *   - 儲存沿用 infra/store 的 warroom/warroom.json(格式同 parseWarroomConfig,另加 version、updatedAt、updatedBy);不進資料庫(D20)
 *   - 整份寫入、帶 version;版本不符(別人剛改過)回 409 NETOPS_SEGMENTS_VERSION_CONFLICT
 *   - 寫入前舊檔存進歷史(store.saveConfig,保留 20 份,§7 Q7);寫入後戰情室下一次請求就套用
 *   - 預覽用未儲存的設定算近 5 分鐘各網段連線數與未分類內部 IP Top 20(只讀 Redis)
 * 單一容器(AGENT.md §7.3):版本比對與寫入都是同步呼叫,同一程序內不會交錯。
 */
import { AppError } from '../../errors.js';
import type { WarroomStore } from '../../infra/store/index.js';
import { checkWarroomConfig, EXAMPLE_CONFIG, findOverlaps, type ConfigError, type WarroomConfig, type WarroomService } from './warroom.js';

export type SegmentsSource = 'file' | 'example' | 'invalid';

export interface SegmentSettings extends WarroomConfig {
  version: number;
  source: SegmentsSource;
  updatedAt: string | null;
  updatedBy: string | null;
  overlaps: ReturnType<typeof findOverlaps>;
  /** source invalid 時的錯誤(設定檔被人工改壞);gauge / segments 改回範例 */
  errors?: ConfigError[];
}

const versionOf = (raw: unknown): number => {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).version : undefined;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
};
const strOf = (raw: unknown, k: string): string | null => {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[k] : undefined;
  return typeof v === 'string' ? v.slice(0, 100) : null;
};

export type SegmentSettingsService = ReturnType<typeof createSegmentSettingsService>;

export function createSegmentSettingsService(deps: { store: WarroomStore; warroom: Pick<WarroomService, 'invalidateConfig' | 'previewConfig'>; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const invalid = (errors: ConfigError[]) => new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', errors);

  function get(): SegmentSettings {
    let raw: unknown;
    try {
      raw = deps.store.readConfig();
    } catch {
      // 檔案損壞(不是 JSON):標示 invalid,仍可由畫面整份覆寫(version 視為 0)
      return { ...EXAMPLE_CONFIG, version: 0, source: 'invalid', updatedAt: null, updatedBy: null, overlaps: findOverlaps(EXAMPLE_CONFIG.segments), errors: [{ field: '', message: '設定檔不是合法的 JSON' }] };
    }
    if (raw === null) return { ...EXAMPLE_CONFIG, version: 0, source: 'example', updatedAt: null, updatedBy: null, overlaps: findOverlaps(EXAMPLE_CONFIG.segments) };
    const r = checkWarroomConfig(raw);
    const meta = { version: versionOf(raw), updatedAt: strOf(raw, 'updatedAt'), updatedBy: strOf(raw, 'updatedBy') };
    if (!r.cfg) return { ...EXAMPLE_CONFIG, ...meta, source: 'invalid', overlaps: findOverlaps(EXAMPLE_CONFIG.segments), errors: r.errors.slice(0, 50) };
    return { ...r.cfg, ...meta, source: 'file', overlaps: findOverlaps(r.cfg.segments) };
  }

  return {
    get,
    /** 整份寫入;body.version 必須等於目前版本 */
    save(body: { version: number } & Record<string, unknown>, author: string): SegmentSettings {
      const cur = get();
      if (body.version !== cur.version) throw new AppError(409, 'NETOPS_SEGMENTS_VERSION_CONFLICT', '網段設定已被其他人修改,請重新載入後再編輯', { currentVersion: cur.version });
      const r = checkWarroomConfig(body);
      if (!r.cfg) throw invalid(r.errors);
      const next = { version: cur.version + 1, updatedAt: new Date(now()).toISOString(), updatedBy: author, gauge: r.cfg.gauge, segments: r.cfg.segments };
      deps.store.saveConfig(next, cur.version, new Date(now()));
      deps.warroom.invalidateConfig();
      return { ...next, source: 'file', overlaps: findOverlaps(next.segments) };
    },
    /** 用未儲存的設定預覽(不寫入) */
    async preview(body: Record<string, unknown>) {
      const r = checkWarroomConfig(body);
      if (!r.cfg) throw invalid(r.errors);
      return { ...(await deps.warroom.previewConfig(r.cfg)), overlaps: findOverlaps(r.cfg.segments) };
    },
  };
}
