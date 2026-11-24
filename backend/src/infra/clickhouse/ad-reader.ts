/**
 * netops-api 的 AD 事件 ClickHouse 唯讀查詢(AD-3;docs/AD-AGENT-PLAN.md §5、§6.1,ARCHITECTURE D49)。
 *   - 帳號 netops_reader;表名只用 AD_READ_TABLE 常數;條件一律 query_params,不拼接使用者輸入
 *   - 回傳的事件格式同 modules/ad/importer.ts 的 AdEvent(時間 'yyyy/MM/dd HH:mm:ss',台灣時間),
 *     另加 dcDomain(DC 所屬網域)、source('agent' | 'ftp')、logEpoch;沒有「帳戶網域」(ad_events 不存)
 *   - overview 的結果和 core/adlog.js summarizeAd() 同形狀(總覽頁與 AI 共用),整合測試以同一份資料比對兩者
 * 時間參數一律 Unix 秒;event_time 是 DateTime('Asia/Taipei')。
 */
import { ClickHouseError, clickHouseBase, connectError, responseError, type ClickHouseConfig } from './index.js';
import { paramText, type Param } from './reader.js';

export const AD_READ_TABLE = 'netops.ad_events';

/** ADLog-FtpBackup-3.ps1 $SecurityEventIds(FTP CSV 的 Security 只有這 23 種;對帳只比這些,審查 M1) */
export const FTP_SECURITY_EVENT_IDS = [4625, 4771, 4740, 4767, 4720, 4722, 4725, 4726, 4724, 4738, 4781, 4728, 4729, 4732, 4733, 4756, 4757, 4727, 4731, 4754, 4704, 4794, 1102] as const;
/** 登入失敗 / 鎖定(summarizeAd 的 fail 統計) */
const FAIL_IDS = [4625, 4771, 4740];
/** core/adlog.js ACCOUNT_CHANGES 的事件(改一邊要同步;migrations/005 的 MV 也用同一份) */
export const ACCOUNT_CHANGE_IDS = [4720, 4722, 4725, 4726, 4724, 4738, 4781, 4767, 4741, 4743, 4727, 4731, 4754, 4728, 4729, 4732, 4733, 4756, 4757, 4704, 4794];
const IMPORTANT_CHANGE_IDS = [4720, 4726, 4724, 4794];

export interface AdChFilter {
  fromMs: number;
  /** 不含 */
  toMs: number;
  channel?: string;
  level?: string;
  /** 逗號 / 空白分隔 */
  eventId?: string;
  q?: string;
  account?: string;
  ip?: string;
  issueOnly?: boolean;
  /** DC 主機名(Agent 的寫法,例 GSMC-DC1) */
  computer?: string;
  /** DC 所屬網域 */
  dcDomain?: string;
  /** IP 對照表名稱反查得到的 IPv4 範圍(AC3) */
  ipRanges?: [string, string][];
}

export interface AdChEvent {
  time: string;
  eventId: number;
  level: string;
  levelText: string;
  provider: string;
  computer: string;
  recordId: string;
  channel: string;
  message: string;
  account: string;
  actor: string;
  target: string;
  group: string;
  privileged: boolean;
  ip: string;
  workstation: string;
  reason: string;
  dcDomain: string;
  source: string;
  logEpoch: number;
}

export interface AdChDay {
  /** 'yyyy/MM/dd' */
  day: string;
  events: number;
  agent: number;
  ftp: number;
  computers: string[];
}

export interface AdReconCount {
  computer: string;
  channel: string;
  n: number;
  agent: number;
  ftp: number;
}

export interface AdChReader {
  days(): Promise<AdChDay[]>;
  /** summarizeAd(events, topN) 同形狀 */
  overview(fromMs: number, toMs: number, topN: number): Promise<AdOverview>;
  /** 新的在前;total 符合條件的筆數、scanned 期間內篩選前的筆數 */
  search(f: AdChFilter, offset: number, limit: number): Promise<{ rows: AdChEvent[]; total: number; scanned: number }>;
  /** 期間內出現過的 DC(computer、dcDomain) */
  computers(fromMs: number, toMs: number): Promise<{ computer: string; dcDomain: string; events: number }[]>;
  /** AI:符合問題中的 IP / 事件 ID / 帳號的事件(新的在前,最多 limit 筆)與總數 */
  aiMatches(fromMs: number, toMs: number, m: { ips: string[]; eventIds: number[]; accounts: string[] }, limit: number): Promise<{ rows: AdChEvent[]; total: number }>;
  /** 期間內有沒有出現這個 IP(來源 IP 或訊息內,不分大小寫) */
  hasIp(fromMs: number, toMs: number, ip: string): Promise<boolean>;
  /** 對帳:某天 [fromMs, toMs) 每個 (computer, channel) 的筆數;Security 只算 FTP 匯出的 23 種 */
  reconCounts(fromMs: number, toMs: number): Promise<AdReconCount[]>;
}

type KeyN = { key: string; n: number };
export interface AdOverview {
  total: number;
  byChannel: Record<string, number>;
  byLevel: Record<string, number>;
  timeMin: string;
  timeMax: string;
  hours: { hour: string; n: number; issue: number }[];
  events: AdGroup[];
  issues: AdGroup[];
  failAccounts: KeyN[];
  failIps: KeyN[];
  failReasons: (KeyN & { ips: KeyN[]; accounts: KeyN[] })[];
  accountChanges: { time: string; eventId: number; action: string; actor: string; target: string; group: string; privileged: boolean; computer: string; recordId: string }[];
  privilegedChanges: number;
  accountsCreated: number;
  privLogons: KeyN[];
}
export interface AdGroup {
  channel: string;
  eventId: number;
  level: string;
  provider: string;
  n: number;
  first: string;
  last: string;
  sample: string;
  computers: string[];
  name: string;
}

/** 查詢參數收集器:回傳 {pN:Type} 佔位字串 */
export function paramBag() {
  const params: Record<string, Param> = {};
  let i = 0;
  const p = (v: Param, type: string) => {
    const k = `p${i++}`;
    params[k] = v;
    return `{${k}:${type}}`;
  };
  return { params, p };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** 篩選條件 → WHERE(語意同 core/adlog.js buildAdFilter,另加 computer、dcDomain、ipRanges);純函式 */
export function adWhere(f: AdChFilter, bag = paramBag(), withFilters = true): { where: string; params: Record<string, Param> } {
  const { p } = bag;
  const w = [`event_time >= toDateTime(${p(Math.floor(f.fromMs / 1000), 'UInt32')})`, `event_time < toDateTime(${p(Math.ceil(f.toMs / 1000), 'UInt32')})`];
  if (withFilters) {
    if (f.channel) w.push(`channel = ${p(f.channel, 'String')}`);
    if (f.level) w.push(`level = ${p(f.level, 'String')}`);
    if (f.issueOnly) w.push('is_issue = 1');
    const ids = String(f.eventId ?? '')
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 65535);
    if (String(f.eventId ?? '').trim()) w.push(ids.length ? `event_id IN ${p(`[${[...new Set(ids)].join(',')}]`, 'Array(UInt32)')}` : '0');
    for (const [k, col] of [
      ['account', 'account'],
      ['ip', 'src_ip_raw'],
    ] as const) {
      const v = String(f[k] ?? '').trim();
      if (v) {
        const x = p(v, 'String');
        w.push(`(positionCaseInsensitiveUTF8(${col}, ${x}) > 0 OR positionCaseInsensitiveUTF8(message, ${x}) > 0)`);
      }
    }
    const q = String(f.q ?? '').trim();
    if (q) w.push(`positionCaseInsensitiveUTF8(concat(message, '\\n', provider, '\\n', toString(event_id)), ${p(q, 'String')}) > 0`);
    if (f.computer) w.push(`computer = ${p(f.computer, 'String')}`);
    if (f.dcDomain) w.push(`ad_domain = ${p(f.dcDomain, 'String')}`);
    if (f.ipRanges) {
      const valid = f.ipRanges.filter(([a, b]) => IPV4.test(a) && IPV4.test(b));
      if (!valid.length) w.push('0');
      else {
        const lo = p(`[${valid.map(([a]) => `'${a}'`).join(',')}]`, 'Array(String)');
        const hi = p(`[${valid.map(([, b]) => `'${b}'`).join(',')}]`, 'Array(String)');
        w.push(`(src_ip != toIPv6('::') AND arrayExists((a, b) -> src_ip BETWEEN a AND b, arrayMap(x -> toIPv6(x), ${lo}), arrayMap(x -> toIPv6(x), ${hi})))`);
      }
    }
  }
  return { where: w.join(' AND '), params: bag.params };
}

const T = AD_READ_TABLE;
const TIME_FMT = `formatDateTime(event_time, '%Y/%m/%d %H:%i:%s')`;
const EVENT_COLUMNS = [
  `${TIME_FMT} AS time`,
  'event_id AS eventId',
  'level',
  'level_text AS levelText',
  'provider',
  'computer',
  'toString(record_id) AS recordId',
  'channel',
  'message',
  'account',
  'actor',
  'target',
  'group_name AS `group`',
  'privileged',
  'src_ip_raw AS ip',
  'workstation',
  'reason',
  'ad_domain AS dcDomain',
  'source',
  'log_epoch AS logEpoch',
].join(', ');

const num = (v: unknown) => Number(v) || 0;
const toEvent = (r: Record<string, unknown>): AdChEvent => ({
  time: String(r.time ?? ''),
  eventId: num(r.eventId),
  level: String(r.level ?? ''),
  levelText: String(r.levelText ?? ''),
  provider: String(r.provider ?? ''),
  computer: String(r.computer ?? ''),
  recordId: String(r.recordId ?? ''),
  channel: String(r.channel ?? ''),
  message: String(r.message ?? ''),
  account: String(r.account ?? ''),
  actor: String(r.actor ?? ''),
  target: String(r.target ?? ''),
  group: String(r.group ?? ''),
  privileged: num(r.privileged) === 1,
  ip: String(r.ip ?? ''),
  workstation: String(r.workstation ?? ''),
  reason: String(r.reason ?? ''),
  dcDomain: String(r.dcDomain ?? ''),
  source: String(r.source ?? ''),
  logEpoch: num(r.logEpoch),
});

export interface AdReaderOptions {
  maxSeconds?: number;
  /** 事件名稱(core/adlog.js SECURITY_EVENTS) */
  securityEvents?: Record<number, string>;
  /** 帳號 / 群組異動的動作說明(core/adlog.js ACCOUNT_CHANGES) */
  accountChanges?: Record<number, string>;
}

type Fetch = typeof fetch;

export function createAdChReader(cfg: ClickHouseConfig, fetchImpl: Fetch = fetch, opts: AdReaderOptions = {}): AdChReader {
  const base = clickHouseBase(cfg.url);
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const maxSeconds = Math.min(opts.maxSeconds ?? 25, 50);
  const headers = { 'X-ClickHouse-User': cfg.user, 'X-ClickHouse-Key': cfg.password, 'Content-Type': 'text/plain; charset=utf-8' };
  const SEC = opts.securityEvents ?? {};
  const ACTIONS = opts.accountChanges ?? {};

  async function rows<T>(sql: string, params: Record<string, Param> = {}): Promise<T[]> {
    const u = new URL(base);
    u.pathname = '/';
    for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, paramText(v));
    u.searchParams.set('max_execution_time', String(maxSeconds));
    u.searchParams.set('output_format_json_quote_64bit_integers', '0');
    let text: string;
    try {
      // redirect: 'error':轉址時 X-ClickHouse-Key 會被帶到別的主機,一律不跟隨
      const res = await fetchImpl(u, { method: 'POST', headers, body: `${sql} FORMAT JSONEachRow`, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
      if (!res.ok) throw responseError(res, text);
    } catch (e) {
      if (e instanceof ClickHouseError) throw e;
      throw connectError(e, timeoutMs);
    }
    try {
      return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T);
    } catch {
      // HTTP 200 之後的中途錯誤:不帶錯誤原文(可能含 log 內容)
      throw new ClickHouseError('ClickHouse 查詢中斷', Number(/Code: (\d+)/.exec(text)?.[1]) || undefined, 200);
    }
  }

  const range = (fromMs: number, toMs: number) => adWhere({ fromMs, toMs }, paramBag(), false);

  return {
    async days() {
      const r = await rows<{ day: string; events: number; agent: number; ftp: number; computers: string[] }>(
        `SELECT formatDateTime(toDate(event_time), '%Y/%m/%d') AS day, count() AS events, countIf(source = 'agent') AS agent, countIf(source = 'ftp') AS ftp, arraySort(groupUniqArray(computer)) AS computers
         FROM ${T} GROUP BY day ORDER BY day DESC LIMIT 400`,
      );
      return r.map((x) => ({ day: x.day, events: num(x.events), agent: num(x.agent), ftp: num(x.ftp), computers: x.computers ?? [] }));
    },

    async overview(fromMs, toMs, topN) {
      const { where, params } = range(fromMs, toMs);
      const top = Math.max(1, Math.min(topN, 100));
      const fail = `event_id IN [${FAIL_IDS.join(',')}]`;
      const keyTop = (col: string, extra: string) =>
        rows<{ key: string; n: number }>(`SELECT ${col} AS key, count() AS n FROM ${T} WHERE ${where} AND ${fail} AND ${col} != '' ${extra} GROUP BY key ORDER BY n DESC, key LIMIT ${top}`, params);
      const [lv, hours, groups, failAccounts, failIps, failReasons, changes, changeCounts, privLogons] = await Promise.all([
        rows<{ channel: string; level: string; n: number; tmin: string; tmax: string }>(
          `SELECT channel, level, count() AS n, formatDateTime(min(event_time), '%Y/%m/%d %H:%i:%s') AS tmin, formatDateTime(max(event_time), '%Y/%m/%d %H:%i:%s') AS tmax FROM ${T} WHERE ${where} GROUP BY channel, level`,
          params,
        ),
        rows<{ hour: string; n: number; issue: number }>(
          `SELECT formatDateTime(toStartOfHour(event_time), '%Y/%m/%d %H') AS hour, count() AS n, countIf(is_issue = 1) AS issue FROM ${T} WHERE ${where} GROUP BY hour ORDER BY hour`,
          params,
        ),
        rows<{ channel: string; eventId: number; level: string; provider: string; n: number; first: string; last: string; sample: string; computers: string[]; issue: number }>(
          `SELECT channel, event_id AS eventId, level, provider, count() AS n,
                  formatDateTime(min(event_time), '%Y/%m/%d %H:%i:%s') AS first, formatDateTime(max(event_time), '%Y/%m/%d %H:%i:%s') AS last,
                  substringUTF8(splitByChar('\\n', argMax(message, (event_time, record_id)))[1], 1, 120) AS sample,
                  arraySort(groupUniqArray(computer)) AS computers, max(is_issue) AS issue
           FROM ${T} WHERE ${where} GROUP BY channel, event_id, level, provider ORDER BY n DESC, channel, event_id, level, provider LIMIT 5000`,
          params,
        ),
        keyTop('account', ''),
        keyTop('src_ip_raw', ''),
        keyTop('reason', ''),
        rows<Record<string, unknown>>(
          `SELECT ${TIME_FMT} AS time, event_id AS eventId, actor, target, group_name AS \`group\`, privileged, computer, toString(record_id) AS recordId
           FROM ${T} WHERE ${where} AND event_id IN [${ACCOUNT_CHANGE_IDS.join(',')}]
           ORDER BY privileged DESC, (event_id IN [${IMPORTANT_CHANGE_IDS.join(',')}]) DESC, event_time DESC LIMIT 300`,
          params,
        ),
        rows<{ priv: number; created: number }>(
          `SELECT countIf(privileged = 1) AS priv, countIf(event_id = 4720) AS created FROM ${T} WHERE ${where} AND event_id IN [${ACCOUNT_CHANGE_IDS.join(',')}]`,
          params,
        ),
        rows<{ key: string; n: number }>(
          `SELECT actor AS key, count() AS n FROM ${T} WHERE ${where} AND event_id = 4672 AND actor != '' AND NOT match(actor, '(?i)(\\\\$$|^(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$)') GROUP BY key ORDER BY n DESC, key LIMIT ${top}`,
          params,
        ),
      ]);
      // 每個原因前 5 個來源 IP 與帳號
      const reasonKeys = failReasons.map((x) => x.key);
      const detail = async (col: string) => {
        if (!reasonKeys.length) return new Map<string, KeyN[]>();
        const bag = paramBag();
        const { where: w2 } = adWhere({ fromMs, toMs }, bag, false);
        // 每個原因一個 String 參數(不自己組陣列字面值,避免跳脫問題;資安審查 M2)
        const list = `(${reasonKeys.map((k) => bag.p(k, 'String')).join(', ')})`;
        const r = await rows<{ reason: string; key: string; n: number }>(
          `SELECT reason, ${col} AS key, count() AS n FROM ${T} WHERE ${w2} AND ${fail} AND ${col} != '' AND reason IN ${list} GROUP BY reason, key ORDER BY reason, n DESC, key LIMIT 5 BY reason`,
          bag.params,
        );
        const m = new Map<string, KeyN[]>();
        for (const x of r) m.set(x.reason, [...(m.get(x.reason) ?? []), { key: x.key, n: num(x.n) }]);
        return m;
      };
      const [rIps, rAccounts] = await Promise.all([detail('src_ip_raw'), detail('account')]);

      const byChannel: Record<string, number> = {};
      const byLevel: Record<string, number> = {};
      let total = 0;
      let timeMin = '';
      let timeMax = '';
      for (const x of lv) {
        const n = num(x.n);
        total += n;
        byChannel[x.channel] = (byChannel[x.channel] ?? 0) + n;
        byLevel[x.level] = (byLevel[x.level] ?? 0) + n;
        if (!timeMin || x.tmin < timeMin) timeMin = x.tmin;
        if (!timeMax || x.tmax > timeMax) timeMax = x.tmax;
      }
      const all: (AdGroup & { issue: boolean })[] = groups.map((g) => ({
        channel: g.channel,
        eventId: num(g.eventId),
        level: g.level,
        provider: g.provider,
        n: num(g.n),
        first: g.first,
        last: g.last,
        sample: g.sample,
        computers: g.computers ?? [],
        name: g.channel === 'Security' ? (SEC[num(g.eventId)] ?? '') : '',
        issue: num(g.issue) === 1,
      }));
      const strip = ({ issue: _i, ...g }: AdGroup & { issue: boolean }): AdGroup => g;
      const kn = (r: { key: string; n: number }[]) => r.map((x) => ({ key: x.key, n: num(x.n) }));
      return {
        total,
        byChannel,
        byLevel,
        hours: hours.map((h) => ({ hour: h.hour, n: num(h.n), issue: num(h.issue) })),
        timeMin,
        timeMax,
        events: all.slice(0, top * 2).map(strip),
        issues: all.filter((g) => g.issue).slice(0, top).map(strip),
        failAccounts: kn(failAccounts),
        failIps: kn(failIps),
        failReasons: kn(failReasons).map((x) => ({ ...x, ips: rIps.get(x.key) ?? [], accounts: rAccounts.get(x.key) ?? [] })),
        accountChanges: changes.map((c) => ({
          time: String(c.time ?? ''),
          eventId: num(c.eventId),
          action: ACTIONS[num(c.eventId)] ?? '',
          actor: String(c.actor ?? ''),
          target: String(c.target ?? ''),
          group: String(c.group ?? ''),
          privileged: num(c.privileged) === 1,
          computer: String(c.computer ?? ''),
          recordId: String(c.recordId ?? ''),
        })),
        privilegedChanges: num(changeCounts[0]?.priv),
        accountsCreated: num(changeCounts[0]?.created),
        privLogons: kn(privLogons),
      };
    },

    async search(f, offset, limit) {
      const { where, params } = adWhere(f);
      const { where: all, params: p2 } = adWhere(f, paramBag(), false);
      const [items, total, scanned] = await Promise.all([
        rows<Record<string, unknown>>(`SELECT ${EVENT_COLUMNS} FROM ${T} WHERE ${where} ORDER BY event_time DESC, computer, channel, record_id DESC LIMIT ${Math.max(0, Math.floor(limit))} OFFSET ${Math.max(0, Math.floor(offset))}`, params),
        rows<{ n: number }>(`SELECT count() AS n FROM ${T} WHERE ${where}`, params),
        rows<{ n: number }>(`SELECT count() AS n FROM ${T} WHERE ${all}`, p2),
      ]);
      return { rows: items.map(toEvent), total: num(total[0]?.n), scanned: num(scanned[0]?.n) };
    },

    async computers(fromMs, toMs) {
      const { where, params } = range(fromMs, toMs);
      const r = await rows<{ computer: string; dcDomain: string; events: number }>(
        `SELECT computer, any(ad_domain) AS dcDomain, count() AS events FROM ${T} WHERE ${where} GROUP BY computer ORDER BY computer LIMIT 200`,
        params,
      );
      return r.map((x) => ({ computer: x.computer, dcDomain: x.dcDomain, events: num(x.events) }));
    },

    async aiMatches(fromMs, toMs, m, limit) {
      const bag = paramBag();
      const { where } = adWhere({ fromMs, toMs }, bag, false);
      const ors: string[] = [];
      const ids = m.eventIds.filter((n) => Number.isInteger(n) && n >= 0 && n <= 65535);
      if (ids.length) ors.push(`event_id IN ${bag.p(`[${[...new Set(ids)].join(',')}]`, 'Array(UInt32)')}`);
      for (const ip of m.ips.slice(0, 20)) {
        const x = bag.p(ip, 'String');
        ors.push(`(src_ip_raw = ${x} OR position(message, ${x}) > 0)`);
      }
      for (const a of m.accounts.slice(0, 20)) {
        const x = bag.p(a.toLowerCase(), 'String');
        ors.push(`(lowerUTF8(account) = ${x} OR lowerUTF8(actor) = ${x} OR lowerUTF8(target) = ${x} OR positionCaseInsensitiveUTF8(message, ${x}) > 0)`);
      }
      if (!ors.length) return { rows: [], total: 0 };
      const w = `${where} AND (${ors.join(' OR ')})`;
      const [items, total] = await Promise.all([
        rows<Record<string, unknown>>(`SELECT ${EVENT_COLUMNS} FROM ${T} WHERE ${w} ORDER BY event_time DESC, record_id DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`, bag.params),
        rows<{ n: number }>(`SELECT count() AS n FROM ${T} WHERE ${w}`, bag.params),
      ]);
      return { rows: items.map(toEvent), total: num(total[0]?.n) };
    },

    async hasIp(fromMs, toMs, ip) {
      const bag = paramBag();
      const { where } = adWhere({ fromMs, toMs }, bag, false);
      const x = bag.p(ip, 'String');
      const r = await rows<{ n: number }>(`SELECT 1 AS n FROM ${T} WHERE ${where} AND (positionCaseInsensitiveUTF8(src_ip_raw, ${x}) > 0 OR positionCaseInsensitiveUTF8(message, ${x}) > 0) LIMIT 1`, bag.params);
      return r.length > 0;
    },

    async reconCounts(fromMs, toMs) {
      const { where, params } = range(fromMs, toMs);
      const r = await rows<AdReconCount>(
        `SELECT computer, channel, count() AS n, countIf(source = 'agent') AS agent, countIf(source = 'ftp') AS ftp FROM ${T}
         WHERE ${where} AND (channel != 'Security' OR event_id IN [${FTP_SECURITY_EVENT_IDS.join(',')}]) GROUP BY computer, channel ORDER BY computer, channel`,
        params,
      );
      return r.map((x) => ({ computer: x.computer, channel: x.channel, n: num(x.n), agent: num(x.agent), ftp: num(x.ftp) }));
    },
  };
}
