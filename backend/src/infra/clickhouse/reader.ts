/**
 * netops-api 的 ClickHouse 唯讀查詢(C3;ARCHITECTURE D29、手冊 docs/PA-LOG-CLICKHOUSE-GUIDE.md §7.4、§10.2)。
 *   - 帳號 netops_reader(readonly=2;max_execution_time ≤ 50、max_memory_usage ≤ 500 MB、max_result_rows ≤ 100000 由 users.d constraints 固定)
 *   - 表名只用 READ_TABLES 常數;查詢條件一律 query_params(param_*),不拼接字串
 *   - 只提供具名函式;模組不能送任意 SQL(AGENT.md §7.2)
 *   - 原始 log 一次讀一小時以內,依每分鐘筆數切段,每段 ≤ SLICE_ROWS(不超過 max_result_rows)
 *
 * 時間參數一律 Unix 秒;欄位是 DateTime('Asia/Taipei'),回傳的小時也是 Unix 秒(呼叫端換成台灣時間的鍵)。
 */
import { isIPv6 } from 'node:net';
import { ClickHouseError, clickHouseBase, connectError, responseError, type ClickHouseConfig } from './index.js';

/** 唯讀查詢用到的表(不接受外部字串) */
export const READ_TABLES = {
  traffic: 'netops.pa_traffic_logs',
  threat: 'netops.pa_threat_logs',
  hourlyApp: 'netops.pa_traffic_hourly_app',
  /** V-b1 儀表板 Top 10 頻寬 IP */
  hourlySrc: 'netops.pa_traffic_hourly_src',
  /** AC2:AI 分析超過 30 天的部分(每天彙總;V-a 熱力圖表) */
  heat1d: 'netops.pa_heat_1d',
} as const;

/** 存進 ClickHouse 的威脅類 log(其他類型仍只有 FTP;AGENT.md §7.2) */
export const CH_EVENT_TYPES = ['threat', 'url', 'data', 'wildfire'] as const;
export type ChEventType = (typeof CH_EVENT_TYPES)[number];
export const isChEventType = (t: string): t is ChEventType => (CH_EVENT_TYPES as readonly string[]).includes(t);

/** 原始 log 一段最多幾筆(netops_reader 的 max_result_rows 是 100000) */
/**
 * 2026-11-11 測試區:一段 8 萬列串流 + 摘要超過 30 秒的請求逾時,那一小時一直建不起來;
 * 改成每段 2 萬列、每段最多等 RECORDS_WAIT_MS
 */
export const SLICE_ROWS = 20_000;
/** 原始 log 每段最多等多久(用戶端;伺服器端仍受 max_execution_time 限制) */
const RECORDS_WAIT_MS = 180_000;
/** netops_reader 的 max_result_rows(users.d/profiles.xml) */
const MAX_RESULT_ROWS = 100_000;

/** IPv6 欄位 → 舊版畫面的字串(IPv4 去掉 ::ffff:;空位址 :: 為空字串) */
export const ipText = (col: string) => `if(${col} = toIPv6('::'), '', replaceRegexpOne(toString(${col}), '^::ffff:', ''))`;
const timeText = (col: string) => `formatDateTime(${col}, '%Y/%m/%d %H:%i:%S')`;

/**
 * 原始 log → 核心(core/palog.js、core/paevents.js)的紀錄欄位;欄位名稱同 FTP CSV 的對應(COLUMNS),
 * 所以 FTP 與 ClickHouse 用同一份摘要邏輯(createSummary / createEventSummary)。
 */
export const TRAFFIC_FIELDS: [string, string][] = [
  ['time', timeText('event_time')],
  ['subtype', 'subtype'],
  ['src', ipText('src')],
  ['dst', ipText('dst')],
  ['natSrc', ipText('nat_src')],
  ['natDst', ipText('nat_dst')],
  ['rule', 'rule'],
  ['srcUser', 'src_user'],
  ['app', 'app'],
  ['fromZone', 'from_zone'],
  ['toZone', 'to_zone'],
  ['inIf', 'in_if'],
  ['outIf', 'out_if'],
  ['sport', 'sport'],
  ['dport', 'dport'],
  ['natDport', 'nat_dport'],
  ['proto', 'proto'],
  ['action', 'action'],
  ['bytes', 'bytes'],
  ['sent', 'bytes_sent'],
  ['recv', 'bytes_recv'],
  ['packets', 'packets'],
  ['start', `if(toUnixTimestamp(session_start) = 0, '', ${timeText('session_start')})`],
  ['elapsed', 'elapsed'],
  ['category', 'category'],
  ['srcCountry', 'src_country'],
  ['dstCountry', 'dst_country'],
  ['endReason', 'end_reason'],
  ['appRisk', 'app_risk'],
  ['appCategory', 'app_category'],
  ['appSubcat', 'app_subcat'],
  ['appTech', 'app_tech'],
  ['srcHost', 'src_host'],
  ['dstHost', 'dst_host'],
];

export const THREAT_FIELDS: [string, string][] = [
  ['time', timeText('event_time')],
  ['subtype', 'subtype'],
  ['src', ipText('src')],
  ['dst', ipText('dst')],
  ['natSrc', ipText('nat_src')],
  ['natDst', ipText('nat_dst')],
  ['rule', 'rule'],
  ['srcUser', 'src_user'],
  ['app', 'app'],
  ['fromZone', 'from_zone'],
  ['toZone', 'to_zone'],
  ['dport', 'dport'],
  ['proto', 'proto'],
  ['action', 'action'],
  ['url', 'url'],
  ['name', 'name'],
  ['category', 'category'],
  ['severity', 'severity'],
  ['direction', 'direction'],
  ['srcCountry', 'src_country'],
  ['dstCountry', 'dst_country'],
  ['repeat', 'repeat_count'],
  ['thrCategory', 'thr_category'],
  ['filedigest', 'file_digest'],
  ['filetype', 'file_type'],
];

export type LogRecord = Record<string, string | number>;

/** pa_traffic_hourly_app 依小時、動作的合計 */
export interface TrafficHourRow {
  /** 小時開始(UTC 毫秒) */
  hour: number;
  action: string;
  n: number;
  bytes: number;
}

export interface ClickHouseReader {
  /** 連線與帳密是否可用 */
  ping(): Promise<void>;
  /** 每小時彙總依小時與動作的合計(期間 [fromMs, toMs)) */
  trafficHours(fromMs: number, toMs: number, signal?: AbortSignal): Promise<TrafficHourRow[]>;
  /** 明細查詢的下拉選項:期間內的 App(依次數前 limit 名)、區域、動作(來自每小時彙總) */
  trafficOptions(fromMs: number, toMs: number, limit: number): Promise<{ apps: string[]; zones: string[]; actions: string[] }>;
  /** 每小時彙總最早的小時(UTC 毫秒);沒有資料為 null */
  earliestTrafficHour(signal?: AbortSignal): Promise<number | null>;
  /** ClickHouse 有資料的範圍與每天筆數(TRAFFIC 來自每小時彙總;威脅類來自原始表,依類型) */
  trafficDays(): Promise<{ day: number; hours: number; rows: number }[]>;
  /** 威脅類各類型每天的小時數與筆數(一次查全部類型) */
  threatDays(): Promise<{ type: ChEventType; day: number; hours: number; rows: number }[]>;
  /** 威脅類每小時筆數(原始列數,不乘 Repeat Count) */
  threatHourCounts(fromMs: number, toMs: number, signal?: AbortSignal): Promise<{ type: ChEventType; hour: number; n: number }[]>;
  /** 逐列讀取期間內的 TRAFFIC 原始 log(核心紀錄格式);回傳筆數 */
  trafficRecords(fromMs: number, toMs: number, onRow: (r: LogRecord) => void, signal?: AbortSignal): Promise<number>;
  /** 逐列讀取期間內某類型的威脅類原始 log */
  threatRecords(type: ChEventType, fromMs: number, toMs: number, onRow: (r: LogRecord) => void, signal?: AbortSignal): Promise<number>;
  /**
   * TRAFFIC 明細查詢(C3,工作模式內執行;docs/API.md §4.3):依時間由舊到新最多 limit 筆;more = 還有更多符合的。
   * scanned 為 ClickHouse 讀過的列數(X-ClickHouse-Summary;沒有時為 0)。maxSeconds ≤ 50(帳號 constraints)
   */
  searchTraffic(f: TrafficFilter, limit: number, maxSeconds: number, signal?: AbortSignal): Promise<{ rows: LogRecord[]; more: boolean; scanned: number }>;
  /** 期間內 TRAFFIC 每小時彙總的總筆數(明細查詢前判斷有沒有資料) */
  trafficCount(fromMs: number, toMs: number): Promise<number>;
  /**
   * 威脅 log 明細查詢(log_type = threat;V-b2 C7 第二輪,需求方 2026-11-13 決定;docs/API.md §4.3):
   * 語意同 searchTraffic,另加嚴重度、威脅名稱;rows 為 THREAT_FIELDS 的欄位
   */
  searchThreat(f: ThreatSearchFilter, limit: number, maxSeconds: number, signal?: AbortSignal): Promise<{ rows: LogRecord[]; more: boolean; scanned: number }>;
  /** 期間內威脅 log(log_type = threat)的筆數(明細查詢前判斷有沒有資料) */
  threatCount(fromMs: number, toMs: number): Promise<number>;
  /**
   * AI 問答(AC2,ARCHITECTURE D44):原始 TRAFFIC 符合條件的連線組合,依小時累計(格式同連線組合統計,給 ai/core/evidence.js addFlow);
   * 依次數由多到少最多 limit 列,truncated = 還有更多組合
   */
  aiTrafficFlows(cond: AiCond, fromMs: number, toMs: number, limit: number, signal?: AbortSignal): Promise<{ rows: AiFlowRow[]; truncated: boolean }>;
  /** AI 問答的範例紀錄:每種組合(來源、目的、Port、動作、規則)一筆、最新的在前,最多 limit 筆(TRAFFIC_FIELDS) */
  aiTrafficSamples(cond: AiCond, fromMs: number, toMs: number, limit: number, signal?: AbortSignal): Promise<LogRecord[]>;
  /**
   * AI 問答:威脅類符合 IP 條件的紀錄,依全部欄位(時間除外)累計;n 乘 Repeat Count(同 FTP 摘要)。
   * 依次數由多到少最多 limit 列,truncated = 還有更多
   */
  aiThreatGroups(types: readonly ChEventType[], cond: AiCond, fromMs: number, toMs: number, limit: number, signal?: AbortSignal): Promise<{ rows: AiThreatRow[]; truncated: boolean }>;
  /** AI 分析超過 30 天的部分:每天的連線數、阻擋、位元組、威脅嚴重度(pa_heat_1d) */
  aiDays(fromMs: number, toMs: number, signal?: AbortSignal): Promise<AiDayRow[]>;
  /** AI 分析超過 30 天的部分:動作、App、區域(每小時彙總 App,13 個月)與來源 IP(每小時彙總來源,90 天)的排行 */
  aiTops(fromMs: number, toMs: number, limit: number, signal?: AbortSignal): Promise<AiTops>;
}

/** AI 問答條件(ai/core/evidence.js parseQuestion):1 個 IP = 來源或目的(含 NAT);2 個 = 兩者之間;3–4 個 = 任一;Port = 目的 Port */
export interface AiCond {
  ips: string[];
  ports: number[];
}

/** 連線組合每小時一列(欄位同 FTP 連線組合統計 pa/core/flows.js parseLine;end = [結束原因, 次數]) */
export interface AiFlowRow {
  src: string;
  dst: string;
  natSrc: string;
  natDst: string;
  proto: string;
  dport: number;
  action: string;
  rule: string;
  app: string;
  fromZone: string;
  toZone: string;
  dstCountry: string;
  srcUser: string;
  category: string;
  /** 'YYYY/MM/DD HH'(台灣時間) */
  hour: string;
  first: string;
  last: string;
  n: number;
  bytes: number;
  end: [string, number][];
}

/** 威脅類累計列:type + THREAT_FIELDS(time、repeat 除外)+ 次數與時間範圍 */
export type AiThreatRow = LogRecord & { type: ChEventType; n: number; first: string; last: string };

export interface AiDayRow {
  /** 台灣時間當天 00:00(UTC 毫秒) */
  day: number;
  sessions: number;
  deny: number;
  bytes: number;
  sent: number;
  recv: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

/** [key, 次數, 位元組](同 FTP 摘要的 top 格式,mergeSummaries 可直接合併) */
export type TopRow = [string, number, number];
export interface AiTops {
  actions: Record<string, number>;
  app: TopRow[];
  zone: TopRow[];
  src: TopRow[];
  blockSrc: TopRow[];
}

/** 明細查詢條件(和 FTP 掃描 core/palog.js buildFilter 相同語意;時間為 UTC 毫秒,toMs 不含) */
export interface TrafficFilter {
  fromMs: number;
  toMs: number;
  src?: string;
  dst?: string;
  ip?: string;
  port?: string;
  proto?: string;
  app?: string;
  rule?: string;
  action?: string;
  fromZone?: string;
  toZone?: string;
  user?: string;
  /** 來源或目的國家任一方(相容) */
  country?: string;
  /** 來源國家(src_country) */
  srcCountry?: string;
  /** 目的國家(dst_country) */
  dstCountry?: string;
  q?: string;
}

/** 威脅 log 明細條件:TRAFFIC 的條件 + 嚴重度(critical / high / medium / low / info)、威脅名稱(包含) */
export interface ThreatSearchFilter extends TrafficFilter {
  severity?: string;
  threat?: string;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
/** 合法的 IPv6(node:net 驗證;不合法的不送進 toIPv6,避免整個查詢失敗) */
const isIPv6Text = (v: string) => !v.includes('%') && isIPv6(v);

/** q 比對的文字欄位(FTP 版比對整列 CSV;原始 log 不存整列) */
const TEXT_COLUMNS = [
  ipText('src'), ipText('dst'), ipText('nat_src'), ipText('nat_dst'), 'toString(sport)', 'toString(dport)', 'subtype', 'proto', 'rule', 'src_user', 'app',
  'from_zone', 'to_zone', 'action', 'category', 'src_country', 'dst_country', 'end_reason', 'src_host', 'dst_host',
];
/** 威脅表沒有 sport、end_reason、src_host、dst_host;另加威脅名稱、URL、嚴重度 */
const THREAT_TEXT_COLUMNS = [
  ipText('src'), ipText('dst'), ipText('nat_src'), ipText('nat_dst'), 'toString(dport)', 'subtype', 'proto', 'rule', 'src_user', 'app',
  'from_zone', 'to_zone', 'action', 'category', 'src_country', 'dst_country', 'name', 'url', 'severity',
];

/**
 * 單一 IP 欄位的條件(trafficWhere 與 AI 問答共用;p 產生參數佔位符,值一律放參數):
 *   CIDR(IPv4 / IPv6,BETWEEN)、萬用字元 *(LIKE)、合法 IP 完全相同;不合法的 CIDR 以字首、其他以字串完全相同比對
 */
export function ipClause(col: string, pattern: string, p: (v: Param, type: string) => string): string {
  if (pattern.includes('/')) {
    const [base = '', bitsText = ''] = pattern.split('/');
    const bits = Number(bitsText);
    const v4 = IPV4.test(base) && /^\d{1,2}$/.test(bitsText) && bits <= 32;
    const v6 = isIPv6Text(base) && /^\d{1,3}$/.test(bitsText) && bits <= 128;
    if (v4 || v6) {
      const r = `IPv6CIDRToRange(toIPv6(${p(base, 'String')}), ${p(v4 ? bits + 96 : bits, 'UInt8')})`;
      return `${col} BETWEEN tupleElement(${r}, 1) AND tupleElement(${r}, 2)`;
    }
    return `startsWith(${ipText(col)}, ${p(base, 'String')})`;
  }
  if (pattern.includes('*')) return `${ipText(col)} LIKE ${p(pattern.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '%'), 'String')}`;
  if (IPV4.test(pattern) || isIPv6Text(pattern)) return `${col} = toIPv6OrNull(${p(pattern, 'String')})`;
  return `${ipText(col)} = ${p(pattern, 'String')}`;
}

/**
 * 明細條件 → SQL 條件與參數(純函式;值一律放參數,欄位名稱只來自程式內常數)。
 *   IP:完全相同(含 NAT 位址)、CIDR(IPv4 / IPv6,排序鍵友善的 BETWEEN)、萬用字元 *(LIKE,線性時間,沒有 ReDoS);
 *       不是合法 IP 也不是合法 CIDR 時同 FTP 版:CIDR 以字首比對、其他以字串完全相同比對
 *   其他欄位同 buildFilter:proto、區域完全相同不分大小寫;App、規則、使用者、國家包含;action allow / block / 原文
 */
export function trafficWhere(f: TrafficFilter, textColumns: string[] = TEXT_COLUMNS): { where: string[]; params: Record<string, Param> } {
  const where = ['event_time >= toDateTime({from:UInt32})', 'event_time < toDateTime({to:UInt32})'];
  const params: Record<string, Param> = { from: sec(f.fromMs), to: Math.ceil(f.toMs / 1000) };
  let n = 0;
  const p = (v: Param, type: string) => {
    const k = `p${n++}`;
    params[k] = v;
    return `{${k}:${type}}`;
  };
  const ipOne = (col: string, pattern: string): string => ipClause(col, pattern, p);
  const ipAny = (cols: [string, boolean][], pattern?: string) => {
    const v = String(pattern ?? '').trim();
    if (!v) return;
    // NAT 欄位空白(::)時不比對(同 FTP:r.natSrc && …)
    where.push(`(${cols.map(([c, nat]) => (nat ? `(${c} != toIPv6('::') AND ${ipOne(c, v)})` : ipOne(c, v))).join(' OR ')})`);
  };
  ipAny([['src', false], ['nat_src', true]], f.src);
  ipAny([['dst', false], ['nat_dst', true]], f.dst);
  ipAny([['src', false], ['dst', false], ['nat_src', true], ['nat_dst', true]], f.ip);
  const port = String(f.port ?? '').trim();
  if (port) {
    const ports = [...new Set(port.split(/[,\s]+/).filter(Boolean).map(Number))].filter((x) => Number.isInteger(x) && x >= 0 && x <= 65535);
    where.push(ports.length ? `dport IN ${p(`[${ports.join(',')}]`, 'Array(UInt16)')}` : '0');
  }
  const exact = (col: string, v?: string) => {
    const x = String(v ?? '').trim().toLowerCase();
    if (x) where.push(`lowerUTF8(${col}) = ${p(x, 'String')}`);
  };
  const contains = (cols: string[], v?: string) => {
    const x = String(v ?? '').trim();
    if (!x) return;
    const k = p(x, 'String');
    where.push(`(${cols.map((c) => `positionCaseInsensitiveUTF8(${c}, ${k}) > 0`).join(' OR ')})`);
  };
  exact('proto', f.proto);
  contains(['app'], f.app);
  contains(['rule'], f.rule);
  exact('from_zone', f.fromZone);
  exact('to_zone', f.toZone);
  contains(['src_user'], f.user);
  contains(['src_country', 'dst_country'], f.country);
  contains(['src_country'], f.srcCountry);
  contains(['dst_country'], f.dstCountry);
  const action = String(f.action ?? '').trim();
  if (action === 'allow') where.push(`action = 'allow'`);
  else if (action === 'block') where.push(`action != 'allow'`);
  else if (action) where.push(`action = ${p(action, 'String')}`);
  contains([`concat(${textColumns.join(", ',', ")})`], f.q);
  return { where, params };
}

/** 嚴重度(畫面用 info;表內是 informational) */
export const SEARCH_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'informational'] as const;

/** 威脅 log 明細條件 → SQL(log_type = threat;其餘同 trafficWhere,欄位在威脅表同名) */
export function threatSearchWhere(f: ThreatSearchFilter): { where: string[]; params: Record<string, Param> } {
  const { where, params } = trafficWhere(f, THREAT_TEXT_COLUMNS);
  where.push(`log_type = 'threat'`);
  const sev = String(f.severity ?? '').trim().toLowerCase();
  if (sev) {
    params.sev = sev === 'info' ? 'informational' : sev;
    where.push('severity = {sev:String}');
  }
  const name = String(f.threat ?? '').trim();
  if (name) {
    params.thr = name;
    where.push('positionCaseInsensitiveUTF8(name, {thr:String}) > 0');
  }
  return { where, params };
}

/**
 * AI 問答條件 → SQL(AC2;語意同 ai/core/evidence.js buildCondition,值一律放參數):
 *   每個 IP 比對來源、目的與 NAT 位址(NAT 欄位空白不比對);1 個 IP、3–4 個 IP 任一出現用 OR,2 個 IP 兩者都要出現用 AND;
 *   Port 比對目的 Port
 */
export function aiWhere(cond: AiCond, fromMs: number, toMs: number): { where: string[]; params: Record<string, Param> } {
  const where = ['event_time >= toDateTime({from:UInt32})', 'event_time < toDateTime({to:UInt32})'];
  const params: Record<string, Param> = { from: sec(fromMs), to: Math.ceil(toMs / 1000) };
  let n = 0;
  const p = (v: Param, type: string) => {
    const k = `a${n++}`;
    params[k] = v;
    return `{${k}:${type}}`;
  };
  const cols: [string, boolean][] = [['src', false], ['dst', false], ['nat_src', true], ['nat_dst', true]];
  const one = (ip: string) => `(${cols.map(([c, nat]) => (nat ? `(${c} != toIPv6('::') AND ${ipClause(c, ip, p)})` : ipClause(c, ip, p))).join(' OR ')})`;
  const ips = cond.ips.slice(0, 4).map((x) => String(x).trim()).filter(Boolean);
  if (ips.length) where.push(`(${ips.map(one).join(ips.length === 2 ? ' AND ' : ' OR ')})`);
  const ports = [...new Set(cond.ports.map(Number))].filter((x) => Number.isInteger(x) && x > 0 && x <= 65535).slice(0, 10);
  if (ports.length) where.push(`dport IN ${p(`[${ports.join(',')}]`, 'Array(UInt16)')}`);
  return { where, params };
}

/**
 * AI 問答的查詢在 SSE 串流內執行(有心跳,不受路由逾時限制):伺服器端用帳號上限 50 秒,用戶端多等 10 秒(逾時由 ClickHouse 回 159);
 * 使用者關頁時 ClickHouse 也停止查詢
 */
const AI_SETTINGS = { max_execution_time: '50', cancel_http_readonly_queries_on_client_close: '1' };
const AI_WAIT_MS = 60_000;

/** 連線組合累計的欄位(AiFlowRow 的順序;ClickHouse 欄位一律加別名 g*,避免和欄位同名) */
const FLOW_GROUP: [keyof AiFlowRow, string][] = [
  ['src', ipText('src')],
  ['dst', ipText('dst')],
  ['natSrc', ipText('nat_src')],
  ['natDst', ipText('nat_dst')],
  ['proto', 'proto'],
  ['dport', 'dport'],
  ['action', 'action'],
  ['rule', 'rule'],
  ['app', 'app'],
  ['fromZone', 'from_zone'],
  ['toZone', 'to_zone'],
  ['dstCountry', 'dst_country'],
  ['srcUser', 'src_user'],
  ['category', 'category'],
  ['hour', `formatDateTime(toStartOfHour(event_time), '%Y/%m/%d %H')`],
];
/** 威脅類累計的欄位:THREAT_FIELDS 除了時間與 Repeat Count */
const THREAT_GROUP = THREAT_FIELDS.filter(([k]) => k !== 'time' && k !== 'repeat');

type Fetch = typeof fetch;
export type Param = string | number;

/** 字串參數:ClickHouse 以跳脫字元解析 param_*(反斜線、tab、換行要跳脫) */
export const paramText = (v: Param) => (typeof v === 'number' ? String(v) : v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r'));
const sec = (ms: number) => Math.floor(ms / 1000);

export interface ReaderOptions {
  /** 一般查詢的伺服器端執行上限(秒;≤ 50,constraints 固定上限) */
  maxSeconds?: number;
}

export function createClickHouseReader(cfg: ClickHouseConfig, fetchImpl: Fetch = fetch, opts: ReaderOptions = {}): ClickHouseReader {
  const base = clickHouseBase(cfg.url);
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const maxSeconds = Math.min(opts.maxSeconds ?? 25, 50);
  const headers = { 'X-ClickHouse-User': cfg.user, 'X-ClickHouse-Key': cfg.password, 'Content-Type': 'text/plain; charset=utf-8' };

  async function request(sql: string, params: Record<string, Param>, signal?: AbortSignal, settings: Record<string, string> = {}, waitMs = timeoutMs): Promise<Response> {
    const u = new URL(base);
    u.pathname = '/';
    for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, paramText(v));
    u.searchParams.set('max_execution_time', String(maxSeconds));
    for (const [k, v] of Object.entries(settings)) u.searchParams.set(k, v);
    // UInt64(筆數、位元組)以數字輸出;實際值遠小於 2^53
    u.searchParams.set('output_format_json_quote_64bit_integers', '0');
    const timeout = AbortSignal.timeout(waitMs);
    try {
      // redirect: 'error':轉址時 X-ClickHouse-Key 會被帶到別的主機,一律不跟隨
      const res = await fetchImpl(u, { method: 'POST', headers, body: sql, redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      if (!res.ok) throw responseError(res, await res.text());
      return res;
    } catch (e) {
      if (e instanceof ClickHouseError) throw e;
      throw connectError(e, waitMs);
    }
  }

  /** 小結果:JSONEachRow 一次讀完 */
  async function rows<T>(sql: string, params: Record<string, Param> = {}, signal?: AbortSignal): Promise<T[]> {
    const res = await request(`${sql} FORMAT JSONEachRow`, params, signal);
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw connectError(e, timeoutMs);
    }
    try {
      return parseLines(text).map((l) => JSON.parse(l) as T);
    } catch {
      // HTTP 200 之後的中途錯誤:不把錯誤原文帶出去(資安審查 L2:可能含 log 內容)
      throw new ClickHouseError('ClickHouse 查詢中斷', Number(/Code: (\d+)/.exec(text)?.[1]) || undefined, 200);
    }
  }

  /** 大結果:逐行讀取(JSONCompactEachRow),中途的錯誤(HTTP 已回 200)以「無法解析的行」偵測;每個資料塊之後讓出事件迴圈 */
  async function stream(
    sql: string,
    params: Record<string, Param>,
    onLine: (cols: unknown[]) => void,
    signal?: AbortSignal,
    settings?: Record<string, string>,
    onResponse?: (res: Response) => void,
    waitMs?: number,
  ): Promise<number> {
    const res = await request(`${sql} FORMAT JSONCompactEachRow`, params, signal, settings, waitMs);
    onResponse?.(res);
    if (!res.body) throw new ClickHouseError('ClickHouse 回應沒有內容', undefined, res.status);
    const decoder = new TextDecoder();
    let buf = '';
    let n = 0;
    const take = (line: string) => {
      if (!line) return;
      let cols: unknown;
      try {
        cols = JSON.parse(line);
      } catch {
        throw new ClickHouseError('ClickHouse 查詢中斷', Number(/Code: (\d+)/.exec(line)?.[1]) || undefined, 200);
      }
      if (!Array.isArray(cols)) throw new ClickHouseError('ClickHouse 回應格式不符', undefined, 200);
      onLine(cols);
      n++;
    };
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          take(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
        await new Promise((r) => setImmediate(r));
      }
      take(buf + decoder.decode());
    } catch (e) {
      if (e instanceof ClickHouseError) throw e;
      throw connectError(e, timeoutMs);
    }
    return n;
  }

  /**
   * 期間內的筆數分布 → 切成每段 ≤ SLICE_ROWS 的時間段 [from, to);expected = 期間內的總筆數(讀完核對用)。
   * 先看每分鐘;單一分鐘就超過 SLICE_ROWS(大量掃描、DoS 經過防火牆)時,那一分鐘改看每秒(資安審查 M1)。
   * 單一秒就超過帳號的 max_result_rows 時無法切段,丟出錯誤(該小時記失敗,其他小時照建)
   */
  async function slices(table: 'traffic' | 'threat', fromMs: number, toMs: number, type?: ChEventType, signal?: AbortSignal): Promise<{ parts: [number, number][]; expected: number }> {
    const cond = type ? 'AND log_type = {type:String}' : '';
    const t: Record<string, Param> = type ? { type } : {};
    const count = (unit: 'toStartOfMinute' | 'toStartOfSecond', a: number, b: number) =>
      rows<{ m: number; n: number }>(
        `SELECT toUnixTimestamp(${unit === 'toStartOfMinute' ? 'toStartOfMinute(event_time)' : 'event_time'}) AS m, count() AS n FROM ${READ_TABLES[table]}
         WHERE event_time >= toDateTime({from:UInt32}) AND event_time < toDateTime({to:UInt32}) ${cond} GROUP BY m ORDER BY m`,
        { from: sec(a), to: sec(b), ...t },
        signal,
      );
    const units: { ms: number; n: number }[] = [];
    for (const { m, n } of await count('toStartOfMinute', fromMs, toMs)) {
      const ms = m * 1000;
      if (n <= SLICE_ROWS) units.push({ ms, n });
      else for (const x of await count('toStartOfSecond', Math.max(ms, fromMs), Math.min(ms + 60_000, toMs))) units.push({ ms: x.m * 1000, n: x.n });
    }
    const parts: [number, number][] = [];
    let start = -1;
    let acc = 0;
    let expected = 0;
    for (const { ms, n } of units) {
      if (n > MAX_RESULT_ROWS) throw new ClickHouseError(`單一秒超過 ${MAX_RESULT_ROWS} 筆,無法分段讀取`, undefined, undefined);
      expected += n;
      if (start >= 0 && acc + n > SLICE_ROWS) {
        parts.push([start, ms]);
        start = -1;
        acc = 0;
      }
      // 第一段可能早於 fromMs(fromMs 不在整分):段落不能超出期間
      if (start < 0) start = Math.max(ms, fromMs);
      acc += n;
    }
    if (start >= 0) parts.push([start, toMs]);
    return { parts, expected };
  }

  async function records(table: 'traffic' | 'threat', fields: [string, string][], fromMs: number, toMs: number, onRow: (r: LogRecord) => void, signal?: AbortSignal, type?: ChEventType) {
    const select = fields.map(([, expr]) => expr).join(', ');
    const names = fields.map(([k]) => k);
    const cond = type ? 'AND log_type = {type:String}' : '';
    const { parts, expected } = await slices(table, fromMs, toMs, type, signal);
    let total = 0;
    for (const [a, b] of parts) {
      if (signal?.aborted) throw connectError(Object.assign(new Error('aborted'), { name: 'AbortError' }), timeoutMs);
      total += await stream(
        `SELECT ${select} FROM ${READ_TABLES[table]} WHERE event_time >= toDateTime({from:UInt32}) AND event_time < toDateTime({to:UInt32}) ${cond}`,
        { from: sec(a), to: sec(b), ...(type ? { type } : {}) },
        (cols) => {
          const r: LogRecord = {};
          for (let i = 0; i < names.length; i++) r[names[i]!] = cols[i] as string | number;
          onRow(r);
        },
        signal,
        undefined,
        undefined,
        RECORDS_WAIT_MS,
      );
    }
    // 讀到的比分段時算的少:連線在行邊界被截斷等,不能當成完整(晚到的資料只會讓筆數變多)
    if (total < expected) throw new ClickHouseError(`ClickHouse 原始 log 讀取不完整(${total} / ${expected})`, undefined, undefined);
    return total;
  }

  /** 明細查詢(工作模式內執行):依時間由舊到新最多 limit 筆;more = 還有更多符合的;scanned = ClickHouse 讀過的列數 */
  async function search(
    table: 'traffic' | 'threat',
    fields: [string, string][],
    w: { where: string[]; params: Record<string, Param> },
    limit: number,
    seconds: number,
    signal?: AbortSignal,
  ): Promise<{ rows: LogRecord[]; more: boolean; scanned: number }> {
    const names = fields.map(([k]) => k);
    const out: LogRecord[] = [];
    let scanned = 0;
    const secs = Math.min(Math.max(Math.floor(seconds), 1), 50);
    await stream(
      `SELECT ${fields.map(([, e]) => e).join(', ')} FROM ${READ_TABLES[table]} WHERE ${w.where.join(' AND ')} ORDER BY event_time, src LIMIT {lim:UInt32}`,
      { ...w.params, lim: limit + 1 },
      (cols) => {
        const r: LogRecord = {};
        for (let i = 0; i < names.length; i++) r[names[i]!] = cols[i] as string | number;
        out.push(r);
      },
      signal,
      // 工作取消(HTTP 連線中斷)時 ClickHouse 也停止查詢
      { max_execution_time: String(secs), cancel_http_readonly_queries_on_client_close: '1' },
      (res) => {
        try {
          scanned = Number(JSON.parse(res.headers.get('x-clickhouse-summary') ?? '{}').read_rows) || 0;
        } catch {
          /* 沒有摘要標頭只是少了掃描筆數 */
        }
      },
      // 用戶端等待比伺服器端上限多 10 秒:逾時由 ClickHouse 回 159(資安審查 M1)
      (secs + 10) * 1000,
    );
    const more = out.length > limit;
    return { rows: more ? out.slice(0, limit) : out, more, scanned };
  }

  const range = (fromMs: number, toMs: number) => ({ from: sec(fromMs), to: sec(toMs) });

  return {
    async ping() {
      const r = await rows<{ x: number }>('SELECT 1 AS x');
      if (r[0]?.x !== 1) throw new ClickHouseError('ClickHouse ping 回應不符', undefined, undefined);
    },
    async trafficHours(fromMs, toMs, signal) {
      const r = await rows<{ h: number; action: string; n: number; b: number }>(
        `SELECT toUnixTimestamp(hour) AS h, action, sum(sessions) AS n, sum(bytes) AS b FROM ${READ_TABLES.hourlyApp}
         WHERE hour >= toDateTime({from:UInt32}) AND hour < toDateTime({to:UInt32}) GROUP BY h, action ORDER BY h, action`,
        range(fromMs, toMs),
        signal,
      );
      return r.map((x) => ({ hour: x.h * 1000, action: x.action, n: Number(x.n), bytes: Number(x.b) }));
    },
    async trafficOptions(fromMs, toMs, limit) {
      const p = { ...range(fromMs, toMs), lim: limit };
      const where = 'hour >= toDateTime({from:UInt32}) AND hour < toDateTime({to:UInt32})';
      const [apps, zones, actions] = await Promise.all([
        rows<{ app: string }>(`SELECT app FROM ${READ_TABLES.hourlyApp} WHERE ${where} AND app != '' GROUP BY app ORDER BY sum(sessions) DESC, app LIMIT {lim:UInt16}`, p),
        rows<{ z: string }>(`SELECT DISTINCT arrayJoin([from_zone, to_zone]) AS z FROM ${READ_TABLES.hourlyApp} WHERE ${where} ORDER BY z LIMIT {lim:UInt16}`, p),
        rows<{ action: string }>(`SELECT DISTINCT action FROM ${READ_TABLES.hourlyApp} WHERE ${where} ORDER BY action`, p),
      ]);
      return { apps: apps.map((x) => x.app), zones: zones.map((x) => x.z).filter((z) => z && z !== '?'), actions: actions.map((x) => x.action || '(空白)') };
    },
    async trafficDays() {
      const r = await rows<{ d: number; h: number; n: number }>(
        `SELECT toUnixTimestamp(toStartOfDay(hour, 'Asia/Taipei')) AS d, uniqExact(hour) AS h, sum(sessions) AS n FROM ${READ_TABLES.hourlyApp} GROUP BY d ORDER BY d DESC`,
      );
      return r.map((x) => ({ day: x.d * 1000, hours: Number(x.h), rows: Number(x.n) }));
    },
    async threatDays() {
      // 威脅類量小(每天數萬筆);只讀 log_type 與 event_time 兩欄
      const r = await rows<{ t: string; d: number; h: number; n: number }>(
        `SELECT log_type AS t, toUnixTimestamp(toStartOfDay(event_time, 'Asia/Taipei')) AS d, uniqExact(toStartOfHour(event_time)) AS h, count() AS n
         FROM ${READ_TABLES.threat} GROUP BY t, d ORDER BY t, d DESC`,
      );
      return r.filter((x) => isChEventType(x.t)).map((x) => ({ type: x.t as ChEventType, day: x.d * 1000, hours: Number(x.h), rows: Number(x.n) }));
    },
    async earliestTrafficHour(signal) {
      const r = await rows<{ h: number }>(`SELECT toUnixTimestamp(min(hour)) AS h FROM ${READ_TABLES.hourlyApp}`, {}, signal);
      const h = Number(r[0]?.h ?? 0);
      return h > 0 ? h * 1000 : null;
    },
    async threatHourCounts(fromMs, toMs, signal) {
      const r = await rows<{ t: string; h: number; n: number }>(
        `SELECT log_type AS t, toUnixTimestamp(toStartOfHour(event_time)) AS h, count() AS n FROM ${READ_TABLES.threat}
         WHERE event_time >= toDateTime({from:UInt32}) AND event_time < toDateTime({to:UInt32}) GROUP BY t, h ORDER BY t, h`,
        range(fromMs, toMs),
        signal,
      );
      return r.filter((x) => isChEventType(x.t)).map((x) => ({ type: x.t as ChEventType, hour: x.h * 1000, n: Number(x.n) }));
    },
    searchTraffic: (f, limit, seconds, signal) => search('traffic', TRAFFIC_FIELDS, trafficWhere(f), limit, seconds, signal),
    searchThreat: (f, limit, seconds, signal) => search('threat', THREAT_FIELDS, threatSearchWhere(f), limit, seconds, signal),
    async threatCount(fromMs, toMs) {
      const r = await rows<{ n: number }>(
        `SELECT count() AS n FROM ${READ_TABLES.threat} WHERE log_type = 'threat' AND event_time >= toDateTime({from:UInt32}) AND event_time < toDateTime({to:UInt32})`,
        { from: sec(fromMs), to: Math.ceil(toMs / 1000) },
      );
      return Number(r[0]?.n ?? 0);
    },
    async trafficCount(fromMs, toMs) {
      const r = await rows<{ n: number }>(
        `SELECT sum(sessions) AS n FROM ${READ_TABLES.hourlyApp} WHERE hour >= toStartOfHour(toDateTime({from:UInt32})) AND hour < toDateTime({to:UInt32})`,
        { from: sec(fromMs), to: Math.ceil(toMs / 1000) },
      );
      return Number(r[0]?.n ?? 0);
    },
    trafficRecords: (fromMs, toMs, onRow, signal) => records('traffic', TRAFFIC_FIELDS, fromMs, toMs, onRow, signal),
    async aiTrafficFlows(cond, fromMs, toMs, limit, signal) {
      const w = aiWhere(cond, fromMs, toMs);
      const g = FLOW_GROUP.map(([, e], i) => `${e} AS g${i}`).join(', ');
      const out: AiFlowRow[] = [];
      await stream(
        `SELECT ${g}, count() AS n, sum(bytes) AS b, ${timeText('min(event_time)')} AS t1, ${timeText('max(event_time)')} AS t2, sumMap([end_reason], [toUInt64(1)]) AS e
         FROM ${READ_TABLES.traffic} WHERE ${w.where.join(' AND ')} GROUP BY ${FLOW_GROUP.map((_, i) => `g${i}`).join(', ')} ORDER BY n DESC LIMIT {lim:UInt32}`,
        { ...w.params, lim: limit + 1 },
        (cols) => {
          const r: Record<string, unknown> = {};
          FLOW_GROUP.forEach(([k], i) => (r[k] = cols[i]));
          const k = FLOW_GROUP.length;
          const [names = [], counts = []] = (cols[k + 4] as [string[], number[]] | undefined) ?? [];
          out.push({
            ...(r as unknown as AiFlowRow),
            dport: Number(r.dport) || 0,
            n: Number(cols[k]),
            bytes: Number(cols[k + 1]),
            first: String(cols[k + 2]),
            last: String(cols[k + 3]),
            end: names.map((x, i) => [x, Number(counts[i])] as [string, number]),
          });
        },
        signal,
        AI_SETTINGS,
        undefined,
        AI_WAIT_MS,
      );
      const truncated = out.length > limit;
      return { rows: truncated ? out.slice(0, limit) : out, truncated };
    },
    async aiTrafficSamples(cond, fromMs, toMs, limit, signal) {
      const w = aiWhere(cond, fromMs, toMs);
      const names = TRAFFIC_FIELDS.map(([k]) => k);
      const out: LogRecord[] = [];
      await stream(
        `SELECT ${TRAFFIC_FIELDS.map(([, e]) => e).join(', ')} FROM ${READ_TABLES.traffic} WHERE ${w.where.join(' AND ')}
         ORDER BY event_time DESC LIMIT 1 BY src, dst, dport, action, rule LIMIT {lim:UInt32}`,
        { ...w.params, lim: limit },
        (cols) => {
          const r: LogRecord = {};
          for (let i = 0; i < names.length; i++) r[names[i]!] = cols[i] as string | number;
          out.push(r);
        },
        signal,
        AI_SETTINGS,
        undefined,
        AI_WAIT_MS,
      );
      return out;
    },
    async aiThreatGroups(types, cond, fromMs, toMs, limit, signal) {
      const list = types.filter(isChEventType);
      if (!list.length) return { rows: [], truncated: false };
      const w = aiWhere(cond, fromMs, toMs);
      const g = THREAT_GROUP.map(([, e], i) => `${e} AS g${i}`).join(', ');
      const out: AiThreatRow[] = [];
      await stream(
        `SELECT log_type AS lt, ${g}, sum(greatest(repeat_count, 1)) AS n, ${timeText('min(event_time)')} AS t1, ${timeText('max(event_time)')} AS t2
         FROM ${READ_TABLES.threat} WHERE ${w.where.join(' AND ')} AND log_type IN {types:Array(String)}
         GROUP BY lt, ${THREAT_GROUP.map((_, i) => `g${i}`).join(', ')} ORDER BY n DESC LIMIT {lim:UInt32}`,
        { ...w.params, types: `[${list.map((t) => `'${t}'`).join(',')}]`, lim: limit + 1 },
        (cols) => {
          const r: LogRecord = {};
          THREAT_GROUP.forEach(([k], i) => (r[k] = cols[i + 1] as string | number));
          const k = THREAT_GROUP.length + 1;
          out.push({ ...r, type: cols[0] as ChEventType, n: Number(cols[k]), first: String(cols[k + 1]), last: String(cols[k + 2]) });
        },
        signal,
        AI_SETTINGS,
        undefined,
        AI_WAIT_MS,
      );
      const truncated = out.length > limit;
      return { rows: truncated ? out.slice(0, limit) : out, truncated };
    },
    async aiDays(fromMs, toMs, signal) {
      const r = await rows<Record<string, number>>(
        `SELECT toUnixTimestamp(bucket) AS d, sum(sessions) AS n, sum(deny) AS x, sum(bytes) AS b, sum(bytes_sent) AS s, sum(bytes_recv) AS r,
                sum(thr_critical) AS c1, sum(thr_high) AS c2, sum(thr_medium) AS c3, sum(thr_low) AS c4, sum(thr_info) AS c5
         FROM ${READ_TABLES.heat1d} WHERE bucket >= toDateTime({from:UInt32}) AND bucket < toDateTime({to:UInt32}) GROUP BY d ORDER BY d`,
        range(fromMs, toMs),
        signal,
      );
      return r.map((x) => ({
        day: Number(x.d) * 1000,
        sessions: Number(x.n),
        deny: Number(x.x),
        bytes: Number(x.b),
        sent: Number(x.s),
        recv: Number(x.r),
        critical: Number(x.c1),
        high: Number(x.c2),
        medium: Number(x.c3),
        low: Number(x.c4),
        info: Number(x.c5),
      }));
    },
    async aiTops(fromMs, toMs, limit, signal) {
      const p = { ...range(fromMs, toMs), lim: limit };
      const hw = 'hour >= toDateTime({from:UInt32}) AND hour < toDateTime({to:UInt32})';
      // 依次數與依位元組各取前 limit 名(同 FTP 摘要 Counter.top(n, withBytes))
      const top = async (table: string, key: string, cond = '') => {
        const q = (order: string) =>
          rows<{ k: string; n: number; b: number }>(
            `SELECT ${key} AS k, sum(sessions) AS n, sum(bytes) AS b FROM ${table} WHERE ${hw} ${cond} GROUP BY k HAVING k != '' ORDER BY ${order} DESC, k LIMIT {lim:UInt16}`,
            p,
            signal,
          );
        const m = new Map<string, TopRow>();
        for (const x of [...(await q('n')), ...(await q('b'))]) m.set(x.k, [x.k, Number(x.n), Number(x.b)]);
        return [...m.values()];
      };
      const actions = await rows<{ a: string; n: number }>(`SELECT action AS a, sum(sessions) AS n FROM ${READ_TABLES.hourlyApp} WHERE ${hw} GROUP BY a ORDER BY a`, p, signal);
      const zone = `if(from_zone = '' AND to_zone = '', '', concat(if(from_zone = '', '?', from_zone), ' → ', if(to_zone = '', '?', to_zone)))`;
      return {
        actions: Object.fromEntries(actions.map((x) => [x.a || '(空白)', Number(x.n)])),
        app: await top(READ_TABLES.hourlyApp, 'app'),
        zone: await top(READ_TABLES.hourlyApp, zone),
        src: await top(READ_TABLES.hourlySrc, ipText('src')),
        blockSrc: await top(READ_TABLES.hourlySrc, ipText('src'), "AND action != 'allow'"),
      };
    },
    threatRecords: (type, fromMs, toMs, onRow, signal) => records('threat', THREAT_FIELDS, fromMs, toMs, onRow, signal, type),
  };
}

const parseLines = (text: string) => text.split('\n').filter((l) => l.trim());
