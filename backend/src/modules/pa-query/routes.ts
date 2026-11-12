/**
 * PA 精準查詢 API(C5;docs/API.md §3.3)。權限 netops.pa-query.read,**只給 netops-admin**(CQ7;按鈕 netops.pa-live.query)。
 *   GET  /v1/pa-query/status      能不能送出(執行者、名額、冷卻、管理平面 CPU)
 *   POST /v1/pa-query/jobs        送出(202);被擋 429 NETOPS_PA_QUERY_BUSY + Retry-After
 *   GET  /v1/pa-query/jobs/:id    查結果(本人;10 分鐘內)
 * 查詢與結果是原始明細 → x-audit-level: meta。邏輯在 service.ts。
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { ownerOf } from '../../infra/jobs/index.js';
import { looseObject, TIME } from '../../shared/schemas.js';
import type { PaQueryBody, PaQueryService } from './service.js';

const PERMISSION = 'netops.pa-query.read';
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

async function withRetry<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const retry = (err as { retryAfter?: number }).retryAfter;
    if (retry) reply.header('retry-after', String(retry));
    throw err;
  }
}

const paQueryRoutes: FastifyPluginAsync<{ svc: PaQueryService }> = async (app, { svc }) => {
  app.addHook('onClose', async () => svc.close());

  app.get(
    '/v1/pa-query/status',
    {
      schema: {
        operationId: 'netops.pa-query.status',
        summary: 'PA 精準查詢狀態',
        description:
          '畫面決定「查詢即時連線」按鈕能不能按:enabled(netops-pa 有開查詢執行者且心跳 60 秒內)、activeSec(全系統名額被佔用的剩餘秒數)、globalCoolSec、userCoolSec(自己的冷卻)、mgmtCpu(最新管理平面 CPU,% ;輪詢關閉時 null)。Redis 連不上回 424 NETOPS_REDIS_UNAVAILABLE。',
        tags: ['PA 精準查詢'],
        'x-permission': PERMISSION,
        'x-gherkin': ['場景: 查詢 PA 精準查詢狀態', '  當 管理員呼叫 GET /api/netops/pa-query/status', '  那麼 回應 200', '  而且 回應含 enabled、activeSec、userCoolSec、mgmtCpu'].join('\n'),
        response: { 200: looseObject('{ enabled, executor, heartbeatAgeSec, activeSec, globalCoolSec, userCoolSec, mgmtCpu }') },
      },
    },
    async (req) => svc.state(ownerOf(req.identity)),
  );

  app.post<{ Body: PaQueryBody }>(
    '/v1/pa-query/jobs',
    {
      schema: {
        operationId: 'netops.pa-query.submit',
        summary: '送出 PA 精準查詢',
        description:
          '由 netops-pa 向 PA-560 查詢單一 IP:kind=log 查 TRAFFIC / 威脅 log(時間視窗 ≤ 15 分鐘、結束在 1 小時內、nlogs ≤ 500);kind=session 查當下連線(Session Browser,最多 500 筆)。全系統同時 1 個、全域間隔 10 秒、每人冷卻 60 秒,管理平面 CPU 超過 50% 不送;被擋回 429 NETOPS_PA_QUERY_BUSY(Retry-After、details.retryAfter)。執行者未啟用回 409 NETOPS_PA_QUERY_DISABLED。回 202 與工作,之後以 GET /pa-query/jobs/{id} 輪詢(每 2 秒)。',
        tags: ['PA 精準查詢'],
        'x-permission': PERMISSION,
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 送出 PA 精準查詢',
          '  假如 netops-pa 已開查詢執行者,沒有其他查詢在執行',
          '  當 管理員呼叫 POST /api/netops/pa-query/jobs 帶 kind "session" 與 ip "10.10.130.124"',
          '  那麼 回應 202 與工作 id',
          '',
          '場景: 同時第 2 個查詢',
          '  假如 已有 PA 精準查詢在執行',
          '  當 另一位管理員呼叫 POST /api/netops/pa-query/jobs',
          '  那麼 回應 429 NETOPS_PA_QUERY_BUSY',
          '  而且 回應標頭有 Retry-After',
          '',
          '場景: 時間視窗超過 15 分鐘',
          '  當 呼叫 POST /api/netops/pa-query/jobs 帶 kind "log" 且 to − from 為 16 分鐘',
          '  那麼 回應 400 VALIDATION_FAILED',
          '',
          '場景: 管理平面 CPU 過高',
          '  假如 PA-560 最新的管理平面 CPU 為 60%',
          '  當 呼叫 POST /api/netops/pa-query/jobs',
          '  那麼 回應 429 NETOPS_PA_QUERY_BUSY,不送出查詢',
          '',
          '場景: 查詢執行者未啟用',
          '  假如 netops-pa 沒有開查詢執行者',
          '  當 呼叫 POST /api/netops/pa-query/jobs',
          '  那麼 回應 409 NETOPS_PA_QUERY_DISABLED',
        ].join('\n'),
        body: {
          type: 'object',
          required: ['kind', 'ip'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['log', 'session'] },
            ip: { type: 'string', maxLength: 45, pattern: '^[0-9A-Fa-f:.]+$' },
            logType: { type: 'string', enum: ['traffic', 'threat'] },
            from: TIME,
            to: TIME,
            nlogs: { type: 'integer', minimum: 1, maximum: 500 },
            direction: { type: 'string', enum: ['src', 'dst'] },
          },
        },
        response: { 202: looseObject('PA 精準查詢工作(docs/API.md §3.3)') },
      },
    },
    async (req, reply) => withRetry(reply, async () => reply.status(202).send(await svc.submit(ownerOf(req.identity), req.body))),
  );

  app.get<{ Params: { id: string } }>(
    '/v1/pa-query/jobs/:id',
    {
      schema: {
        operationId: 'netops.pa-query.get',
        summary: 'PA 精準查詢結果',
        description:
          '工作狀態 status:queued、running、done(result.rows,欄位同 Log 明細或 Session)、failed(error.code:NETOPS_PA_QUERY_TIMEOUT 逾時 60 秒已取消、NETOPS_PA_QUERY_FAILED、NETOPS_PA_QUERY_EXPIRED 等)、rejected(送出前管理平面 CPU 過高或讀不到,沒有查 PA)。只有建立者本人可查,10 分鐘後或別人的工作回 404 NETOPS_PA_QUERY_NOT_FOUND。',
        tags: ['PA 精準查詢'],
        'x-permission': PERMISSION,
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 查詢 PA 精準查詢結果',
          '  假如 管理員送出的查詢已完成',
          '  當 呼叫 GET /api/netops/pa-query/jobs/{id}',
          '  那麼 回應 200,status 為 "done",result.rows 為查到的紀錄',
          '',
          '場景: 別人的 PA 查詢',
          '  當 另一位使用者查詢同一個 id',
          '  那麼 回應 404 NETOPS_PA_QUERY_NOT_FOUND',
        ].join('\n'),
        params: ID,
        response: { 200: looseObject('PA 精準查詢工作(docs/API.md §3.3)') },
      },
    },
    async (req) => svc.job(ownerOf(req.identity), req.params.id),
  );
};

export default paQueryRoutes;
