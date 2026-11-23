/**
 * AD 事件:netops-ad-receiver 寫進 Stream netops:ad:log:events 的 JSON → netops.ad_events 一列
 * (AD-1;docs/AD-AGENT-PLAN.md §4.3.1、deploy/clickhouse/migrations/005-ad1-ad-events.sql)。純函式,不依賴 Redis / ClickHouse。
 *
 * Stream 的 JSON(接收端已驗證並正規化,見 src/ad-receiver/payload.ts toStreamEvent):
 *   { computer, domain, channel, eventId, recordId(數字字串), logEpoch, time(ISO 8601 含時區), level, provider, message }
 * computer / domain 是接收端依 Token 對應表核對過的值(H3),不是帳戶網域。
 * 帳戶、來源 IP、工作站、失敗原因、異動主體 / 對象 / 群組:沿用既有 FTP 匯入的解析(modules/ad/core/adlog.js 的 toEvent、enrichEvent、isIssue),
 * 兩個來源的欄位才會一致(AD-3 的 FTP 補漏用同一套)。
 */
import { enrichEvent, isIssue, toEvent } from '../modules/ad/core/adlog.js';
import { ip, taipeiText, type Row, type RowIssues } from './rows.js';

/** 事件時間最多比收到時間晚多久(DC 時鐘偏差);超過改用收到時間(issues.badTime) */
export const AD_MAX_FUTURE_MS = 86_400_000;
/** 事件時間最多比收到時間早多久:Agent 離線很久後補送的事件仍保留原時間(原始表 TTL 90 天會再處理) */
export const AD_MAX_PAST_MS = 366 * 86_400_000;
/** 文字欄位上限(訊息另由 toEvent 截到 3,000 字) */
const MAX_FIELD = 256;

export const AD_CHANNELS = ['Security', 'System', 'Directory_Service', 'DNS_Server'] as const;
export type AdChannel = (typeof AD_CHANNELS)[number];

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** ISO 8601(一定要有時區)→ UTC 毫秒;不合法回 null(2026-02-30 之類會被 Date 進位,比對回來不同就是不合法) */
export function parseIsoTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = ISO_TIME.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac = '', tz] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}.${(frac + '000').slice(0, 3)}${tz}`);
  if (Number.isNaN(ms)) return null;
  // 日期本身要存在(用當地欄位比對,不受時區影響)
  const local = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  if (local.getUTCMonth() !== Number(mo) - 1 || local.getUTCDate() !== Number(d) || local.getUTCHours() !== Number(h) || Number(s) > 59) return null;
  return ms;
}

const text = (v: unknown, max = MAX_FIELD): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').slice(0, max);
const RECORD_ID = /^[1-9]\d{0,15}$/;
const uint32 = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4_294_967_295 ? v : null);

/** Stream 一筆的 JSON → 一列;缺必要欄位(computer、channel、eventId、recordId、logEpoch)回 null(呼叫端計為 malformed 並 ACK) */
export function toAdRow(data: string, receivedMs: number, issues: RowIssues): Row | null {
  let rec: unknown;
  try {
    rec = JSON.parse(data);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const r = rec as Record<string, unknown>;
  const computer = text(r.computer, 64);
  const channel = text(r.channel, 32);
  const eventId = uint32(r.eventId);
  const logEpoch = uint32(r.logEpoch);
  const recordId = text(r.recordId, 20);
  if (!computer || !(AD_CHANNELS as readonly string[]).includes(channel) || eventId === null || eventId > 65_535 || logEpoch === null || !RECORD_ID.test(recordId)) return null;

  const t = parseIsoTime(r.time);
  const ok = t !== null && t - receivedMs <= AD_MAX_FUTURE_MS && receivedMs - t <= AD_MAX_PAST_MS;
  if (!ok) issues.badTime = true;

  // 用 FTP 匯入的同一套解析:欄位順序 = map 的索引
  const map = { time: 0, eventId: 1, level: 2, provider: 3, computer: 4, recordId: 5, message: 6 };
  const ev = enrichEvent(toEvent(['', String(eventId), text(r.level, 64), text(r.provider), computer, recordId, typeof r.message === 'string' ? r.message : ''], map, channel)) as Record<string, unknown> & {
    level: string;
    eventId: number;
  };
  const rawIp = text(ev.ip, 100);
  return {
    event_time: taipeiText(ok ? t : receivedMs),
    received_at: new Date(receivedMs).toISOString(),
    computer,
    ad_domain: text(r.domain, 128),
    channel,
    event_id: eventId,
    log_epoch: logEpoch,
    record_id: recordId,
    level: ev.level,
    level_text: text(ev.levelText, 64),
    provider: text(ev.provider),
    account: text(ev.account),
    actor: text(ev.actor),
    target: text(ev.target),
    group_name: text(ev.group),
    privileged: ev.privileged ? 1 : 0,
    is_issue: isIssue(ev) ? 1 : 0,
    src_ip: ip(rawIp),
    src_ip_raw: rawIp,
    workstation: text(ev.workstation),
    reason: text(ev.reason),
    message: text(ev.message, 3000),
    source: 'agent',
  };
}
