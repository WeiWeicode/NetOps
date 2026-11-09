/**
 * PA 即時監控(R1,docs/API.md §3.2),需要 netops.pa-realtime.read。
 * 資料由收集器 netops-pa 寫入 Redis;保留 TRAFFIC 明細 1 小時、統計 1 天,其他類型 2 天(更早的到「Log 明細查詢」)。
 * 串流 GET /api/netops/pa-live/stream 用瀏覽器 EventSource(同網域,Cookie 自動帶;前端不接觸 Token)。
 */
import { http, withQuery } from './gateway';

export const LOG_TYPES = [
  { value: 'traffic', label: 'TRAFFIC' },
  { value: 'threat', label: '威脅' },
  { value: 'url', label: 'URL 過濾' },
  { value: 'data', label: '資料過濾' },
  { value: 'wildfire', label: 'WildFire' },
  { value: 'decryption', label: '解密' },
  { value: 'globalprotect', label: 'GlobalProtect' },
  { value: 'userid', label: 'User-ID' },
] as const;
export type LogType = (typeof LOG_TYPES)[number]['value'];

export type CollectorState = 'ok' | 'degraded' | 'disabled' | 'paused' | 'stopped' | 'not-running' | 'unavailable';

export interface CollectorStatus {
  state: CollectorState;
  message: string;
  updatedAt: string | null;
  version: string | null;
  /** enabled = 主機設定的總開關;paused = 測試區手動開關的實際狀態(收集器回報) */
  poll: { enabled: boolean; paused: boolean; lastOkAt: string | null; error: string | null; errorAt: string | null };
  receive: { enabled: boolean; paused: boolean; tls: boolean; httpLastAt: string | null; syslogLastAt: string | null };
  redis: { error: string | null; errorAt: string | null };
  counters: Record<'received' | 'dropped' | 'rejected' | 'malformed' | 'redisFailed' | 'paused', number>;
}

/** 測試區手動開關(要求的狀態);available = 這個部署區可以切換(正式區 false) */
export interface CollectorControl {
  available: boolean;
  pollPaused: boolean;
  receivePaused: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SessionSnap {
  time: string;
  active: number | null;
  max: number | null;
  utilization: number | null;
  tcp: number | null;
  udp: number | null;
  icmp: number | null;
}
export interface CpuSnap {
  time: string;
  mgmt: number | null;
  dataplane: number | null;
  memUsed: number | null;
  memTotal: number | null;
}
export interface ThroughputSnap {
  time: string;
  bps: number | null;
  pps: number | null;
  cps: number | null;
}
export interface InterfacesSnap {
  time: string;
  items: { name: string; rxBps: number | null; txBps: number | null }[];
}

export interface PaLiveSnapshot {
  collector: CollectorStatus;
  /** 60 秒沒更新、收集器停止或 Redis 連不上時為 null(不顯示舊資料) */
  metrics: { session: SessionSnap | null; cpu: CpuSnap | null; throughput: ThroughputSnap | null; interfaces: InterfacesSnap | null };
  /** 舊版後端沒有這個欄位 */
  control?: CollectorControl;
}

export interface PaLiveTop {
  type: LogType;
  minutes: number;
  totals: Record<string, number>;
  kpis: Record<string, Record<string, number>>;
  tops: Record<string, { key: string; value: number }[]>;
  perMinute: { minute: string; count: number }[];
  retentionSec: number;
}

export interface LiveLog {
  id: string;
  type: LogType;
  receivedAt: string;
  [field: string]: unknown;
}

export interface LiveLogs {
  type: LogType;
  items: LiveLog[];
  nextBefore: string | null;
  scanned: number;
  truncated: boolean;
  earliest: string | null;
  retentionSec: number;
}

export interface LogFilter {
  ip?: string;
  port?: number;
  action?: string;
}

export const paLive = {
  snapshot: () => http.get<PaLiveSnapshot>('/api/netops/pa-live/snapshot'),
  series: (metric: 'session' | 'cpu' | 'throughput' | 'interfaces', minutes = 60) =>
    http.get<{ metric: string; minutes: number; points: Record<string, unknown>[] }>('/api/netops/pa-live/series', { query: { metric, minutes } }),
  top: (type: LogType, minutes: 5 | 15 | 60, limit = 10, dims?: string[]) =>
    http.get<PaLiveTop>('/api/netops/pa-live/top', { query: { type, minutes, limit, dims: dims?.join(',') } }),
  logs: (type: LogType, filter: LogFilter = {}, limit = 100, before?: string) =>
    http.get<LiveLogs>('/api/netops/pa-live/logs', { query: { type, limit, before, ...filter } }),
  /** 測試區暫停 / 繼續收集器(netops.pa-realtime.write;正式區 403 NETOPS_PA_CONTROL_DISABLED) */
  setControl: (change: { pollPaused?: boolean; receivePaused?: boolean }) => http.put<CollectorControl>('/api/netops/pa-live/collector-control', change),
  /**
   * 串流連不上時查原因:EventSource 不提供 HTTP 狀態,改用 fetch 取得狀態碼後立即中斷(429 名額滿、404 路由未發佈、401 登入逾時)。
   * 回 { status, code };網路錯誤 status 為 0。
   */
  async probeStream(url: string): Promise<{ status: number; code: string | null }> {
    const ctl = new AbortController();
    // 卡住(網路半斷、Gateway 不回)時 10 秒放棄,當成網路錯誤(status 0),重試計時器照常設定
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/event-stream' }, signal: ctl.signal });
      let code: string | null = null;
      if (!res.ok) {
        try {
          code = ((await res.json()) as { code?: string }).code ?? null;
        } catch {
          // 非 JSON
        }
      }
      return { status: res.status, code };
    } catch {
      return { status: 0, code: null };
    } finally {
      clearTimeout(timer);
      // 200 時不讀串流,立即釋放名額
      ctl.abort();
    }
  },
  /** SSE 網址(EventSource 用;同網域相對路徑,不寫死 / 開頭以外的主機) */
  streamUrl: (types: LogType[], filter: LogFilter = {}) => withQuery('/api/netops/pa-live/stream', { types: types.join(','), ...filter }),
};
