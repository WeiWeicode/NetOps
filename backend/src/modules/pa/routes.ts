/**
 * PA 流量總覽(docs/API.md §4.1;舊版 server/routes/palog.js 的 days、summary、options)
 * C3(2026-11-11 需求方決定,ARCHITECTURE D43):只查 ClickHouse,不再讀 FTP 摘要(FTP 只做對帳與補漏)。
 * 只做驗證、權限宣告與格式轉換;查詢在 ch-overview.ts,合併與研判在 core/palog.js(AGENT.md §9)。
 */
import type { FastifyPluginAsync } from 'fastify';
import { dayRangeQuery, looseObject, TOP } from '../../shared/schemas.js';
import { dayOut, dayRange, logTimeOut } from '../../shared/time.js';
import { dataDays, need, trafficOptions, trafficOverview, type ChOverviewDeps } from './ch-overview.js';

/**
 * 資料來源(docs/API.md §4.1):C3 起只有 clickhouse。參數保留只為相容(帶 clickhouse 或不帶都可以);
 * ftp / auto 已移除,帶了回 400
 */
export const SOURCE = { type: 'string', enum: ['clickhouse'], description: '資料來源(只有 clickhouse;可省略)' } as const;

const paRoutes: FastifyPluginAsync<{ ch: ChOverviewDeps }> = async (app, { ch }) => {
  /** 摘要建立狀態(沿用 import 欄位:busy 建立中、failed 1 = 上一輪失敗) */
  const importBrief = () => {
    const b = need(ch).builder.status();
    return { busy: b.busy, failed: b.lastError ? 1 : 0 };
  };

  app.get(
    '/v1/pa/days',
    {
      schema: {
        operationId: 'netops.pa.days',
        summary: 'PA 有資料的日期',
        description:
          'ClickHouse 有 TRAFFIC 資料的日期(新的在前),每天有資料的小時數與筆數;coverage 為最早到最新的日期(正式區保留 30 天,超過保留期限的資料已刪除)。ClickHouse 無法使用回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。',
        tags: ['PA 流量總覽'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': [
          '場景: 列出有資料的日期',
          '  假如 ClickHouse 有 2026-11-11、2026-11-12 的 TRAFFIC',
          '  當 呼叫 GET /api/netops/pa/days',
          '  那麼 回應 200',
          '  而且 days 第一筆的 day 為 "2026-11-12",coverage 為 { from: "2026-11-11", to: "2026-11-12" }',
        ].join('\n'),
        response: { 200: looseObject('{ days: [{ day, files, rows }], coverage, import }') },
      },
    },
    async () => {
      const days = await dataDays(ch, 'traffic');
      // files 沿用舊欄位名稱:有資料的小時數
      return {
        days: days.map((d) => ({ day: d.day, files: d.hours, rows: d.rows })),
        coverage: days.length ? { from: days.at(-1)!.day, to: days[0]!.day } : null,
        import: importBrief(),
      };
    },
  );

  app.get<{ Querystring: { from: string; to?: string; top?: number; source?: string } }>(
    '/v1/pa/overview',
    {
      schema: {
        operationId: 'netops.pa.overview',
        summary: 'PA 流量總覽',
        description:
          '期間內的總筆數、允許 / 阻擋、流量、每小時統計、動作、各項排行與疑似掃描來源(ClickHouse)。筆數與每小時統計來自每小時彙總(含進行中的小時);排行來自 ClickHouse 每小時摘要,只到 topsUntil,topsState 不是 ok 時排行不完整。files 為有資料的小時數(0 = 這段期間沒有資料);missing 大於 0 時排行不完整。coverage 為 ClickHouse 有資料的範圍,partial 為期間有一部分在範圍之前。期間整個在範圍之前回 404 NETOPS_PA_OUT_OF_RETENTION;ClickHouse 無法使用回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。',
        tags: ['PA 流量總覽'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': [
          '場景: 查詢期間總覽',
          '  假如 ClickHouse 有 2026-11-12 的 TRAFFIC',
          '  當 呼叫 GET /api/netops/pa/overview?from=2026-11-12',
          '  那麼 回應 200',
          '  而且 source 為 "clickhouse"、files 為有資料的小時數、hours 的時間為 ISO 8601 +08:00',
          '',
          '場景: 期間有一部分早於 ClickHouse 的資料',
          '  假如 ClickHouse 從 2026-11-11 起有資料',
          '  當 呼叫 GET /api/netops/pa/overview?from=2026-11-10&to=2026-11-11',
          '  那麼 回應 200',
          '  而且 partial 為 true,coverage.from 為 "2026-11-11"',
          '',
          '場景: 超過保留期限',
          '  假如 ClickHouse 從 2026-11-11 起有資料',
          '  當 呼叫 GET /api/netops/pa/overview?from=2026-10-01',
          '  那麼 回應 404 NETOPS_PA_OUT_OF_RETENTION',
          '',
          '場景: 日期格式錯誤',
          '  當 呼叫 GET /api/netops/pa/overview?from=2026/11/02',
          '  那麼 回應 400 VALIDATION_FAILED',
          '',
          '場景: ClickHouse 無法使用',
          '  假如 ClickHouse 連不上',
          '  當 呼叫 GET /api/netops/pa/overview?from=2026-11-12',
          '  那麼 回應 503 NETOPS_CLICKHOUSE_UNAVAILABLE',
        ].join('\n'),
        querystring: dayRangeQuery({ top: TOP, source: SOURCE }),
        response: { 200: looseObject('合併摘要(docs/API.md §4.1)') },
      },
    },
    async (req) => {
      const { from, to } = dayRange(req.query);
      const r = await trafficOverview(ch, from, to, req.query.top ?? 20);
      return {
        ...r,
        from: dayOut(from),
        to: dayOut(to),
        import: importBrief(),
        timeMin: logTimeOut(r.timeMin),
        timeMax: logTimeOut(r.timeMax),
        topsUntil: logTimeOut(r.topsUntil),
        hours: r.hours.map((h) => ({ ...h, hour: logTimeOut(h.hour) })),
      };
    },
  );

  app.get<{ Querystring: { from: string; to?: string; source?: string } }>(
    '/v1/pa/options',
    {
      schema: {
        operationId: 'netops.pa.options',
        summary: 'PA 明細查詢的篩選選項',
        description: '期間內出現過的應用程式、規則、區域與動作(ClickHouse),供明細查詢的下拉選單使用。',
        tags: ['PA 流量總覽'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': ['場景: 取得篩選選項', '  當 呼叫 GET /api/netops/pa/options?from=2026-11-12', '  那麼 回應 200', '  而且 回應含 apps、rules、zones、actions'].join('\n'),
        querystring: dayRangeQuery({ source: SOURCE }),
        response: { 200: looseObject('{ apps, rules, zones, actions }') },
      },
    },
    async (req) => {
      const { from, to } = dayRange(req.query);
      return trafficOptions(ch, from, to);
    },
  );
};

export default paRoutes;
