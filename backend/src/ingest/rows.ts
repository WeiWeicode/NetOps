/**
 * netops-pa 寫進 Stream 的 JSON(PA-LIVE-PLAN §4 的 key)→ ClickHouse 一列(deploy/clickhouse/schema.sql 與 migrations/ 的欄位)。
 * 純函式,不依賴 Redis / ClickHouse。不過濾雜訊(CQ8):只要是物件就寫,欄位不合法時給預設值並記在 issues。
 *
 * 型別處理:
 * - 時間:PA 的 $receive_time 是 PA-560 當地時間(台灣,UTC+8,沒有日光節約)「YYYY/MM/DD HH:MM:SS」→「YYYY-MM-DD HH:MM:SS」,
 *   ClickHouse 依欄位時區 Asia/Taipei 解析。格式錯、或和收到時間差超過 MAX_SKEW 時改用收到時間(issues.badTime),
 *   避免一筆錯誤時間建出奇怪的分區或立刻被 TTL 刪掉。
 * - received_at:Stream ID 的毫秒(netops-pa 寫進 Redis 的時間),ISO 8601 UTC。
 * - IP:IPv4 轉成 ::ffff:a.b.c.d 存 IPv6 欄位;空白或不合法存 ::。
 * - seqno:收集器存成數字字串(64 位元,超過 JS 安全整數),原樣寫進 UInt64;沒有或不合法寫 "0"。
 * - 數字:收集器已轉成非負整數;這裡再依欄位寬度檢查,超出寫 0。
 */
import { isIPv4, isIPv6 } from 'node:net';
import type { IngestType } from '../infra/redis/ingest.js';

/** 事件時間和收到時間最多差多少(毫秒);PA 時鐘或轉送延遲超過就不信任 log 時間 */
export const MAX_SKEW_MS = 7 * 86_400_000;
/** 台灣時間 = UTC+8(沒有日光節約) */
const TAIPEI_OFFSET_MS = 8 * 3_600_000;

export interface RowIssues {
  /** 時間格式錯誤或偏差過大,改用收到時間 */
  badTime: boolean;
}

export type Row = Record<string, string | number>;

const PA_TIME = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/** PA 時間字串 → { text: ClickHouse 可解析的當地時間, ms: UTC 毫秒 };不合法回 null */
export function parsePaTime(v: unknown): { text: string; ms: number } | null {
  if (typeof v !== 'string') return null;
  const m = PA_TIME.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(utc);
  // 2026/02/30、25:00 之類:Date.UTC 會自動進位,比對回來不同就是不合法
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return { text: `${y}-${p(mo)}-${p(d)} ${p(h)}:${p(mi)}:${p(s)}`, ms: utc - TAIPEI_OFFSET_MS };
}

/** UTC 毫秒 → 台灣當地時間字串(收到時間當事件時間用) */
export function taipeiText(ms: number): string {
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function uint(v: unknown, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 && n <= max ? n : 0;
}
const U8 = 255;
const U16 = 65_535;
const U32 = 4_294_967_295;
/** UInt64 欄位(位元組、封包):JSON 數字只能精確到 2^53,超過的實務上不會出現,當 0 */
const U64_SAFE = Number.MAX_SAFE_INTEGER;

const UINT64_TEXT = /^(0|[1-9]\d{0,19})$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;
export function seqno(v: unknown): string {
  // JSON 數字超過 2^53 已失去精度(收集器一律送字串),只接受安全整數
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : '0';
  const s = typeof v === 'string' ? v : '';
  return UINT64_TEXT.test(s) && BigInt(s) <= UINT64_MAX ? s : '0';
}

export function ip(v: unknown): string {
  const s = str(v).trim();
  if (isIPv4(s)) return `::ffff:${s}`;
  if (isIPv6(s) && !s.includes('%')) return s;
  return '::';
}

function times(rec: Record<string, unknown>, receivedMs: number, issues: RowIssues) {
  const t = parsePaTime(rec.time);
  const ok = t !== null && Math.abs(t.ms - receivedMs) <= MAX_SKEW_MS;
  if (!ok) issues.badTime = true;
  return { event_time: ok ? t.text : taipeiText(receivedMs), received_at: new Date(receivedMs).toISOString() };
}

/** TRAFFIC(Syslog)→ netops.pa_traffic_logs */
export function toTrafficRow(rec: Record<string, unknown>, receivedMs: number, issues: RowIssues): Row {
  const start = parsePaTime(rec.start);
  return {
    ...times(rec, receivedMs, issues),
    seqno: seqno(rec.seqno),
    session_id: uint(rec.sessionId, U32),
    subtype: str(rec.subtype),
    src: ip(rec.src),
    dst: ip(rec.dst),
    nat_src: ip(rec.natSrc),
    nat_dst: ip(rec.natDst),
    sport: uint(rec.sport, U16),
    dport: uint(rec.dport, U16),
    nat_dport: uint(rec.natDport, U16),
    proto: str(rec.proto),
    rule: str(rec.rule),
    src_user: str(rec.srcUser),
    app: str(rec.app),
    from_zone: str(rec.fromZone),
    to_zone: str(rec.toZone),
    in_if: str(rec.inIf),
    out_if: str(rec.outIf),
    action: str(rec.action),
    bytes: uint(rec.bytes, U64_SAFE),
    bytes_sent: uint(rec.sent, U64_SAFE),
    bytes_recv: uint(rec.recv, U64_SAFE),
    packets: uint(rec.packets, U64_SAFE),
    // 沒有開始時間時寫 0(1970-01-01),不拿事件時間冒充
    session_start: start ? start.text : 0,
    elapsed: uint(rec.elapsed, U32),
    category: str(rec.category),
    src_country: str(rec.srcCountry),
    dst_country: str(rec.dstCountry),
    end_reason: str(rec.endReason),
    app_risk: uint(rec.appRisk, U8),
    app_category: str(rec.appCategory),
    app_subcat: str(rec.appSubcat),
    app_tech: str(rec.appTech),
    src_host: str(rec.srcHost),
    dst_host: str(rec.dstHost),
    source: 'syslog',
  };
}

/** 威脅類(HTTP:threat、url、data、wildfire 共用欄位)→ netops.pa_threat_logs */
export function toThreatRow(type: Exclude<IngestType, 'traffic'>, rec: Record<string, unknown>, receivedMs: number, issues: RowIssues): Row {
  return {
    ...times(rec, receivedMs, issues),
    seqno: seqno(rec.seqno),
    session_id: uint(rec.sessionId, U32),
    log_type: type,
    subtype: str(rec.subtype),
    src: ip(rec.src),
    dst: ip(rec.dst),
    nat_src: ip(rec.natSrc),
    nat_dst: ip(rec.natDst),
    rule: str(rec.rule),
    src_user: str(rec.srcUser),
    app: str(rec.app),
    from_zone: str(rec.fromZone),
    to_zone: str(rec.toZone),
    sport: uint(rec.sport, U16),
    dport: uint(rec.dport, U16),
    nat_dport: uint(rec.natDport, U16),
    proto: str(rec.proto),
    action: str(rec.action),
    url: str(rec.url),
    name: str(rec.name),
    category: str(rec.category),
    severity: str(rec.severity),
    direction: str(rec.direction),
    src_country: str(rec.srcCountry),
    dst_country: str(rec.dstCountry),
    repeat_count: uint(rec.repeat, U32),
    thr_category: str(rec.thrCategory),
    file_digest: str(rec.filedigest),
    file_type: str(rec.filetype),
    source: 'http',
  };
}

/**
 * Stream 一筆的 d 欄位(JSON 字串)→ 一列;不是 JSON 物件回 null(呼叫端計為 malformed 並 ACK)。
 * receivedMs 取自 Stream ID。
 */
export function toRow(type: IngestType, data: string, receivedMs: number, issues: RowIssues): Row | null {
  let rec: unknown;
  try {
    rec = JSON.parse(data);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const r = rec as Record<string, unknown>;
  return type === 'traffic' ? toTrafficRow(r, receivedMs, issues) : toThreatRow(type, r, receivedMs, issues);
}

/** Stream ID 的毫秒部分 */
export const idMs = (id: string): number => Number(id.split('-', 1)[0]);
