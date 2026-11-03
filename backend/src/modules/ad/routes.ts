/**
 * AD 事件總覽、明細查詢與匯出(docs/API.md §6;舊版 server/routes/ad.js 的 days、summary、events)
 * 資料已在本機,查詢不掃 FTP,維持同步回應。
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { AppError } from '../../errors.js';
import { toCsv } from '../../shared/csv.js';
import { dayRangeQuery, looseObject, TIME } from '../../shared/schemas.js';
import { dayOut, dayRange, logTimeOut, timeIn, validation } from '../../shared/time.js';
import { CHANNELS, SECURITY_EVENTS } from './core/adlog.js';
import type { AdEvent, AdFilter, AdImporter } from './importer.js';

/** 明細查詢期間上限(天) */
export const AD_MAX_DAYS = 31;
/** 匯出筆數上限 */
export const AD_EXPORT_MAX = 20000;

/** 等級的中文名稱(同舊版畫面) */
const LEVEL_LABELS: Record<string, string> = { critical: '重大', error: '錯誤', warning: '警告', audit_failure: '稽核失敗', audit_success: '稽核成功', info: '資訊' };

const eventOut = (e: AdEvent) => ({ ...e, time: logTimeOut(e.time) });

interface EventQuery extends AdFilter {
  from: string;
  to: string;
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
};

const AUDIT = 'meta' as const;

const adRoutes: FastifyPluginAsync<{ ad: AdImporter }> = async (app, { ad }) => {
  /** 期間(時間)→ 核心格式;最長 AD_MAX_DAYS 天 */
  const timeRange = (q: { from: string; to: string }) => {
    const from = timeIn(q.from, 'from');
    const to = timeIn(q.to, 'to');
    if (to < from) throw validation('to', '結束時間不可早於開始時間');
    if (Date.parse(q.to) - Date.parse(q.from) > AD_MAX_DAYS * 86400_000) throw validation('to', `查詢期間最長 ${AD_MAX_DAYS} 天`);
    return { from, to };
  };
  const filters = (q: EventQuery): AdFilter => ({ channel: q.channel, level: q.level, eventId: q.eventId, q: q.q, account: q.account, ip: q.ip, issueOnly: q.issueOnly === true });

  app.get(
    '/v1/ad/days',
    {
      schema: {
        operationId: 'netops.ad.days',
        summary: 'AD 已匯入的日期',
        description: '已匯入的 AD 事件日期(新的在前)、每天的筆數與檔案,附同步狀態、記錄類別與常見 Security 事件名稱。',
        tags: ['AD 事件'],
        'x-permission': 'netops.ad.read',
        'x-gherkin': ['場景: 列出已匯入的日期', '  當 呼叫 GET /api/netops/ad/days', '  那麼 回應 200', '  而且 回應含 days、channels、securityEvents'].join('\n'),
        response: { 200: looseObject('{ days, import, channels, securityEvents }') },
      },
    },
    async () => {
      const st = ad.status();
      return {
        days: ad.days().map((d) => ({ ...d, day: dayOut(d.day) })),
        import: { running: st.running, lastSyncAt: st.lastSyncAt, lastSyncError: st.lastSyncError },
        channels: CHANNELS,
        securityEvents: SECURITY_EVENTS,
      };
    },
  );

  app.get<{ Querystring: { from: string; to?: string } }>(
    '/v1/ad/overview',
    {
      schema: {
        operationId: 'netops.ad.overview',
        summary: 'AD 事件總覽',
        description: '期間內 AD 事件的統計:各記錄 / 等級數量、每小時、事件排行、需要注意的事件、登入失敗的帳號 / IP / 原因、帳號與特權異動、特權登入。days 少於期間天數表示有日期沒有資料。',
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
      const s = ad.summary(from, to) as Record<string, unknown> & {
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
        days: ad.daysInRange(from, to),
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
      schema: {
        operationId: 'netops.ad-log.list',
        summary: 'AD Log 明細查詢',
        description: `依時間與條件(記錄、等級、事件 ID、關鍵字、帳號、IP、只看需要注意的)查詢已匯入的 AD 事件,新的在前、分頁回傳;scanned 為期間內篩選前的總數。期間最長 ${AD_MAX_DAYS} 天。`,
        tags: ['AD 事件'],
        'x-permission': 'netops.ad-log.read',
        'x-audit-level': AUDIT,
        'x-gherkin': [
          '場景: 查詢登入失敗',
          '  當 呼叫 GET /api/netops/ad/events?from=2026-11-02T00:00:00+08:00&to=2026-11-02T23:59:00+08:00&eventId=4625',
          '  那麼 回應 200',
          '  而且 items 的 eventId 都是 4625',
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
        response: { 200: looseObject('{ items, total, page, pageSize, scanned }') },
      },
    },
    async (req) => {
      const { from, to } = timeRange(req.query);
      const page = req.query.page ?? 1;
      const pageSize = req.query.pageSize ?? 50;
      const { rows, scanned } = ad.search(from, to, filters(req.query));
      return { items: rows.slice((page - 1) * pageSize, page * pageSize).map(eventOut), total: rows.length, page, pageSize, scanned };
    },
  );

  app.get<{ Querystring: EventQuery }>(
    '/v1/ad/events/export',
    {
      schema: {
        operationId: 'netops.ad-log.export',
        summary: 'AD Log 明細匯出',
        description: `與明細查詢相同的條件,下載 CSV(UTF-8 BOM,欄名中文,同舊版畫面匯出的欄位)。上限 ${AD_EXPORT_MAX} 筆,超過回 422 請縮小條件。`,
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
      const { rows } = ad.search(from, to, filters(req.query));
      if (rows.length > AD_EXPORT_MAX) throw new AppError(422, 'NETOPS_EXPORT_TOO_LARGE', `符合的事件有 ${rows.length} 筆,超過匯出上限 ${AD_EXPORT_MAX} 筆,請縮小條件`);
      const channels = CHANNELS as Record<string, string>;
      const header = ['時間', '記錄', '事件 ID', '等級', '來源', '主機', '帳號', '執行者', '對象', '群組', '來源 IP', '工作站', '原因', '訊息'];
      const lines = rows.map((e) => [logTimeOut(e.time), channels[e.channel] ?? e.channel, e.eventId, LEVEL_LABELS[e.level] ?? e.level, e.provider, e.computer, e.account ?? '', e.actor ?? '', e.target ?? '', e.group ?? '', e.ip ?? '', e.workstation ?? '', e.reason ?? '', e.message]);
      const name = `AD_log_${from.replace(/\D/g, '')}_${to.replace(/\D/g, '')}.csv`;
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(toCsv(header, lines));
    },
  );
};

export default adRoutes;
