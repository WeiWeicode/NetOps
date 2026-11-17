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
export type SegmentKind = 'vlan' | 'service';

/** 外部來源節點;conn / deny / threat 是 minutes 分鐘內的筆數 */
export interface WarroomSource {
  id: string;
  kind: SourceKind;
  label: string;
  conn: number;
  deny: number;
  threat: number;
  topDst: string[];
  topApp: string[];
}

/** 內部網段節點;conn 是 minutes 分鐘內的筆數,bytes 為位元組 */
export interface WarroomSegment {
  id: string;
  kind: SegmentKind;
  label: string;
  /** 圖示名稱(網通設定檔提供,例:pc、factory、gear、server、mail、key、lock、wifi) */
  icon: string;
  conn: number;
  bytes: number;
  threat: number;
}

/** 來源 → 防火牆 → 網段;數值都是「每秒」 */
export interface WarroomLink {
  source: string;
  segment: string;
  conn: number;
  allow: number;
  deny: number;
  threat: number;
}

export interface Warroom {
  generatedAt: string;
  minutes: number;
  /** Redis 部分統計讀不到(資料不完整,不是假資料) */
  partial: boolean;
  sources: WarroomSource[];
  segments: WarroomSegment[];
  links: WarroomLink[];
  kpis: { denyPerMin: number; threat5m: number };
}

export interface WarroomRisk {
  threats: number;
  denies: number;
  attackSources: number;
  critical: number;
  topThreats: { name: string; severity: string; count: number }[];
  topSources: { key: string; label: string; count: number; denyRatio: number }[];
  partial: boolean;
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
  get: (minutes = 5) => http.get<Warroom>('/api/netops/pa-live/warroom', { query: { minutes } }),
  risk: (minutes = 60) => http.get<WarroomRisk>('/api/netops/pa-live/risk', { query: { minutes } }),
  insight: () => http.get<HourlyInsight>('/api/netops/ai/hourly-insight'),
  /** 手動執行:SSE 逐字回傳(content {text}、done);開始前的 409(執行中)/ 429(冷卻)丟 ApiError */
  runInsight: (onEvent: (e: SseEvent) => void, signal?: AbortSignal) => streamPost('/api/netops/ai/hourly-insight/run', {}, onEvent, signal),
};
