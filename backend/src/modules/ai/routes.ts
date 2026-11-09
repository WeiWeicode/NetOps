/**
 * AI 分析、問答(docs/API.md §10;舊版 server/routes/ai.js;IMPL-PLAN A1、ARCHITECTURE D23;翻譯與整理筆記依 2026-11-09 決定不搬,D25)
 *   分析與問答都用 SSE(POST,前端以 fetch 讀串流):掃描 FTP 與模型回答可能超過路由逾時(AGENT.md §7.3),
 *   串流的寫法照 S0 報告 §3.6(sse.ts)。只做驗證、權限宣告與格式轉換;流程在 service.ts。
 * 權限:netops.ai.use(netops-admin、netops-viewer,2026-11-05 決定,D25 維持一個權限)。
 */
import type { FastifyPluginAsync } from 'fastify';
import { looseObject } from '../../shared/schemas.js';
import { dayRange, timeIn, validation } from '../../shared/time.js';
import type { AiService, HistoryItem } from './service.js';
import { SSE_TIMEOUT_MS, type SseHub } from './sse.js';

/** 問答期間上限(天):有 IP 時要從 FTP 重讀原始 log(同明細查詢 §4.3) */
export const ASK_MAX_DAYS = 31;

const SSE_RESPONSE = (events: string) => ({
  200: { description: `SSE 串流(text/event-stream):${events}`, content: { 'text/event-stream': { schema: { type: 'string' } } } },
});
const HISTORY = {
  type: 'array',
  maxItems: 100,
  items: { type: 'object', required: ['role', 'content'], properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string', maxLength: 20000 } } },
  description: '前面的對話(最多 100 則;只送最近 6 則、每則前 4000 字給模型)',
} as const;
const sse = { 'x-timeout-ms': SSE_TIMEOUT_MS } as const;

const aiRoutes: FastifyPluginAsync<{ ai: AiService; hub: SseHub }> = async (app, { ai, hub }) => {
  app.get(
    '/v1/ai/status',
    {
      schema: {
        operationId: 'netops.ai.status',
        summary: 'AI 服務狀態',
        description: '是否已設定 AI 服務、模型是否可連線與模型名稱;畫面依此決定是否顯示 AI 功能。不回傳 AI 主機位址。',
        tags: ['AI'],
        'x-permission': 'netops.ai.use',
        'x-gherkin': ['場景: 查詢 AI 服務狀態', '  假如 使用者擁有 netops.ai.use', '  當 呼叫 GET /api/netops/ai/status', '  那麼 回應 200', '  而且 回應有 enabled、ok、model', '  而且 回應不含 AI 主機位址'].join('\n'),
        response: { 200: looseObject('{ enabled, ok, model, message }') },
      },
    },
    async () => ai.status(),
  );

  app.post<{ Body: { from: string; to?: string; think?: boolean; question?: string } }>(
    '/v1/ai/analyses',
    {
      schema: {
        operationId: 'netops.ai.analyze',
        summary: 'AI 期間分析(SSE)',
        description:
          '把期間內 PA TRAFFIC 摘要(含前一段同長度期間比較)與其他類型 log 摘要整理成文字,連同知識庫筆記送給模型,以 SSE 串流回答。只送統計與彙整,不送原始 log。' +
          '事件:open、meta(model、files、missing、rows、notes、vectorError)、thinking(思考字數)、content(回答片段)、done(finish、truncated)、error、heartbeat(每 15 秒)。' +
          '期間最長 92 天;沒有已分析的 log 回 404 NETOPS_PA_NO_DATA;未設定 AI 回 409 NETOPS_AI_DISABLED;同時進行的 AI 回答每人 2 個、全系統 6 個,超過回 429 NETOPS_STREAM_BUSY。',
        tags: ['AI'],
        'x-permission': 'netops.ai.use',
        'x-audit-level': 'meta',
        ...sse,
        'x-gherkin': [
          '場景: 期間分析以 SSE 串流回答',
          '  假如 使用者擁有 netops.ai.use',
          '  而且 2026-11-02 有已分析的 TRAFFIC 檔案',
          '  當 呼叫 POST /api/netops/ai/analyses 帶 from "2026-11-02"',
          '  那麼 回應 200 且 Content-Type 為 text/event-stream',
          '  而且 回應標頭 X-Accel-Buffering 為 "no"',
          '  而且 依序收到 open、meta、content、done 事件',
          '',
          '場景: 期間沒有已分析的 log',
          '  當 呼叫 POST /api/netops/ai/analyses 帶 from "2026-12-01"',
          '  那麼 回應 404 NETOPS_PA_NO_DATA',
          '',
          '場景: AI 回答數量已達上限',
          '  假如 使用者已有 2 個進行中的 AI 回答',
          '  當 再呼叫 POST /api/netops/ai/analyses',
          '  那麼 回應 429 NETOPS_STREAM_BUSY',
        ].join('\n'),
        body: {
          type: 'object',
          required: ['from'],
          additionalProperties: false,
          properties: {
            from: { type: 'string', description: 'YYYY-MM-DD' },
            to: { type: 'string', description: 'YYYY-MM-DD,省略時等於 from' },
            think: { type: 'boolean', default: false, description: '深入思考(比較久)' },
            question: { type: 'string', maxLength: 1000, description: '另外想了解的問題(選填)' },
          },
        },
        response: SSE_RESPONSE('open、meta、thinking、content、done、error、heartbeat'),
      },
    },
    async (req, reply) => {
      const { from, to } = dayRange(req.body);
      const ctx = ai.prepareAnalysis(from, to);
      const owner = hub.reserve(req);
      return hub.open(req, reply, owner, (s) => ai.analyze(s, { from, to, think: req.body.think === true, question: (req.body.question ?? '').trim() }, ctx));
    },
  );

  app.post<{ Body: { from: string; to: string; question: string; history?: HistoryItem[]; think?: boolean; source?: 'pa' | 'ad' } }>(
    '/v1/ai/questions',
    {
      schema: {
        operationId: 'netops.ai.ask',
        summary: 'AI 問答(SSE)',
        description:
          '依問題中的 IP / Port 查防火牆 log(先查連線組合統計,沒有統計的檔案才從 FTP 串流掃描,原始 log 不落地)並彙整;問到 AD 或 IP 出現在 AD 事件時帶入 AD 事件記錄;連同知識庫筆記送給模型,以 SSE 串流回答。' +
          'source 為 ad 時只看 AD 事件記錄。追問時問題沒有 IP / Port 會沿用前面的條件;同樣的條件 10 分鐘內不重複掃描。' +
          '事件:open、meta(ips、ports、files)、scan(掃描進度)、evidence(matched、partial 掃描逾時資料不完整)、events、ad、notes(used、omitted、vectorError)、thinking、content、done、error、heartbeat。' +
          `期間最長 ${ASK_MAX_DAYS} 天;沒有已分析的 log 且不是 AD 問題回 404 NETOPS_PA_NO_DATA;未設定 AI 回 409 NETOPS_AI_DISABLED;超過同時上限回 429 NETOPS_STREAM_BUSY。`,
        tags: ['AI'],
        'x-permission': 'netops.ai.use',
        'x-audit-level': 'meta',
        ...sse,
        'x-gherkin': [
          '場景: 問題有 IP 時查 log 後回答',
          '  假如 使用者擁有 netops.ai.use',
          '  而且 2026-11-02 有已分析的 TRAFFIC 檔案',
          '  當 呼叫 POST /api/netops/ai/questions 帶時間範圍與問題 "10.10.1.5 為什麼連不到 8.8.8.8"',
          '  那麼 回應 200 且 Content-Type 為 text/event-stream',
          '  而且 meta 事件的 ips 為 ["10.10.1.5", "8.8.8.8"]',
          '  而且 收到 evidence 事件,matched 為符合的筆數',
          '  而且 收到 notes、content、done 事件',
          '',
          '場景: 掃描逾時時標示資料不完整',
          '  假如 FTP 掃描超過上限秒數',
          '  那麼 evidence 事件的 partial 為 true',
          '',
          '場景: 期間超過 31 天',
          '  當 呼叫 POST /api/netops/ai/questions 帶 32 天的時間範圍',
          '  那麼 回應 400 VALIDATION_FAILED',
        ].join('\n'),
        body: {
          type: 'object',
          required: ['from', 'to', 'question'],
          additionalProperties: false,
          properties: {
            from: { type: 'string', description: 'ISO 8601 含時區' },
            to: { type: 'string', description: 'ISO 8601 含時區' },
            question: { type: 'string', minLength: 1, maxLength: 2000 },
            history: HISTORY,
            think: { type: 'boolean', default: false },
            source: { type: 'string', enum: ['pa', 'ad'], default: 'pa' },
          },
        },
        response: SSE_RESPONSE('open、meta、scan、evidence、events、ad、notes、thinking、content、done、error、heartbeat'),
      },
    },
    async (req, reply) => {
      const from = timeIn(req.body.from, 'from');
      const to = timeIn(req.body.to, 'to');
      if (to < from) throw validation('to', '結束時間不可早於開始時間');
      if (Date.parse(req.body.to) - Date.parse(req.body.from) > ASK_MAX_DAYS * 86400_000) throw validation('to', `查詢期間最長 ${ASK_MAX_DAYS} 天`);
      const question = req.body.question.trim();
      if (!question) throw validation('question', '請輸入問題');
      const input = { from, to, question, history: req.body.history, source: req.body.source };
      const p = ai.prepareQuestion(input);
      const owner = hub.reserve(req);
      return hub.open(req, reply, owner, (s) => ai.ask(s, { from, to, question, think: req.body.think === true }, p));
    },
  );
};

export default aiRoutes;
