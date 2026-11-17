/**
 * 戰情室 AI 每小時分析 API(WR-3,docs/WARROOM-PLAN.md §3 WR-3、§6 Q4):
 *   GET  /v1/ai/hourly-insight      最新一筆(只留最新,沒有 hour 參數);權限 netops.pa-realtime.read(看得到戰情室就看得到分析)
 *   POST /v1/ai/hourly-insight/run  手動分析,SSE 逐字回傳(沿用 sse.ts);權限 netops.ai.use(畫面按鈕 netops.pa-live.ai)
 * 只做驗證、權限宣告與格式轉換;排程與執行在 hourly-insight.ts。
 */
import type { FastifyPluginAsync } from 'fastify';
import { looseObject } from '../../shared/schemas.js';
import type { HourlyInsight } from './hourly-insight.js';
import { SSE_TIMEOUT_MS, type SseHub } from './sse.js';

const hourlyRoutes: FastifyPluginAsync<{ hourly: HourlyInsight; hub: SseHub }> = async (app, { hourly, hub }) => {
  app.get(
    '/v1/ai/hourly-insight',
    {
      schema: {
        operationId: 'netops.ai.hourly-insight',
        summary: '戰情室 AI 每小時分析:最新一筆',
        description:
          '每整點(台北時間)自動分析上一個整點的戰情室彙整統計(WR-1、WR-2,只送統計不送原始 log),或手動分析這個整點到現在;只保留最新一筆。' +
          '回應 { enabled, status(none、done、failed), running, hour(分析區間開始,台北時間 ISO), until, text, model, trigger(auto、manual), partial, statsMinutes(送給模型的統計視窗:流量 15、高風險 60 分鐘), at, error, cooldownUntil }。整點後 5 分鐘內才補跑上一小時。' +
          'status failed 時 error 為分類過的原因(畫面顯示「本小時分析失敗」);AI 主機不可用不影響其他 API。',
        tags: ['AI'],
        'x-permission': 'netops.pa-realtime.read',
        'x-gherkin': [
          '場景: 讀取最新一筆分析',
          '  假如 09:00 的自動分析已完成',
          '  當 呼叫 GET /api/netops/ai/hourly-insight',
          '  那麼 回應 200',
          '  而且 status 為 "done"、trigger 為 "auto"、hour 為 "…T09:00:00+08:00"、text 為分析內容',
          '',
          '場景: 還沒有任何分析',
          '  當 呼叫 GET /api/netops/ai/hourly-insight',
          '  那麼 回應 200 且 status 為 "none"、text 為 null',
          '',
          '場景: AI 主機無法使用',
          '  假如 整點自動分析時 AI 主機連不上',
          '  當 呼叫 GET /api/netops/ai/hourly-insight',
          '  那麼 status 為 "failed",error.code 為 "NETOPS_AI_UNAVAILABLE"',
        ].join('\n'),
        response: { 200: looseObject('{ enabled, status, running, hour, until, text, model, trigger, partial, at, error, cooldownUntil }') },
      },
    },
    async () => hourly.status(),
  );

  app.post(
    '/v1/ai/hourly-insight/run',
    {
      schema: {
        operationId: 'netops.ai.hourly-insight-run',
        summary: '戰情室 AI 每小時分析:立即分析',
        description:
          '手動分析這個整點到現在(統計取最近 60 分鐘),結果覆蓋最新一筆。SSE:open、meta({ hour, until, trigger, model, partial })、thinking、content({ text })、done、error、heartbeat。' +
          '同一時間只跑一個(含自動排程),進行中回 409 NETOPS_AI_HOURLY_BUSY;手動全系統冷卻 5 分鐘,冷卻中回 429 NETOPS_AI_HOURLY_COOLDOWN(details 帶 retryAfterSec);' +
          '沒有 LLM_URL 或 NETOPS_AI_HOURLY=0 回 503 NETOPS_AI_NOT_CONFIGURED。',
        tags: ['AI'],
        'x-permission': 'netops.ai.use',
        'x-timeout-ms': SSE_TIMEOUT_MS,
        'x-gherkin': [
          '場景: 手動立即分析',
          '  假如 使用者有 netops.ai.use 且 5 分鐘內沒有人手動分析過',
          '  當 呼叫 POST /api/netops/ai/hourly-insight/run',
          '  那麼 回應 200 text/event-stream,依序收到 open、meta、content、done',
          '  而且 GET /api/netops/ai/hourly-insight 的 trigger 為 "manual"',
          '',
          '場景: 冷卻中',
          '  假如 3 分鐘前有人手動分析過',
          '  當 呼叫 POST /api/netops/ai/hourly-insight/run',
          '  那麼 回應 429 NETOPS_AI_HOURLY_COOLDOWN',
          '',
          '場景: 分析進行中',
          '  假如 整點自動分析正在執行',
          '  當 呼叫 POST /api/netops/ai/hourly-insight/run',
          '  那麼 回應 409 NETOPS_AI_HOURLY_BUSY',
          '',
          '場景: 沒有 AI 權限',
          '  假如 使用者只有 netops.pa-realtime.read',
          '  當 呼叫 POST /api/netops/ai/hourly-insight/run',
          '  那麼 回應 403',
        ].join('\n'),
        response: {
          200: { description: 'SSE 串流(text/event-stream):open、meta、thinking、content、done、error、heartbeat', content: { 'text/event-stream': { schema: { type: 'string' } } } },
        },
      },
    },
    async (req, reply) => {
      const owner = hub.reserve(req);
      const run = hourly.reserveManual();
      return hub.open(req, reply, owner, (s) => run(s));
    },
  );
};

export default hourlyRoutes;
