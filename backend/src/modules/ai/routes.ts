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

/** 問答期間上限(天):ftp 來源有 IP 時要從 FTP 重讀原始 log(同明細查詢 §4.3);clickhouse 來源沿用同一個上限 */
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
          '期間最長 92 天;沒有已分析的 log 回 404 NETOPS_PA_NO_DATA;未設定 AI 回 409 NETOPS_AI_DISABLED;同時進行的 AI 回答每人 2 個、全系統 6 個,超過回 429 NETOPS_STREAM_BUSY。' +
          '資料來源依 NETOPS_AI_SOURCE(AC2,ARCHITECTURE D44;測試區 clickhouse、正式區 C6 前 ftp):clickhouse 時最近 30 天用 ClickHouse 原始 TRAFFIC 建的每小時摘要,更早的部分改用每天 / 每小時彙總(meta.grain 標示,資料較粗);' +
          'ClickHouse 無法使用回 503 NETOPS_CLICKHOUSE_UNAVAILABLE(不改用 FTP),整段超過保留期限回 404 NETOPS_PA_OUT_OF_RETENTION。',
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
          '',
          '場景: ClickHouse 來源的期間超過 30 天時,超過的部分用彙總並標示較粗',
          '  假如 NETOPS_AI_SOURCE 為 clickhouse',
          '  而且 ClickHouse 原始 TRAFFIC 保留 30 天,彙總涵蓋整段期間',
          '  當 呼叫 POST /api/netops/ai/analyses 帶 40 天前到昨天的期間',
          '  那麼 meta 事件的 source 為 "clickhouse"',
          '  而且 meta.grain.coarse 為 30 天以前的期間',
          '  而且 送給模型的資料註明「資料較粗」',
          '',
          '場景: ClickHouse 無法使用',
          '  假如 NETOPS_AI_SOURCE 為 clickhouse 而且 ClickHouse 連不上',
          '  當 呼叫 POST /api/netops/ai/analyses',
          '  那麼 回應 503 NETOPS_CLICKHOUSE_UNAVAILABLE(串流開始前,不改用 FTP)',
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
      const ctx = await ai.prepareAnalysis(from, to);
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
          '依問題中的 IP / Port 查防火牆 log 並彙整(NETOPS_AI_SOURCE=clickhouse:查 ClickHouse 原始 TRAFFIC 30 天與威脅類 90 天,依連線組合累計加最多 15 筆範例,超過保留期限的部分標示 evidence.skipped,不掃 FTP;ftp:先查連線組合統計,沒有統計的檔案才從 FTP 串流掃描,原始 log 不落地);問到 AD 或 IP 出現在 AD 事件時帶入 AD 事件記錄;連同知識庫筆記送給模型,以 SSE 串流回答。' +
          'source 為 ad 時只看 AD 事件記錄。追問時問題沒有 IP / Port 會沿用前面的條件;同樣的條件 10 分鐘內不重複掃描。' +
          '事件:open、meta(ips、ports、files、dataSource)、scan(ftp:掃描進度;clickhouse:source、step)、evidence(matched、partial 資料不完整;clickhouse 另有 samples、skipped)、events、ad、notes(used、omitted、vectorError)、thinking、content、done、error、heartbeat。ClickHouse 無法使用時串流開始前回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。' +
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
          '',
          '場景: ClickHouse 來源的問答不掃 FTP',
          '  假如 NETOPS_AI_SOURCE 為 clickhouse',
          '  當 呼叫 POST /api/netops/ai/questions 帶問題 "10.10.1.1 最近連到哪些外部 IP"',
          '  那麼 收到 scan 事件 { source: "clickhouse", step: "traffic" }',
          '  而且 evidence 事件的 source 為 "clickhouse",samples 最多 15',
          '  而且 不連 FTP',
          '',
          '場景: 問答期間有一部分超過原始 log 保留期限',
          '  假如 NETOPS_AI_SOURCE 為 clickhouse 而且原始 TRAFFIC 保留 30 天',
          '  當 問答期間從 35 天前開始',
          '  那麼 evidence.skipped 為 35 天前到 30 天前',
          '  而且 送給模型的資料註明「這段沒有資料可查，不代表沒有連線」',
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
      const p = await ai.prepareQuestion(input);
      const owner = hub.reserve(req);
      return hub.open(req, reply, owner, (s) => ai.ask(s, { from, to, question, think: req.body.think === true }, p));
    },
  );
};

export default aiRoutes;
