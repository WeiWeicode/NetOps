/**
 * 分析儀表板 API(V-b1;docs/API.md §4.5、docs/VIZ-RULES-DESIGN.md §4.4)。邏輯在 service.ts。
 *   GET /v1/pa/insight/traffic   netops.pa.read
 *   GET /v1/pa/insight/threat    netops.pa.read
 */
import type { FastifyPluginAsync } from 'fastify';
import { DAY, looseObject } from '../../shared/schemas.js';
import { INSIGHT_MAX_DAYS, type InsightService } from './service.js';

const QUERY = { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: DAY, to: DAY } } as const;

const insightRoutes: FastifyPluginAsync<{ svc: InsightService }> = async (app, { svc }) => {
  app.get<{ Querystring: { from: string; to: string } }>(
    '/v1/pa/insight/traffic',
    {
      schema: {
        operationId: 'netops.pa-insight.traffic',
        summary: 'PA 分析儀表板:流量',
        description: `一次回流量視角全部圖表的資料:trend(上傳 / 下載 + Session;≤ 2 天每 5 分鐘、≤ 31 天每小時、其他每天)、sankey(來源區域 → App → 目的區域,App 取前 15,其他併「其他」)、topIp(Top 10 頻寬 IP,上傳 / 下載)、topApp(Top 10 App)、allowDeny(≤ 2 天每小時、其他每天)。期間 from / to 含當天,最長 ${INSIGHT_MAX_DAYS} 天;數值 null 表示沒有資料(彙總表最早的格子之前)。ClickHouse 無法使用回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。`,
        tags: ['PA 分析儀表板'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': [
          '場景: 流量儀表板',
          '  當 呼叫 GET /api/netops/pa/insight/traffic?from=2026-11-05&to=2026-11-11',
          '  那麼 回應 200',
          '  而且 回應含 trend、sankey、topIp、topApp、allowDeny 與 coverage',
          '  而且 trend 的 sessions 加總等於流量總覽同期間的連線數',
          '',
          '場景: 儀表板期間超過 90 天',
          '  當 呼叫 GET /api/netops/pa/insight/traffic 的期間 91 天',
          '  那麼 回應 400 VALIDATION_FAILED',
        ].join('\n'),
        querystring: QUERY,
        response: { 200: looseObject('流量儀表板(docs/API.md §4.5)') },
      },
    },
    async (req) => svc.traffic(req.query),
  );

  app.get<{ Querystring: { from: string; to: string } }>(
    '/v1/pa/insight/threat',
    {
      schema: {
        operationId: 'netops.pa-insight.threat',
        summary: 'PA 分析儀表板:安全威脅',
        description: `一次回威脅視角全部圖表的資料:score(各嚴重度筆數與前一個同長度期間 prev;資料不足一整期時 prev 為 null)、timeline(依嚴重度)、countries(來源國家,ISO2 給地圖;內網範圍不列、對不到的併「未知」)、topInternalSrc(RFC 1918 內網發起威脅最多的 IP)、topServerDst(伺服器網段在偵測設定 V-c 之前為 null,見 notes)、topNames(Top 10 威脅名稱)。只算 log_type = threat 的筆數,不乘 Repeat Count。期間最長 ${INSIGHT_MAX_DAYS} 天。`,
        tags: ['PA 分析儀表板'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': [
          '場景: 威脅儀表板',
          '  當 呼叫 GET /api/netops/pa/insight/threat?from=2026-11-05&to=2026-11-11',
          '  那麼 回應 200',
          '  而且 countries 每筆有 country、iso2、count,內網範圍不列入',
          '  而且 伺服器網段尚未設定時 topServerDst 為 null 且 notes 有說明',
        ].join('\n'),
        querystring: QUERY,
        response: { 200: looseObject('威脅儀表板(docs/API.md §4.5)') },
      },
    },
    async (req) => svc.threat(req.query),
  );
};

export default insightRoutes;
