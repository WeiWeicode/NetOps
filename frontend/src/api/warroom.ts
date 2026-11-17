/**
 * PA 即時監控戰情室(docs/WARROOM-PLAN.md §3 WR-1~WR-3),讀取需要 netops.pa-realtime.read。
 *   WR-1 GET /api/netops/pa-live/warroom:來源(國家 / 攻擊 IP / 其他)、內部網段、連線的每秒速率、阻擋/分、威脅/5 分
 *   WR-2 GET /api/netops/pa-live/risk:近一小時高風險統計
 *   WR-3 GET /api/netops/ai/hourly-insight(只有最新一筆)、POST .../run(手動執行,SSE 逐字回傳;netops.ai.use,按鈕 netops.pa-live.ai)
 * 形狀依計畫 §3 先行;後端完成後若有出入在這裡對齊,畫面只用 composables/useWarroom.ts、useWarroomAi.ts。
 */
import { streamPost, type SseEvent } from './ai';
import { http } from './gateway';

export type SourceKind = 'country' | 'ip' | 'other';
export type SegmentKind = 'vlan' | 'service' | 'other';

/** 保留 id:內部互連來源、對不到網段的內部 IP */
export const LAN_SOURCE = 'lan';
export const OTHER_SOURCE = 'other';
export const UNMATCHED_SEGMENT = 'unmatched';

export interface TopItem {
  key: string;
  count: number;
}

/**
 * 外部來源節點;conn / deny / threat 是 minutes 分鐘內的筆數。
 * id:`cc:<國家代碼>` / `ip:<IP>`(Top 攻擊 IP,只計連入)/ `other`(其他與未知國家)/ `lan`(內部互連,kind other)
 */
export interface WarroomSource {
  id: string;
  kind: SourceKind;
  label: string;
  /** 國家代碼(kind country);ip 為所屬國家;other / lan 為 null */
  country: string | null;
  conn: number;
  deny: number;
  threat: number;
  topDst: TopItem[];
  topApp: TopItem[];
}

/** 內部網段節點;conn 是 minutes 分鐘內的筆數,bytes 為位元組;對不到的內部 IP 為 id unmatched、kind other */
export interface WarroomSegment {
  id: string;
  kind: SegmentKind;
  label: string;
  /** 圖示名稱(網段設定檔提供,例:office、server、factory、wifi、globe;unmatched 為 network) */
  icon: string;
  conn: number;
  bytes: number;
  threat: number;
}

/** 來源 → 防火牆 → 網段;數值都是「每秒」(3 位小數) */
export interface WarroomLink {
  source: string;
  segment: string;
  conn: number;
  allow: number;
  deny: number;
  threat: number;
}

/**
 * 網段設定來源:file = 網通提供的設定檔;example = 設定檔不存在,用內建範例(畫面要標「範例網段」);
 * invalid = 設定檔格式錯誤,改用範例(畫面要提示)
 */
export type SegmentsSource = 'file' | 'example' | 'invalid';

/** 讀取樣本:complete false = 讀到上限仍沒涵蓋整段期間,數字是依已涵蓋秒數推估 */
export interface WarroomSample {
  traffic: number;
  trafficSec: number;
  threat: number;
  threatSec: number;
  complete: boolean;
}

export interface Warroom {
  generatedAt: string;
  minutes: number;
  /** Redis 不可用(陣列空、kpis 值 null、message 說明);不是假資料 */
  partial: boolean;
  message?: string;
  segmentsSource: SegmentsSource;
  /** 儀表滿格值(Q5,設定值;預設 1 Gbps / 64K) */
  gauge: { throughputMaxBps: number; sessionMax: number };
  /** 離線 GeoIP;attribution 必須顯示在畫面(DB-IP Lite 授權) */
  geo: { available: boolean; version: string | null; attribution: { text: string; url: string } };
  sources: WarroomSource[];
  segments: WarroomSegment[];
  links: WarroomLink[];
  kpis: { denyPerMin: number | null; threat5m: number | null };
  sample: WarroomSample | null;
  /** IP 名稱對照(absorbNames 用) */
  names?: Record<string, string>;
}

export interface WarroomRisk {
  generatedAt: string;
  minutes: number;
  partial: boolean;
  message?: string;
  /** partial 時為 null */
  threats: number | null;
  denies: number | null;
  attackSources: number | null;
  /** partial 時沒有這個欄位;true = attackSources 是下限(樣本不完整,實際可能更多;畫面顯示「≥」) */
  attackSourcesLowerBound?: boolean;
  critical: number | null;
  topThreats: { name: string; severity: string | null; count: number }[];
  topSources: { key: string; label: string; country: string | null; count: number; denyRatio: number | null }[];
  /** partial 時沒有這個欄位 */
  sample?: { threat: number; complete: boolean } | null;
  names?: Record<string, string>;
}

export type HourlyInsightStatus = 'none' | 'running' | 'done' | 'failed';

/** 最新一筆每小時分析(Q4:不留歷史) */
export interface HourlyInsight {
  /** 分析的整點(ISO);還沒有任何分析時為 null */
  hour: string | null;
  text: string;
  model: string;
  trigger: 'auto' | 'manual';
  partial: boolean;
  status: HourlyInsightStatus;
  /** 後端若回傳下次可手動執行的時間(冷卻),畫面以此為準;沒有時前端自行計算 */
  cooldownUntil?: string | null;
  /** 產生時間 */
  createdAt?: string | null;
}

export const warroom = {
  /** minutes:1 / 5 / 15 */
  get: (minutes: 1 | 5 | 15 = 5) => http.get<Warroom>('/api/netops/pa-live/warroom', { query: { minutes } }),
  /** minutes:15 / 60 */
  risk: (minutes: 15 | 60 = 60) => http.get<WarroomRisk>('/api/netops/pa-live/risk', { query: { minutes } }),
  insight: () => http.get<HourlyInsight>('/api/netops/ai/hourly-insight'),
  /** 手動執行:SSE 逐字回傳(content {text}、done);開始前的 409(執行中)/ 429(冷卻)丟 ApiError */
  runInsight: (onEvent: (e: SseEvent) => void, signal?: AbortSignal) => streamPost('/api/netops/ai/hourly-insight/run', {}, onEvent, signal),
};
