/**
 * 戰情室 API(WR-1、WR-2,docs/WARROOM-PLAN.md §3):/v1/pa-live/warroom、/v1/pa-live/risk,權限 netops.pa-realtime.read。
 * 只做驗證、權限宣告與格式轉換;聚合在 warroom.ts。回應只有統計與 IP(與 /pa-live/top 同等級),不含原始明細。
 * 不附 IP 對照表 names(SEGMENT-SETTINGS-PLAN §3 D,需求方 2026-11-18 決定,D45 範圍變更):名稱只給 netops.ip-name.read,經 POST /ip-name-lookups 取得。
 */
import type { FastifyPluginAsync } from 'fastify';
import { looseObject } from '../../shared/schemas.js';
import { RISK_MINUTES, WARROOM_MINUTES, type WarroomService } from './warroom.js';

const PERMISSION = 'netops.pa-realtime.read';

const warroomRoutes: FastifyPluginAsync<{ warroom: WarroomService }> = async (app, { warroom }) => {
  app.get<{ Querystring: { minutes?: number } }>(
    '/v1/pa-live/warroom',
    {
      schema: {
        operationId: 'netops.pa-live.warroom',
        summary: '即時監控戰情室:外部來源 → 防火牆 → 內部網段聚合',
        description:
          '最近 minutes 分鐘(1 / 5 / 15,預設 5)的聚合:sources(外部來源,依國家取前 8、連入且阻擋比例 ≥ 50% 的 Top 攻擊 IP 最多 3 個,其餘併成 other;內部互連為 lan)、' +
          'segments(內部網段,依網段設定檔;對不到的內部 IP 併入 unmatched)、links(每條來源 → 網段的每秒 conn / allow / deny / threat 速率)、kpis(denyPerMin、threat5m)、gauge(儀表滿格值)。' +
          '來源與網段的配對由 TRAFFIC 明細計算,一次最多讀 20000 筆;讀不到期間開頭時以實際涵蓋秒數換算(sample.complete 為 false)。國家用離線 GeoIP(DB-IP Lite,geo.attribution 須顯示在畫面)。' +
          '網段設定檔不存在時用內建範例(segmentsSource "example"),格式錯誤時也用範例並標示 "invalid"。結果快取 3 秒(partial 不快取)。Redis 不可用時回 200、partial true、陣列為空並附 message,不回假資料。',
        tags: ['PA 即時監控'],
        'x-permission': PERMISSION,
        'x-gherkin': [
          '場景: 查詢最近 5 分鐘戰情室聚合',
          '  假如 最近 5 分鐘有來自美國的 TRAFFIC 連到伺服器區',
          '  當 呼叫 GET /api/netops/pa-live/warroom?minutes=5',
          '  那麼 回應 200 且 partial 為 false',
          '  而且 sources 有 id 為 "cc:US" 的來源,conn 為 5 分鐘連線數',
          '  而且 links 有 source "cc:US"、segment 為伺服器區 id 的連線,conn 為每秒速率',
          '',
          '場景: 阻擋比例高的 IP 單獨列出',
          '  假如 某外部 IP 在 5 分鐘內被阻擋 10 次以上且阻擋比例 ≥ 50%',
          '  當 呼叫 GET /api/netops/pa-live/warroom',
          '  那麼 sources 有 kind 為 "ip" 的來源,且該次數不再計入所屬國家',
          '',
          '場景: 網段設定檔尚未提供',
          '  假如 資料目錄沒有戰情室設定檔',
          '  當 呼叫 GET /api/netops/pa-live/warroom',
          '  那麼 segmentsSource 為 "example",segments 為範例網段',
          '',
          '場景: Redis 連不上時明確標示',
          '  假如 netops-redis 停止',
          '  當 呼叫 GET /api/netops/pa-live/warroom',
          '  那麼 回應 200 且 partial 為 true',
          '  而且 sources、segments、links 為空陣列,kpis 的值為 null,message 說明原因',
          '',
          '場景: 不支援的期間',
          '  當 呼叫 GET /api/netops/pa-live/warroom?minutes=30',
          '  那麼 回應 400 VALIDATION_FAILED',
        ].join('\n'),
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { minutes: { type: 'integer', enum: [...WARROOM_MINUTES], default: 5 } },
        },
        response: { 200: looseObject('{ generatedAt, minutes, partial, sources, segments, links, kpis, gauge, geo, segmentsSource, sample, message? }(WARROOM-PLAN §3 WR-1)') },
      },
    },
    async (req) => warroom.warroom(req.query.minutes ?? 5),
  );

  app.get<{ Querystring: { minutes?: number } }>(
    '/v1/pa-live/risk',
    {
      schema: {
        operationId: 'netops.pa-live.risk',
        summary: '即時監控戰情室:近一小時高風險統計',
        description:
          '最近 minutes 分鐘(15 / 60,預設 60)的威脅數 threats、TRAFFIC 阻擋數 denies、Critical 數 critical(每分鐘統計,精確)、攻擊來源數 attackSources(合併每分鐘前 200 名的不重複來源數;attackSourcesLowerBound 為 true 時是下限,畫面標示 ≥)、' +
          'topThreats(name、severity、count)、topSources(key、label、country、count、denyRatio)。severity 與 denyRatio 來自威脅明細樣本(最多 5000 筆,樣本內沒有為 null)。' +
          '結果快取 60 秒(partial 不快取)。Redis 不可用時回 200、partial true、數值為 null 並附 message,不回假資料。',
        tags: ['PA 即時監控'],
        'x-permission': PERMISSION,
        'x-gherkin': [
          '場景: 查詢近一小時高風險統計',
          '  假如 最近一小時有 critical 威脅',
          '  當 呼叫 GET /api/netops/pa-live/risk?minutes=60',
          '  那麼 回應 200 且 partial 為 false',
          '  而且 critical 大於 0',
          '  而且 topThreats 依 count 由大到小,每筆有 name、severity、count',
          '',
          '場景: Redis 連不上時明確標示',
          '  假如 netops-redis 停止',
          '  當 呼叫 GET /api/netops/pa-live/risk',
          '  那麼 回應 200 且 partial 為 true,threats 為 null',
        ].join('\n'),
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { minutes: { type: 'integer', enum: [...RISK_MINUTES], default: 60 } },
        },
        response: { 200: looseObject('{ generatedAt, minutes, partial, threats, denies, attackSources, critical, topThreats, topSources, sample, message? }(WARROOM-PLAN §3 WR-2)') },
      },
    },
    async (req) => warroom.risk(req.query.minutes ?? 60),
  );
};

export default warroomRoutes;
