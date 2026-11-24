/**
 * DC Agent 即時狀態(AD-3;GET /v1/ad/agents,docs/AD-AGENT-PLAN.md §6.1、AD3)。
 * 心跳是 DC 送來的 JSON:只取白名單欄位、檢查型別、截斷字串後回給畫面(不整包轉出;Token 對應表與接收端設定不經這裡)。
 * state:ok = 心跳在 staleSec 內;stale = 超過 staleSec(畫面「停止更新」);offline = 超過 offlineSec(離線);unknown = 沒有心跳。
 * 純函式,不依賴 Fastify 與 Redis。
 */
import type { AdHeartbeatRaw } from '../../infra/redis/ad-status.js';

export type AgentState = 'ok' | 'stale' | 'offline' | 'unknown';

export interface AgentChannelStatus {
  lastRecordId: number | null;
  logEpoch: number | null;
  fileSizeMb: number | null;
  maxSizeMb: number | null;
  oldestEventAt: string | null;
  coverageHours: number | null;
  wrapRisk: boolean | null;
}

export interface AgentEvent {
  type: string;
  cause: string;
  detail: string;
  at: string | null;
  receivedAt: string | null;
}

export interface AgentStatus {
  computer: string;
  dcDomain: string;
  state: AgentState;
  /** 後端最後收到心跳的時間(ISO 8601) */
  updatedAt: string | null;
  /** 距今秒數;沒有心跳為 null */
  ageSec: number | null;
  reportedAt: string | null;
  agentVersion: string;
  watchdogVersion: string;
  /** 接收端累計接受的事件數 */
  received: number;
  agent: {
    pid: number | null;
    serviceState: string;
    startType: string;
    statusOk: boolean | null;
    lastCollectTickAt: string | null;
    lastSendOkAt: string | null;
    lastError: string;
    restarts24h: number | null;
    cpuPct: number | null;
    rssMb: number | null;
    pendingEvents: number | null;
    skippedEvents: number | null;
    sendRejectStreak: number | null;
  };
  channels: Record<string, AgentChannelStatus>;
  /** 最近 24 小時的 Watchdog / Agent 事件(新的在前,最多 EVENTS_PER_AGENT 筆) */
  events: AgentEvent[];
}

export const AGENT_CHANNELS = ['Security', 'System', 'Directory_Service', 'DNS_Server'] as const;
export const EVENTS_PER_AGENT = 20;
const DAY_MS = 86_400_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/** 控制字元換成空白、截斷 */
// eslint-disable-next-line no-control-regex
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '');
const numOr = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const boolOr = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
/** ISO 8601 時間字串(可解析才回) */
const isoOr = (v: unknown): string | null => {
  const s = text(v, 40);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
};

function parseJson(s: string | undefined): Obj {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

function channelStatus(v: unknown): AgentChannelStatus {
  const c = isObj(v) ? v : {};
  return {
    lastRecordId: numOr(c.lastRecordId),
    logEpoch: numOr(c.logEpoch),
    fileSizeMb: numOr(c.fileSizeMb),
    maxSizeMb: numOr(c.maxSizeMb),
    oldestEventAt: isoOr(c.oldestEventAt),
    coverageHours: numOr(c.coverageHours),
    wrapRisk: boolOr(c.wrapRisk),
  };
}

export function agentState(ageSec: number | null, staleSec: number, offlineSec: number): AgentState {
  if (ageSec === null) return 'unknown';
  if (ageSec > offlineSec) return 'offline';
  if (ageSec > staleSec) return 'stale';
  return 'ok';
}

/** Watchdog 事件清單(JSON 字串,新的在前)→ 每台 DC 最近 24 小時、最多 EVENTS_PER_AGENT 筆 */
export function groupAgentEvents(raw: readonly string[], now: number): Map<string, AgentEvent[]> {
  const out = new Map<string, AgentEvent[]>();
  for (const s of raw) {
    const r = parseJson(s);
    const computer = text(r.computer, 64);
    const receivedAt = isoOr(r.receivedAt);
    if (!computer || !receivedAt || now - Date.parse(receivedAt) > DAY_MS) continue;
    const list = out.get(computer) ?? [];
    if (list.length >= EVENTS_PER_AGENT) continue;
    const ev = isObj(r.event) ? r.event : {};
    list.push({ type: text(ev.type, 64), cause: text(ev.cause, 64), detail: text(ev.detail, 300) || text(ev.error, 300), at: isoOr(ev.at), receivedAt });
    out.set(computer, list);
  }
  return out;
}

/** 心跳 Hash → 畫面用的狀態(白名單) */
export function toAgentStatus(hb: AdHeartbeatRaw, events: AgentEvent[], opts: { now: number; staleSec: number; offlineSec: number }): AgentStatus {
  const f = hb.fields;
  const data = parseJson(f.data);
  const a = isObj(data.agent) ? data.agent : {};
  const ch = isObj(data.channels) ? data.channels : {};
  const updatedAt = isoOr(f.updatedAt);
  const ageSec = updatedAt ? Math.max(0, Math.floor((opts.now - Date.parse(updatedAt)) / 1000)) : null;
  const channels: Record<string, AgentChannelStatus> = {};
  for (const c of AGENT_CHANNELS) if (c in ch) channels[c] = channelStatus(ch[c]);
  return {
    computer: hb.computer,
    dcDomain: text(f.domain, 128),
    state: agentState(ageSec, opts.staleSec, opts.offlineSec),
    updatedAt,
    ageSec,
    reportedAt: isoOr(f.reportedAt),
    agentVersion: text(f.agentVersion, 32),
    watchdogVersion: text(data.watchdogVersion, 32),
    received: Number(f.received) || 0,
    agent: {
      pid: numOr(a.pid),
      serviceState: text(a.serviceState, 32),
      startType: text(a.startType, 32),
      statusOk: boolOr(a.statusOk),
      lastCollectTickAt: isoOr(a.lastCollectTickAt),
      lastSendOkAt: isoOr(a.lastSendOkAt),
      lastError: text(a.lastError, 300),
      restarts24h: numOr(a.restarts24h),
      cpuPct: numOr(a.cpuPct),
      rssMb: numOr(a.rssMb),
      pendingEvents: numOr(a.pendingEvents),
      skippedEvents: numOr(a.skippedEvents),
      sendRejectStreak: numOr(a.sendRejectStreak),
    },
    channels,
    events,
  };
}

/** 全部 DC 的狀態與摘要 */
export function summarizeAgents(list: AgentStatus[]) {
  const count = (s: AgentState) => list.filter((x) => x.state === s).length;
  return {
    total: list.length,
    ok: count('ok'),
    stale: count('stale'),
    offline: count('offline'),
    unknown: count('unknown'),
    wrapRisk: list.filter((x) => Object.values(x.channels).some((c) => c.wrapRisk === true)).length,
  };
}
