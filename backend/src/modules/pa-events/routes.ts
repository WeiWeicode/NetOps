/**
 * PA 安全事件(其他類型 log)總覽(docs/API.md §4.2;舊版 server/routes/paevents.js)
 */
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors.js';
import { dayRangeQuery, looseObject, TOP } from '../../shared/schemas.js';
import { dayOut, dayRange, logTimeOut } from '../../shared/time.js';
import type { EventImporter } from './importer.js';
import { isChEventType } from '../../infra/clickhouse/reader.js';
import { dayRangeMs, eventOverview, pickSource, viaClickHouse, type ChOverviewDeps } from '../pa/ch-overview.js';
import { SOURCE } from '../pa/routes.js';

const paEventRoutes: FastifyPluginAsync<{ events: EventImporter; ch: ChOverviewDeps }> = async (app, { events, ch }) => {
  app.get(
    '/v1/pa-events/types',
    {
      schema: {
        operationId: 'netops.pa-events.types',
        summary: 'PA 安全事件的類型',
        description: '有設定 FTP 目錄的其他類型 log(威脅、URL 過濾、資料過濾、WildFire、解密、GlobalProtect、User-ID),各類型已分析的檔案數、筆數與有資料的日期。',
        tags: ['PA 安全事件'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': ['場景: 列出類型', '  當 呼叫 GET /api/netops/pa-events/types', '  那麼 回應 200', '  而且 types 含 threat'].join('\n'),
        response: { 200: looseObject('{ types: [{ type, label, dir, files, rows, days }] }') },
      },
    },
    async () => ({ types: events.overview().map((t) => ({ ...t, days: t.days.map(dayOut) })) }),
  );

  app.get<{ Querystring: { type: string; from: string; to?: string; top?: number; source?: string } }>(
    '/v1/pa-events/overview',
    {
      schema: {
        operationId: 'netops.pa-events.overview',
        summary: 'PA 安全事件總覽',
        description:
          '某類型 log 期間內的合併摘要:筆數、每小時統計、KPI 與排行。威脅、URL 過濾、資料過濾、WildFire 可查 ClickHouse(C3;source 為 clickhouse 時 files 為有摘要的小時數、只到 topsUntil),解密、GlobalProtect、User-ID 只有 FTP。files 為 0 表示沒有已分析的資料;missing 大於 0 或匯入中時結果不完整。',
        tags: ['PA 安全事件'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': [
          '場景: 查詢威脅總覽',
          '  當 呼叫 GET /api/netops/pa-events/overview?type=threat&from=2026-11-01',
          '  那麼 回應 200',
          '  而且 type 為 "threat"',
          '',
          '場景: 不支援的類型',
          '  當 呼叫 GET /api/netops/pa-events/overview?type=nope&from=2026-11-01',
          '  那麼 回應 400 VALIDATION_FAILED',
          '',
          '場景: 威脅類查 ClickHouse',
          '  假如 ClickHouse 從 2026-11-11 08:00 起有資料,總覽來源設定為 auto',
          '  當 呼叫 GET /api/netops/pa-events/overview?type=threat&from=2026-11-12',
          '  那麼 回應 200',
          '  而且 source 為 "clickhouse"',
          '',
          '場景: 不在 ClickHouse 的類型查 FTP',
          '  當 呼叫 GET /api/netops/pa-events/overview?type=userid&from=2026-11-12',
          '  那麼 回應 200',
          '  而且 source 為 "ftp"',
        ].join('\n'),
        querystring: dayRangeQuery({ type: { type: 'string', maxLength: 20 }, top: TOP, source: SOURCE }, ['type']),
        response: { 200: looseObject('合併摘要(docs/API.md §4.2)') },
      },
    },
    async (req) => {
      const { type } = req.query;
      if (!events.eventTypes().some((t) => t.type === type)) throw new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', [{ field: 'type', message: '不支援的 log 類型' }]);
      const { from, to } = dayRange(req.query);
      // 解密、GlobalProtect、User-ID 不進 ClickHouse(AGENT.md §7.2):一律 FTP
      if (isChEventType(type) && pickSource(ch, req.query.source, dayRangeMs(from, to)[0]) === 'clickhouse') {
        const r = await viaClickHouse(ch, req.query.source, () => eventOverview(ch, type, from, to, req.query.top ?? 20));
        if (r) {
          const b = ch.builder!.status();
          return {
            ...r,
            from: dayOut(from),
            to: dayOut(to),
            import: { busy: b.busy, failed: b.lastError ? 1 : 0 },
            timeMin: logTimeOut(r.timeMin),
            timeMax: logTimeOut(r.timeMax),
            topsUntil: logTimeOut(r.topsUntil),
            hours: r.hours.map((h) => ({ ...h, hour: logTimeOut(h.hour) })),
          };
        }
      }
      const m = events.summary(type, from, to, req.query.top ?? 20) as ReturnType<EventImporter['summary']> & { timeMin: string; timeMax: string; hours: { hour: string; n: number }[] };
      const st = events.status();
      return {
        ...m,
        source: 'ftp',
        from: dayOut(from),
        to: dayOut(to),
        import: { busy: st.busy, failed: st.failed },
        timeMin: logTimeOut(m.timeMin),
        timeMax: logTimeOut(m.timeMax),
        hours: m.hours.map((h) => ({ ...h, hour: logTimeOut(h.hour) })),
      };
    },
  );
};

export default paEventRoutes;
