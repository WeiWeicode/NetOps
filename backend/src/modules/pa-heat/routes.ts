/**
 * 活動熱力圖與時段明細 API(V-a;docs/API.md §4.4、docs/VIZ-RULES-DESIGN.md §4.2、§4.3)。只做驗證、權限宣告與格式轉換,邏輯在 service.ts。
 *   GET    /v1/pa/heatmap         netops.pa.read
 *   GET    /v1/pa/slice           netops.pa-log.read(稽核 meta;x-timeout-ms 40000:同步等 30 秒)
 *   GET    /v1/pa/slices/:id      netops.pa-log.read(稽核 meta)
 *   DELETE /v1/pa/slices/:id      netops.pa-log.read
 */
import type { FastifyPluginAsync } from 'fastify';
import { ownerOf } from '../../infra/jobs/index.js';
import { DAY, looseObject, NO_CONTENT, TIME } from '../../shared/schemas.js';
import { GRANULARITIES, METRICS, type Granularity, type Metric } from './heat.js';
import { SLICE_SYNC_MS, type HeatService, type SliceQuery } from './service.js';

/** 只接受單一 IP 或 CIDR(不接受萬用字元;手冊 §7.4 的 BETWEEN 做法) */
const IP_OR_CIDR = { type: 'string', maxLength: 64, pattern: '^[0-9a-fA-F:.]+(/\\d{1,3})?$' } as const;
const text = (max: number) => ({ type: 'string', maxLength: max, pattern: '^[^\\u0000-\\u001f]*$' });
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

const heatRoutes: FastifyPluginAsync<{ svc: HeatService; syncMs?: number }> = async (app, { svc, syncMs = SLICE_SYNC_MS }) => {
  app.addHook('onClose', async () => svc.close());

  app.get<{ Querystring: { granularity: Granularity; metric: Metric; date?: string } }>(
    '/v1/pa/heatmap',
    {
      schema: {
        operationId: 'netops.pa-heatmap.get',
        summary: 'PA 活動熱力圖',
        description:
          '年(53 週 × 7 天,每天一格)、月(每小時一格)、日(每 5 分鐘一格)的熱力圖。metric:traffic 位元組、deny 非 allow 筆數、threat 威脅加權分數(10×critical + 5×high + 2×medium + 1×low,依最高嚴重度分級);ad 為 AD 階段預留,回 409 NETOPS_HEATMAP_METRIC_UNAVAILABLE。只讀彙總表(每天、每小時保留 5 年,每 5 分鐘 1 年);日視圖超過 1 年回 422 NETOPS_HEATMAP_OUT_OF_RETENTION(details.earliest)。v 為 null 表示沒有資料(彙總表最早的格子之前),和 0 不同;coverage 標示資料起點與 FTP 對帳缺口;tip.topIp 為近似值。',
        tags: ['PA 熱力圖'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': [
          '場景: 月視圖',
          '  假如 ClickHouse 熱力圖彙總有 2026-11 的資料',
          '  當 呼叫 GET /api/netops/pa/heatmap?granularity=month&metric=traffic&date=2026-11-11',
          '  那麼 回應 200',
          '  而且 bucketSeconds 為 3600,cells 只到現在,每格有 t、v、level、partial、tip',
          '',
          '場景: 沒有資料的格子是 null',
          '  假如 彙總表最早的資料是 2026-11-10 15:00',
          '  當 呼叫 GET /api/netops/pa/heatmap?granularity=month&metric=traffic&date=2026-11-11',
          '  那麼 2026-11-10 15:00 之前的格子 v 為 null、level 為 0',
          '  而且 之後沒有流量的格子 v 為 0',
          '',
          '場景: 威脅依最高嚴重度分級',
          '  當 呼叫 GET /api/netops/pa/heatmap?granularity=day&metric=threat',
          '  那麼 有 critical 的格子 level 為 4,v 為 10×critical + 5×high + 2×medium + 1×low',
          '',
          '場景: AD 指標尚未開放',
          '  當 呼叫 GET /api/netops/pa/heatmap?granularity=year&metric=ad',
          '  那麼 回應 409 NETOPS_HEATMAP_METRIC_UNAVAILABLE',
          '',
          '場景: 日視圖超過 1 年',
          '  當 呼叫 GET /api/netops/pa/heatmap?granularity=day&metric=traffic 帶 366 天前的 date',
          '  那麼 回應 422 NETOPS_HEATMAP_OUT_OF_RETENTION',
          '  而且 details.earliest 為最早可查的日期',
        ].join('\n'),
        querystring: {
          type: 'object',
          required: ['granularity', 'metric'],
          additionalProperties: false,
          properties: { granularity: { type: 'string', enum: [...GRANULARITIES] }, metric: { type: 'string', enum: [...METRICS] }, date: DAY },
        },
        response: { 200: looseObject('熱力圖(docs/API.md §4.4)') },
      },
    },
    async (req) => svc.heatmap(req.query),
  );

  app.get<{ Querystring: SliceQuery }>(
    '/v1/pa/slice',
    {
      schema: {
        operationId: 'netops.pa-slice.get',
        summary: 'PA 時段明細(熱力圖格子)',
        description:
          '一個時段(最長 1 天)的摘要、各 Top 10 與最多 200 筆明細(新到舊或依位元組)。30 秒內完成回 200 結果;超過回 202 工作狀態,改用 GET /slices/{id} 輪詢;同一人同條件在 30 分鐘內重送回同一個工作。開始時間早於原始表保留(TRAFFIC 29 天、威脅 89 天;測試區 2 天)的部分要讀冷歸檔:冷歸檔(C4)尚未提供時回 409 NETOPS_COLD_ARCHIVE_DISABLED;冷查詢全系統同時 1 個,忙碌時回 429 NETOPS_COLD_QUERY_BUSY 與 Retry-After。IP 條件只接受單一 IP 或 CIDR。',
        tags: ['PA 熱力圖'],
        'x-permission': 'netops.pa-log.read',
        'x-audit-level': 'meta',
        'x-timeout-ms': 40000,
        'x-gherkin': [
          '場景: 熱資料時段明細',
          '  假如 2026-11-11 08:00–09:00 在 ClickHouse 原始表保留範圍內',
          '  當 呼叫 GET /api/netops/pa/slice?start=2026-11-11T08:00:00%2B08:00&end=2026-11-11T09:00:00%2B08:00',
          '  那麼 回應 200',
          '  而且 source 為 "hot",回應含 summary、top、rows,rows 最多 rows 參數的筆數',
          '',
          '場景: 超過 30 秒轉成工作',
          '  假如 查詢 30 秒內沒有完成',
          '  當 呼叫 GET /api/netops/pa/slice',
          '  那麼 回應 202 與工作狀態',
          '  而且 之後 GET /api/netops/pa/slices/{id} 的 status 會變成 "done",result 為明細',
          '',
          '場景: 同條件重送重用同一個工作',
          '  假如 同一人同條件的工作還在執行',
          '  當 再呼叫一次 GET /api/netops/pa/slice',
          '  那麼 回應同一個工作 id,不重複查詢',
          '',
          '場景: 時段超過 1 天',
          '  當 呼叫 GET /api/netops/pa/slice 的 end − start 超過 1 天',
          '  那麼 回應 400 VALIDATION_FAILED',
          '',
          '場景: 冷資料尚未提供',
          '  假如 冷歸檔(C4)尚未提供',
          '  當 呼叫 GET /api/netops/pa/slice 的 start 早於原始表保留範圍',
          '  那麼 回應 409 NETOPS_COLD_ARCHIVE_DISABLED',
          '',
          '場景: 已有冷查詢在執行',
          '  假如 冷歸檔已提供且已有另一個冷查詢在執行',
          '  當 呼叫 GET /api/netops/pa/slice 查冷資料',
          '  那麼 回應 429 NETOPS_COLD_QUERY_BUSY',
          '  而且 回應標頭有 Retry-After',
        ].join('\n'),
        querystring: {
          type: 'object',
          required: ['start', 'end'],
          additionalProperties: false,
          properties: {
            start: TIME,
            end: TIME,
            type: { type: 'string', enum: ['traffic', 'threat'], default: 'traffic' },
            ip: IP_OR_CIDR,
            src: IP_OR_CIDR,
            dst: IP_OR_CIDR,
            app: text(100),
            fromZone: text(100),
            toZone: text(100),
            dport: { type: 'integer', minimum: 0, maximum: 65535 },
            action: { type: 'string', enum: ['allow', 'block'] },
            country: text(100),
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
            threatName: text(200),
            rows: { type: 'integer', minimum: 0, maximum: 200, default: 100 },
            sort: { type: 'string', enum: ['time', 'bytes'], default: 'time' },
          },
        },
        response: { 200: looseObject('時段明細(docs/API.md §4.4)'), 202: looseObject('工作狀態(docs/API.md §1.1)') },
      },
    },
    async (req, reply) => {
      try {
        const r = await svc.slice(ownerOf(req.identity), req.query, syncMs);
        return reply.status(r.status).send(r.body);
      } catch (err) {
        const retry = (err as { retryAfter?: number }).retryAfter;
        if (retry) reply.header('retry-after', String(retry));
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/pa/slices/:id',
    {
      schema: {
        operationId: 'netops.pa-slice.job-get',
        summary: 'PA 時段明細(查詢工作)',
        description: '時段明細工作的狀態;完成時 result 為明細(格式同 GET /slice 的 200)。別人的工作、已逾期(30 分鐘)或服務重新啟動後回 404 NETOPS_JOB_NOT_FOUND。',
        tags: ['PA 熱力圖'],
        'x-permission': 'netops.pa-log.read',
        'x-audit-level': 'meta',
        'x-gherkin': ['場景: 查詢時段明細工作', '  當 呼叫 GET /api/netops/pa/slices/{id}', '  那麼 回應 200', '  而且 完成時 result 含 summary、top、rows', '', '場景: 別人的時段明細工作', '  當 另一位使用者查詢同一個 id', '  那麼 回應 404 NETOPS_JOB_NOT_FOUND'].join('\n'),
        params: ID,
        response: { 200: looseObject('工作狀態(docs/API.md §1.1)') },
      },
    },
    async (req) => svc.sliceJob(req.params.id, ownerOf(req.identity)),
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/pa/slices/:id',
    {
      schema: {
        operationId: 'netops.pa-slice.cancel',
        summary: '取消 PA 時段明細工作',
        description: '取消自己的時段明細工作;已完成的工作則丟棄結果。已逾期或不存在也回 204(冪等)。',
        tags: ['PA 熱力圖'],
        'x-permission': 'netops.pa-log.read',
        'x-gherkin': ['場景: 取消時段明細工作', '  當 呼叫 DELETE /api/netops/pa/slices/{id}', '  那麼 回應 204', '  而且 再呼叫一次也回 204'].join('\n'),
        params: ID,
        response: NO_CONTENT,
      },
    },
    async (req, reply) => {
      svc.cancelSlice(req.params.id, ownerOf(req.identity));
      return reply.status(204).send();
    },
  );
};

export default heatRoutes;
