/**
 * PA 安全事件(其他類型 log)總覽(docs/API.md §4.2;舊版 server/routes/paevents.js)
 * C3(ARCHITECTURE D43):威脅、URL 過濾、資料過濾、WildFire 只查 ClickHouse;解密、GlobalProtect、User-ID
 * 不進 ClickHouse(AGENT.md §7.2),仍是 FTP 摘要。
 */
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors.js';
import { dayRangeQuery, looseObject, TOP } from '../../shared/schemas.js';
import { dayOut, dayRange, logTimeOut } from '../../shared/time.js';
import type { EventImporter } from './importer.js';
import { isChEventType } from '../../infra/clickhouse/reader.js';
import { dataDays, eventOverview, need, type ChOverviewDeps } from '../pa/ch-overview.js';
import { SOURCE } from '../pa/routes.js';

const paEventRoutes: FastifyPluginAsync<{ events: EventImporter; ch: ChOverviewDeps }> = async (app, { events, ch }) => {
  app.get(
    '/v1/pa-events/types',
    {
      schema: {
        operationId: 'netops.pa-events.types',
        summary: 'PA 安全事件的類型',
        description:
          '其他類型 log 的清單與有資料的日期(新的在前)。威脅、URL 過濾、資料過濾、WildFire 為 ClickHouse(source clickhouse;files 為有資料的小時數、rows 為筆數、coverage 為有資料的範圍;ClickHouse 無法使用時這幾個類型 unavailable 為 true、其他照常);解密、GlobalProtect、User-ID 為 FTP 已分析的檔案(source ftp,只列有設定 FTP 目錄的)。',
        tags: ['PA 安全事件'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': ['場景: 列出類型', '  當 呼叫 GET /api/netops/pa-events/types', '  那麼 回應 200', '  而且 types 含 threat'].join('\n'),
        response: { 200: looseObject('{ types: [{ type, label, source, files, rows, days, coverage }] }') },
      },
    },
    async () => {
      const types = [];
      for (const t of events.overview()) {
        if (isChEventType(t.type)) {
          // ClickHouse 失敗時只有這些類型標 unavailable,解密 / GlobalProtect / User-ID(FTP)照常列出(程式碼審查 #4)
          const days = await dataDays(ch, t.type).catch((err) => {
            if ((err as { code?: string }).code === 'NETOPS_CLICKHOUSE_UNAVAILABLE') return null;
            throw err;
          });
          if (!days) {
            types.push({ type: t.type, label: t.label, dir: t.dir, source: 'clickhouse', unavailable: true, files: 0, rows: 0, days: [], coverage: null });
            continue;
          }
          types.push({
            type: t.type,
            label: t.label,
            dir: t.dir,
            source: 'clickhouse',
            files: days.reduce((n, d) => n + d.hours, 0),
            rows: days.reduce((n, d) => n + d.rows, 0),
            days: days.map((d) => d.day),
            coverage: days.length ? { from: days.at(-1)!.day, to: days[0]!.day } : null,
          });
        } else {
          types.push({ ...t, source: 'ftp', days: t.days.map(dayOut), coverage: t.days.length ? { from: dayOut(t.days.at(-1)!), to: dayOut(t.days[0]!) } : null });
        }
      }
      return { types };
    },
  );

  app.get<{ Querystring: { type: string; from: string; to?: string; top?: number; source?: string } }>(
    '/v1/pa-events/overview',
    {
      schema: {
        operationId: 'netops.pa-events.overview',
        summary: 'PA 安全事件總覽',
        description:
          '某類型 log 期間內的合併摘要:筆數、每小時統計、KPI 與排行。威脅、URL 過濾、資料過濾、WildFire 只查 ClickHouse(files 為有摘要的小時數、只到 topsUntil;coverage、partial 同流量總覽;期間整個超過保留期限回 404 NETOPS_PA_OUT_OF_RETENTION;ClickHouse 無法使用回 503),解密、GlobalProtect、User-ID 仍是 FTP 已分析的摘要。files 為 0 表示沒有資料;missing 大於 0 或匯入中時結果不完整。',
        tags: ['PA 安全事件'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': [
          '場景: 查詢威脅總覽',
          '  假如 ClickHouse 有 2026-11-12 的威脅 log',
          '  當 呼叫 GET /api/netops/pa-events/overview?type=threat&from=2026-11-12',
          '  那麼 回應 200',
          '  而且 type 為 "threat"、source 為 "clickhouse"',
          '',
          '場景: 不支援的類型',
          '  當 呼叫 GET /api/netops/pa-events/overview?type=nope&from=2026-11-01',
          '  那麼 回應 400 VALIDATION_FAILED',
          '',
          '場景: 威脅類超過保留期限',
          '  假如 ClickHouse 從 2026-11-11 起有威脅 log',
          '  當 呼叫 GET /api/netops/pa-events/overview?type=threat&from=2026-10-01',
          '  那麼 回應 404 NETOPS_PA_OUT_OF_RETENTION',
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
      // 解密、GlobalProtect、User-ID 不進 ClickHouse(AGENT.md §7.2):FTP;其他只查 ClickHouse
      if (isChEventType(type)) {
        const r = await eventOverview(ch, type, from, to, req.query.top ?? 20);
        const b = need(ch).builder.status();
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
