/**
 * DC Agent 上傳內容的驗證與正規化(AD-1;docs/AD-AGENT-PLAN.md §4.1 Payload 規格)。純函式,不依賴 Fastify / Redis。
 * - 批次層級的錯誤(不是物件、computer / domain 和 Token 對應不一致、超過筆數)整批拒絕;
 * - 單筆事件格式錯誤只拒絕那一筆(回應列出 index 與原因),其他照收:不讓一筆壞資料讓 Agent 永遠重送同一批。
 */
import { AD_CHANNELS, parseIsoTime, type AdChannel } from '../ingest/ad-rows.js';
import type { AdStreamEvent } from '../infra/redis/ad-receiver.js';
import type { DcIdentity } from './tokens.js';

/** 單批事件上限(計畫 §4.1:≤ 1,000 筆、≤ 4 MB;位元組上限由 Fastify bodyLimit 處理) */
export const MAX_EVENTS = 1000;
export const LOGS_BODY_LIMIT = 4 * 1024 * 1024;
export const HEARTBEAT_BODY_LIMIT = 64 * 1024;
/** 訊息上限(ad_events.message 上限 3,000 字;超過截斷,不拒絕) */
export const MAX_MESSAGE = 3000;
/** 回應最多列幾筆被拒絕的事件 */
export const MAX_REJECT_ITEMS = 20;
export const MAX_WATCHDOG_EVENTS = 50;
const MAX_WATCHDOG_EVENT_BYTES = 2048;

/** Agent 可能用 Windows 的原名(有空白);一律存成底線(ad_events.channel) */
const CHANNEL_ALIASES: Record<string, AdChannel> = { 'Directory Service': 'Directory_Service', 'DNS Server': 'DNS_Server' };

export class PayloadError extends Error {
  constructor(
    readonly status: 400 | 403,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const short = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);

/** computer / domain 必須和 Token 對應的 DC 相同(不分大小寫);不一致 403(H3) */
export function checkIdentity(body: unknown, dc: DcIdentity): Record<string, unknown> {
  if (!isObj(body)) throw new PayloadError(400, 'NETOPS_AD_BAD_REQUEST', '內容必須是 JSON 物件');
  const computer = short(body.computer, 64);
  const domain = short(body.domain, 253);
  if (!computer || !domain) throw new PayloadError(400, 'NETOPS_AD_BAD_REQUEST', '缺少 computer 或 domain');
  if (computer.toUpperCase() !== dc.computer.toUpperCase() || domain.toLowerCase() !== dc.domain)
    throw new PayloadError(403, 'NETOPS_AD_IDENTITY_MISMATCH', 'computer / domain 與 Token 對應的 DC 不一致');
  return body;
}

export interface RejectedItem {
  index: number;
  reason: string;
}

export interface ParsedLogs {
  events: AdStreamEvent[];
  rejected: RejectedItem[];
  rejectedCount: number;
}

function recordIdOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 一筆事件 → Stream JSON;錯誤回原因字串 */
function toStreamEvent(e: unknown, dc: DcIdentity): AdStreamEvent | string {
  if (!isObj(e)) return '不是物件';
  const rawChannel = typeof e.channel === 'string' ? e.channel : '';
  const channel = CHANNEL_ALIASES[rawChannel] ?? rawChannel;
  if (!(AD_CHANNELS as readonly string[]).includes(channel)) return 'channel 不支援';
  const eventId = e.eventId;
  if (typeof eventId !== 'number' || !Number.isInteger(eventId) || eventId < 0 || eventId > 65_535) return 'eventId 格式錯誤';
  const recordId = recordIdOf(e.recordId);
  if (recordId === null) return 'recordId 格式錯誤';
  const logEpoch = e.logEpoch;
  if (typeof logEpoch !== 'number' || !Number.isInteger(logEpoch) || logEpoch < 0 || logEpoch > 4_294_967_295) return 'logEpoch 格式錯誤';
  const time = typeof e.time === 'string' ? e.time : '';
  if (time.length > 40 || parseIsoTime(time) === null) return 'time 必須是含時區的 ISO 8601';
  const level = e.level === undefined ? '' : short(e.level, 64);
  const provider = e.provider === undefined ? '' : short(e.provider, 256);
  if (level === null || provider === null) return 'level / provider 格式錯誤';
  if (e.message !== undefined && typeof e.message !== 'string') return 'message 格式錯誤';
  const message = ((e.message as string | undefined) ?? '').slice(0, MAX_MESSAGE);
  return {
    channel,
    logEpoch,
    recordId,
    json: JSON.stringify({ computer: dc.computer, domain: dc.domain, channel, eventId, recordId: String(recordId), logEpoch, time, level, provider, message }),
  };
}

/** POST /ad/v1/logs 的內容(已通過 checkIdentity)→ 依 (channel, logEpoch, recordId) 排序的事件 */
export function parseLogs(body: Record<string, unknown>, dc: DcIdentity): ParsedLogs {
  if (body.agentVersion !== undefined && short(body.agentVersion, 32) === null) throw new PayloadError(400, 'NETOPS_AD_BAD_REQUEST', 'agentVersion 格式錯誤');
  if (!Array.isArray(body.events)) throw new PayloadError(400, 'NETOPS_AD_BAD_REQUEST', '缺少 events 陣列');
  if (body.events.length > MAX_EVENTS) throw new PayloadError(400, 'NETOPS_AD_TOO_MANY_EVENTS', `一批最多 ${MAX_EVENTS} 筆`);
  const events: AdStreamEvent[] = [];
  const rejected: RejectedItem[] = [];
  let rejectedCount = 0;
  body.events.forEach((e, index) => {
    const r = toStreamEvent(e, dc);
    if (typeof r === 'string') {
      rejectedCount++;
      if (rejected.length < MAX_REJECT_ITEMS) rejected.push({ index, reason: r });
    } else events.push(r);
  });
  // 水位逐筆比對,同一個 channel:epoch 內要由小到大
  events.sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0) || a.logEpoch - b.logEpoch || a.recordId - b.recordId);
  return { events, rejected, rejectedCount };
}

export interface ParsedHeartbeat {
  fields: Record<string, string>;
  agentEvents: string[];
}

/** POST /ad/v1/heartbeat(已通過 checkIdentity)→ 心跳 Hash 欄位與 Watchdog 事件(JSON 字串) */
export function parseHeartbeat(body: Record<string, unknown>, dc: DcIdentity, now = Date.now()): ParsedHeartbeat {
  for (const k of ['agentVersion', 'watchdogVersion'] as const)
    if (body[k] !== undefined && short(body[k], 32) === null) throw new PayloadError(400, 'NETOPS_AD_BAD_REQUEST', `${k} 格式錯誤`);
  if (body.reportedAt !== undefined && (typeof body.reportedAt !== 'string' || parseIsoTime(body.reportedAt) === null))
    throw new PayloadError(400, 'NETOPS_AD_BAD_REQUEST', 'reportedAt 必須是含時區的 ISO 8601');
  if (body.agent !== undefined && !isObj(body.agent)) throw new PayloadError(400, 'NETOPS_AD_BAD_REQUEST', 'agent 必須是物件');
  if (body.channels !== undefined && !isObj(body.channels)) throw new PayloadError(400, 'NETOPS_AD_BAD_REQUEST', 'channels 必須是物件');
  const wd = body.watchdogEvents ?? [];
  if (!Array.isArray(wd) || wd.length > MAX_WATCHDOG_EVENTS || !wd.every(isObj)) throw new PayloadError(400, 'NETOPS_AD_BAD_REQUEST', `watchdogEvents 必須是物件陣列(最多 ${MAX_WATCHDOG_EVENTS} 筆)`);
  const receivedAt = new Date(now).toISOString();
  const agentEvents = wd.map((ev) => JSON.stringify({ computer: dc.computer, domain: dc.domain, receivedAt, event: ev }));
  if (agentEvents.some((s) => Buffer.byteLength(s) > MAX_WATCHDOG_EVENT_BYTES)) throw new PayloadError(400, 'NETOPS_AD_BAD_REQUEST', 'watchdogEvents 單筆過大');
  // 心跳內容整份存(已由 bodyLimit 限 64 KB);computer / domain 以對應表為準
  const data = JSON.stringify({ ...body, computer: dc.computer, domain: dc.domain });
  return {
    fields: {
      data,
      updatedAt: receivedAt,
      domain: dc.domain,
      agentVersion: (body.agentVersion as string | undefined) ?? '',
      reportedAt: (body.reportedAt as string | undefined) ?? '',
    },
    agentEvents,
  };
}
