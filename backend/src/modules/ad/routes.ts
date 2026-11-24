/**
 * AD 事件總覽、明細查詢與匯出(docs/API.md §6;舊版 server/routes/ad.js 的 days、summary、events)
 * 資料來源依 NETOPS_AD_SOURCE(AD-3,source.ts):ftp = 本機 adlogs(預設);clickhouse = netops.ad_events。都不掃 FTP,維持同步回應。
 * AD-3 另加:GET /v1/ad/agents(DC Agent 心跳狀態)、明細的 computer / dcDomain / name 條件、總覽與明細附 IP 對照表 names(AC3)。
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { AppError } from '../../errors.js';
import type { AdStatusRedis } from '../../infra/redis/ad-status.js';
import { toCsv } from '../../shared/csv.js';
import { dayRangeQuery, looseObject, TIME } from '../../shared/schemas.js';
import { dayOut, dayRange, logTimeOut, timeIn, validation } from '../../shared/time.js';
import { groupAgentEvents, summarizeAgents, toAgentStatus } from './agents.js';
import { CHANNEL_EVENTS, CHANNELS, SECURITY_EVENTS } from './core/adlog.js';
import type { AdFilter, AdImporter } from './importer.js';
import type { AdOutEvent, AdQuery, AdQuerySource } from './source.js';

/** 明細查詢期間上限(天) */
export const AD_MAX_DAYS = 31;
/** 匯出筆數上限 */
export const AD_EXPORT_MAX = 20000;
/** 名稱反查的 IP 範圍上限(同 PA Log 明細) */
export const AD_NAME_RANGE_MAX = 1000;

/** 等級的中文名稱(同舊版畫面) */
const LEVEL_LABELS: Record<string, string> = { critical: '重大', error: '錯誤', warning: '警告', audit_failure: '稽核失敗', audit_success: '稽核成功', info: '資訊' };

const eventOut = (e: AdOutEvent) => ({ ...e, time: logTimeOut(e.time) });

interface EventQuery extends AdFilter {
  from: string;
  to: string;
  computer?: string;
  dcDomain?: string;
  name?: string;
  page?: number;
  pageSize?: number;
}

const filterProps = {
  from: TIME,
  to: TIME,
  channel: { type: 'string', maxLength: 50 },
  level: { type: 'string', maxLength: 30 },
  eventId: { type: 'string', maxLength: 200, pattern: '^[\\d,\\s]*$', description: '逗號分隔多個' },
  q: { type: 'string', maxLength: 200 },
  account: { type: 'string', maxLength: 100 },
  ip: { type: 'string', maxLength: 100 },
  issueOnly: { type: 'boolean', description: '只看需要注意的事件' },
  computer: { type: 'string', maxLength: 64, pattern: '^[\\w.-]*$', description: 'DC 主機名(例 GSMC-DC1;不分大小寫、忽略網域後段)' },
  dcDomain: { type: 'string', maxLength: 253, pattern: '^[\\w.-]*$', description: 'DC 所屬網域(例 gsmc.com.tw)' },
  name: { type: 'string', maxLength: 100, description: 'IP 對照表的使用者姓名、部門或設備名稱(包含),換成來源 IP 範圍後查' },
};

const AUDIT = 'meta' as const;

export interface AdRouteOptions {
  ad: AdImporter;
  /** 查詢來源(NETOPS_AD_SOURCE) */
  source: AdQuerySource;
  /** DC Agent 心跳(netops-redis);null = 沒有 Redis(GET /ad/agents 回 424) */
  status: AdStatusRedis | null;
  heartbeat: { staleSec: number; offlineSec: number };
  now?: () => number;
}

const redisDown = () => new AppError(424, 'NETOPS_REDIS_UNAVAILABLE', 'netops-redis 暫時無法使用');

const adRoutes: FastifyPluginAsync<AdRouteOptions> = async (app, { ad, source, status, heartbeat, now = Date.now }) => {
  /** 期間(時間)→ 核心格式;最長 AD_MAX_DAYS 天 */
  const timeRange = (q: { from: string; to: string }) => {
    const from = timeIn(q.from, 'from');
    const to = timeIn(q.to, 'to');
    if (to < from) throw validation('to', '結束時間不可早於開始時間');
    if (Date.parse(q.to) - Date.parse(q.from) > AD_MAX_DAYS * 86400_000) throw validation('to', `查詢期間最長 ${AD_MAX_DAYS} 天`);
    return { from, to };
  };
  /** 條件 → 查詢;name 先換成 IP 範圍(AC3;關鍵字不寫日誌) */
  const filters = (q: EventQuery): AdQuery => {
    const f: AdQuery = {
      channel: q.channel,
      level: q.level,
      eventId: q.eventId,
      q: q.q,
      account: q.account,
      ip: q.ip,
      issueOnly: q.issueOnly === true,
      computer: q.computer || undefined,
      dcDomain: q.dcDomain || undefined,
    };
    if (q.name?.trim()) {
      const m = app.ipNames.match(q.name);
      if (!m.entries) throw validation('name', 'IP 對照表沒有符合的使用者姓名、部門或設備名稱');
      if (m.ranges.length > AD_NAME_RANGE_MAX) throw validation('name', `符合的 IP 範圍超過 ${AD_NAME_RANGE_MAX} 個,請縮小關鍵字`);
      f.ipRanges = m.ranges;
    }
    return f;
  };

  /** DC Agent 狀態(GET /ad/agents 與 days 的摘要共用) */
  async function agents() {
    if (!status) throw redisDown();
    let raw;
    try {
      raw = await Promise.all([status.heartbeats(), status.agentEvents()]);
    } catch (e) {
      throw Object.assign(redisDown(), { cause: e });
    }
    const [hbs, evs] = raw;
    const t = now();
    const byDc = groupAgentEvents(evs, t);
    const items = hbs.map((hb) => toAgentStatus(hb, byDc.get(hb.computer) ?? [], { now: t, staleSec: heartbeat.staleSec, offlineSec: heartbeat.offlineSec }));
    return { items, summary: summarizeAgents(items) };
  }

  app.get(
    '/v1/ad/agents',
    {
      schema: {
        operationId: 'netops.ad.agents',
        summary: 'DC Agent 即時狀態',
        description:
          '列出所有回報過的 DC(網域控制站)AD Agent / Watchdog 最新心跳:state(ok 正常;stale 超過 staleSec 秒沒有心跳,畫面顯示「停止更新」;offline 超過 offlineSec 秒,判定離線;unknown 沒有心跳)、Agent 服務狀態與資源、各記錄最新 RecordID 與世代、Security Log 容量與 wrapRisk、最近 24 小時的 Watchdog 事件(每台最多 20 筆)。內容是 DC 回報的資料,只回白名單欄位。與資料來源設定無關(只讀 netops-redis);netops-redis 無法使用回 424 NETOPS_REDIS_UNAVAILABLE。',
        tags: ['AD 事件'],
        'x-permission': 'netops.ad.read',
        'x-gherkin': [
          '場景: 列出 DC Agent 狀態',
          '  假如 GSMC-DC1 在 30 秒前送過心跳',
          '  當 呼叫 GET /api/netops/ad/agents',
          '  那麼 回應 200',
          '  而且 items 有 GSMC-DC1、state 為 ok',
          '',
          '場景: 心跳逾時',
          '  假如 GSMC-DC1 最後心跳在 200 秒前',
          '  當 呼叫 GET /api/netops/ad/agents',
          '  那麼 GSMC-DC1 的 state 為 offline',
          '',
          '場景: Redis 無法使用',
          '  當 netops-redis 停止時呼叫 GET /api/netops/ad/agents',
          '  那麼 回應 424 NETOPS_REDIS_UNAVAILABLE',
        ].join('\n'),
        response: { 200: looseObject('{ items, summary, staleSec, offlineSec, source }') },
      },
    },
    async () => ({ ...(await agents()), staleSec: heartbeat.staleSec, offlineSec: heartbeat.offlineSec, source: source.kind }),
  );

  app.get(
    '/v1/ad/days',
    {
      schema: {
        operationId: 'netops.ad.days',
        summary: 'AD 已有資料的日期',
        description:
          '有資料的 AD 事件日期(新的在前)與每天的筆數,附同步狀態、記錄類別與常見 Security 事件名稱。source 為資料來源(NETOPS_AD_SOURCE):ftp 時 days 含匯入的檔案(files、importedAt);clickhouse 時 days 含 agent / ftp 筆數與 computers,並附 agents(DC Agent 狀態摘要,Redis 無法使用時為 null)。ClickHouse 無法使用回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。',
        tags: ['AD 事件'],
        'x-permission': 'netops.ad.read',
        'x-gherkin': ['場景: 列出已匯入的日期', '  當 呼叫 GET /api/netops/ad/days', '  那麼 回應 200', '  而且 回應含 source、days、channels、securityEvents'].join('\n'),
        response: { 200: looseObject('{ source, days, import, channels, securityEvents, agents? }') },
      },
    },
    async () => {
      const st = ad.status();
      // clickhouse:附 DC Agent 狀態摘要(Redis 讀不到時為 null,不影響日期清單)
      const agentSummary = source.kind === 'clickhouse' ? await agents().then((a) => a.summary, () => null) : undefined;
      return {
        source: source.kind,
        ...(agentSummary !== undefined ? { agents: agentSummary } : {}),
        days: (await source.days()).map((d) => ({ ...d, day: dayOut(d.day) })),
        // 錯誤細節(可能含 FTP 主機資訊)只給有 FTP 權限的人看(GET /ftp/ad/status)
        import: { running: st.running, lastSyncAt: st.lastSyncAt, lastSyncError: st.lastSyncError ? '同步失敗,詳見 FTP Log 檔案頁' : '' },
        channels: CHANNELS,
        securityEvents: SECURITY_EVENTS,
        channelEvents: CHANNEL_EVENTS,
      };
    },
  );

  app.get<{ Querystring: { from: string; to?: string } }>(
    '/v1/ad/overview',
    {
      config: { ipNames: true },
      schema: {
        operationId: 'netops.ad.overview',
        summary: 'AD 事件總覽',
        description:
          '期間內 AD 事件的統計:各記錄 / 等級數量、每小時、事件排行、需要注意的事件、登入失敗的帳號 / IP / 原因、帳號與特權異動、特權登入。days 少於期間天數表示有日期沒有資料。source 為資料來源(NETOPS_AD_SOURCE);clickhouse 時含今天 Agent 即時送來的事件。附 names(IP 對照表,只含本回應出現的 IP;AC3)。ClickHouse 無法使用回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。',
        tags: ['AD 事件'],
        'x-permission': 'netops.ad.read',
        'x-gherkin': [
          '場景: 查詢期間總覽',
          '  假如 2026-11-02 已匯入 AD 事件',
          '  當 呼叫 GET /api/netops/ad/overview?from=2026-11-02',
          '  那麼 回應 200',
          '  而且 days 為 1、total 大於 0',
        ].join('\n'),
        querystring: dayRangeQuery(),
        response: { 200: looseObject('統計(docs/API.md §6.1)') },
      },
    },
    async (req) => {
      const { from, to } = dayRange(req.query);
      const r = await source.overview(from, to);
      const s = r.summary as unknown as Record<string, unknown> & {
        timeMin: string;
        timeMax: string;
        hours: { hour: string }[];
        events: { first: string; last: string }[];
        issues: { first: string; last: string }[];
        accountChanges: { time: string }[];
      };
      const span = <T extends { first: string; last: string }>(g: T) => ({ ...g, first: logTimeOut(g.first), last: logTimeOut(g.last) });
      return {
        ...s,
        from: dayOut(from),
        to: dayOut(to),
        source: source.kind,
        days: r.days,
        timeMin: logTimeOut(s.timeMin),
        timeMax: logTimeOut(s.timeMax),
        hours: s.hours.map((h) => ({ ...h, hour: logTimeOut(h.hour) })),
        events: s.events.map(span),
        issues: s.issues.map(span),
        accountChanges: s.accountChanges.map((c) => ({ ...c, time: logTimeOut(c.time) })),
      };
    },
  );

  app.get<{ Querystring: EventQuery }>(
    '/v1/ad/events',
    {
      config: { ipNames: true },
      schema: {
        operationId: 'netops.ad-log.list',
        summary: 'AD Log 明細查詢',
        description: `依時間與條件(記錄、等級、事件 ID、關鍵字、帳號、IP、只看需要注意的、DC computer、DC 網域 dcDomain、IP 對照表名稱 name)查詢 AD 事件,新的在前、分頁回傳;scanned 為期間內篩選前的總數。期間最長 ${AD_MAX_DAYS} 天。每筆另有 dcDomain(DC 網域;ftp 來源為空)、source(agent / ftp)、logEpoch(Event Log 世代;ftp 來源為 null)。name 換成 IP 範圍比對來源 IP(對照表沒有符合的回 400,範圍超過 ${AD_NAME_RANGE_MAX} 個回 400)。附 names(IP 對照表)。資料來源依 NETOPS_AD_SOURCE;ClickHouse 無法使用回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。`,
        tags: ['AD 事件'],
        'x-permission': 'netops.ad-log.read',
        'x-audit-level': AUDIT,
        'x-gherkin': [
          '場景: 查詢登入失敗',
          '  當 呼叫 GET /api/netops/ad/events?from=2026-11-02T00:00:00+08:00&to=2026-11-02T23:59:00+08:00&eventId=4625',
          '  那麼 回應 200',
          '  而且 items 的 eventId 都是 4625',
          '',
          '場景: 只看某台 DC',
          '  當 呼叫 GET /api/netops/ad/events 帶 computer=GSMC-DC1',
          '  那麼 items 的 computer 都是 GSMC-DC1(忽略大小寫與網域後段)',
          '',
          '場景: 期間太長',
          '  當 呼叫 GET /api/netops/ad/events 的期間超過 31 天',
          '  那麼 回應 400 VALIDATION_FAILED',
        ].join('\n'),
        querystring: {
          type: 'object',
          required: ['from', 'to'],
          additionalProperties: false,
          properties: { ...filterProps, page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        },
        response: { 200: looseObject('{ items, total, page, pageSize, scanned, source }') },
      },
    },
    async (req) => {
      const { from, to } = timeRange(req.query);
      const page = req.query.page ?? 1;
      const pageSize = req.query.pageSize ?? 50;
      const r = await source.search(from, to, filters(req.query), (page - 1) * pageSize, pageSize);
      return { items: r.items.map(eventOut), total: r.total, page, pageSize, scanned: r.scanned, source: source.kind };
    },
  );

  app.get<{ Querystring: EventQuery }>(
    '/v1/ad/events/export',
    {
      schema: {
        operationId: 'netops.ad-log.export',
        summary: 'AD Log 明細匯出',
        description: `與明細查詢相同的條件,下載 CSV(UTF-8 BOM,欄名中文;舊版畫面匯出的欄位之後加 DC 網域、來源 IP 名稱 / 部門、資料來源)。上限 ${AD_EXPORT_MAX} 筆,超過回 422 請縮小條件。資料來源依 NETOPS_AD_SOURCE;ClickHouse 無法使用回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。`,
        tags: ['AD 事件'],
        'x-permission': 'netops.ad-log.read',
        'x-audit-level': AUDIT,
        'x-gherkin': [
          '場景: 匯出 CSV',
          '  當 呼叫 GET /api/netops/ad/events/export?from=2026-11-02T00:00:00+08:00&to=2026-11-02T23:59:00+08:00',
          '  那麼 回應 200',
          '  而且 Content-Type 為 text/csv',
          '',
          `場景: 超過 ${AD_EXPORT_MAX} 筆`,
          '  當 條件符合的事件超過上限',
          '  那麼 回應 422 NETOPS_EXPORT_TOO_LARGE',
        ].join('\n'),
        querystring: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: filterProps },
        produces: ['text/csv'],
      },
    },
    async (req, reply: FastifyReply) => {
      const { from, to } = timeRange(req.query);
      // 多取一筆即可判斷超過上限;total 是符合條件的總數
      const { items: rows, total } = await source.search(from, to, filters(req.query), 0, AD_EXPORT_MAX + 1);
      if (total > AD_EXPORT_MAX) throw new AppError(422, 'NETOPS_EXPORT_TOO_LARGE', `符合的事件有 ${total} 筆,超過匯出上限 ${AD_EXPORT_MAX} 筆,請縮小條件`);
      const channels = CHANNELS as Record<string, string>;
      // 來源名稱(AC3;以匯出當下的 IP 對照表為準)
      const label = (ip: string | undefined) => {
        const e = ip ? app.ipNames.lookup(ip) : undefined;
        return e ? [e.name || e.device, e.department].filter(Boolean).join(' / ') : '';
      };
      const header = ['時間', '記錄', '事件 ID', '等級', '來源', '主機', '帳號', '執行者', '對象', '群組', '來源 IP', '工作站', '原因', '訊息', 'DC 網域', '來源 IP 名稱 / 部門', '資料來源'];
      const lines = rows.map((e) => [
        logTimeOut(e.time),
        channels[e.channel] ?? e.channel,
        e.eventId,
        LEVEL_LABELS[e.level] ?? e.level,
        e.provider,
        e.computer,
        e.account ?? '',
        e.actor ?? '',
        e.target ?? '',
        e.group ?? '',
        e.ip ?? '',
        e.workstation ?? '',
        e.reason ?? '',
        e.message,
        e.dcDomain,
        label(e.ip),
        e.source === 'agent' ? 'Agent' : 'FTP',
      ]);
      const name = `AD_log_${from.replace(/\D/g, '')}_${to.replace(/\D/g, '')}.csv`;
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(toCsv(header, lines));
    },
  );
};

export default adRoutes;
