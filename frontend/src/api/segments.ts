/**
 * 網段設定(SG-2;docs/SEGMENT-SETTINGS-PLAN.md §4,後端 SG-1)。
 *   讀取 / 預覽 netops.segment.read,儲存 netops.segment.write(畫面節點 netops.segment-page.read / .write,只給網管)。
 *   內容只有網段名稱與 CIDR,不含個資。頁面不直接呼叫,一律經 composables/useSegmentSettings.ts。
 */
import { http } from './gateway';

export type SegmentKind = 'vlan' | 'service';
export type SegmentsSource = 'file' | 'example' | 'invalid';

export interface SegmentDef {
  id: string;
  label: string;
  kind: SegmentKind;
  icon: string;
  cidrs: string[];
}
export interface SegmentGauge {
  throughputMaxBps: number;
  sessionMax: number;
}
/** 設定本體(與 warroom.json 同格式;匯入 / 匯出也用這個) */
export interface SegmentConfig {
  gauge: SegmentGauge;
  segments: SegmentDef[];
}
export interface SegmentOverlap {
  a: { id: string; cidr: string };
  b: { id: string; cidr: string };
}
export interface FieldError {
  /** 欄位路徑,例如 segments[2].cidrs[0];整份錯誤為空字串 */
  field: string;
  message: string;
}
export interface SegmentSettings extends SegmentConfig {
  version: number;
  source: SegmentsSource;
  updatedAt: string | null;
  updatedBy: string | null;
  overlaps: SegmentOverlap[];
  /** source invalid 時:設定檔哪裡壞了(gauge / segments 已改回範例) */
  errors?: FieldError[];
}
export interface SegmentPreview {
  generatedAt: string;
  minutes: number;
  /** true:Redis 不可用,conn 為 null、看 message */
  partial: boolean;
  message?: string;
  segments: { id: string; label: string; conn: number | null }[];
  unmatched: { conn: number | null; top: { ip: string; count: number }[] };
  overlaps: SegmentOverlap[];
  sample: { traffic: number; trafficSec: number; complete: boolean } | null;
}

/** 版本衝突的錯誤代碼(409) */
export const SEGMENTS_VERSION_CONFLICT = 'NETOPS_SEGMENTS_VERSION_CONFLICT';
/** 後端上限(warroom.ts checkWarroomConfig) */
export const SEGMENT_LIMITS = { segments: 100, cidrs: 50, label: 40, id: 40 } as const;

export const segmentsApi = {
  get: () => http.get<SegmentSettings>('/api/netops/warroom-segments'),
  save: (version: number, cfg: SegmentConfig) => http.put<SegmentSettings>('/api/netops/warroom-segments', { version, ...cfg }),
  preview: (cfg: SegmentConfig) => http.post<SegmentPreview>('/api/netops/warroom-segment-previews', cfg),
};
