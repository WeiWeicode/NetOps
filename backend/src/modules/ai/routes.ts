/**
 * AI 分析、問答(docs/API.md §10;舊版 server/routes/ai.js;IMPL-PLAN A1、ARCHITECTURE D23;翻譯與整理筆記依 2026-11-09 決定不搬,D25)
 *   分析與問答都用 SSE(POST,前端以 fetch 讀串流):掃描 FTP 與模型回答可能超過路由逾時(AGENT.md §7.3),
 *   串流的寫法照 S0 報告 §3.6(sse.ts)。只做驗證、權限宣告與格式轉換;流程在 service.ts。
 * 權限:netops.ai.use(netops-admin、netops-viewer,2026-11-05 決定,D25 維持一個權限)。
 */
import type { FastifyPluginAsync } from 'fastify';
import { DAY, looseObject, TIME } from '../../shared/schemas.js';
import { dayRange, timeIn, validation } from '../../shared/time.js';
import { ownerOf } from '../../infra/jobs/index.js';
import { SLICE_QUERY } from '../pa-heat/routes.js';
import type { SliceQuery, ThreatProfileQuery } from '../pa-heat/service.js';
import type { AiService, ExplainInput, HeatmapParams, HistoryItem, InsightParams } from './service.js';
import { SSE_TIMEOUT_MS, type SseHub } from './sse.js';
import type { DailySummaryScheduler } from './daily-summary.js';

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
/** AC4 insight 的 params(同 GET /pa/insight/{view}) */
const INSIGHT_PARAMS = {
  type: 'object',
  required: ['view', 'from', 'to'],
  additionalProperties: false,
  properties: { view: { type: 'string', enum: ['traffic', 'threat'] }, from: DAY, to: DAY },
} as const;

/** AC5 threat 的 params:威脅名稱(完全相同)或威脅 ID(只有數字)與期間(最長 31 天,服務層檢查) */
const THREAT_PARAMS = {
  type: 'object',
  required: ['name', 'from', 'to'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 300, pattern: '^[^\\u0000-\\u001f]*$', description: '威脅名稱(Log 明細的「威脅名稱」,例 generic:xxx(52316871))或威脅 ID(只有數字)' },
    from: TIME,
    to: TIME,
  },
} as const;
/** AC5 heatmap 的 params(同 GET /pa/heatmap;ad 指標不提供) */
const HEATMAP_PARAMS = {
  type: 'object',
  required: ['granularity', 'metric'],
  additionalProperties: false,
  properties: { granularity: { type: 'string', enum: ['year', 'month', 'day'] }, metric: { type: 'string', enum: ['traffic', 'deny', 'threat'] }, date: DAY },
} as const;
/** AC6 events 的 params(同 GET /pa-events/overview 的期間,最長 92 天;四類一起摘要) */
const EVENTS_PARAMS = {
  type: 'object',
  required: ['from'],
  additionalProperties: false,
  properties: { from: DAY, to: DAY },
} as const;
const KINDS = ['slice', 'insight', 'threat', 'heatmap', 'events'] as const;
const PARAMS_OF = { slice: SLICE_QUERY, insight: INSIGHT_PARAMS, threat: THREAT_PARAMS, heatmap: HEATMAP_PARAMS, events: EVENTS_PARAMS } as const;

const aiRoutes: FastifyPluginAsync<{ ai: AiService; hub: SseHub; daily?: DailySummaryScheduler | null }> = async (app, { ai, hub, daily }) => {
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

  // AC7:AI 每日摘要(排程產生、存檔;這裡只讀)
  app.get<{ Querystring: { day?: string } }>(
    '/v1/ai/daily-summary',
    {
      schema: {
        operationId: 'netops.ai.daily-summary',
        summary: 'AI 每日摘要',
        description:
          '每天自動對帳與每日同步(AC1)之後,系統自動產生前一天的 AI 摘要(流量 + 威脅、URL 過濾、資料過濾、WildFire 四類安全事件的統計;不送原始 log),流量總覽顯示(IMPL-PLAN AC7;docs/API.md §10.4)。' +
          '不指定 day 時回最近一份完成的摘要;day(YYYY-MM-DD)指定某一天。target 為今天要產生的日子(前一天)與其狀態 state:disabled 未啟用、waiting 等對帳 / 每日同步、running 產生中、retrying 第一次失敗稍後重試、done 完成、failed 重試後仍失敗(畫面標示「今天的摘要產生失敗」)。' +
          '摘要內容含 IP 與姓名(AQ2),只回給有 netops.ai.use 的人,不寫進日誌與稽核。未啟用(NETOPS_AI_DAILY_SUMMARY=0、沒有 LLM_URL 或不自動對帳)時 enabled false、state disabled,仍可讀已存的摘要。',
        tags: ['AI'],
        'x-permission': 'netops.ai.use',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 讀取最近一份每日摘要',
          '  假如 使用者擁有 netops.ai.use',
          '  而且 系統已在今天 08:10 對帳與每日同步後產生 2026-11-13 的摘要',
          '  當 呼叫 GET /api/netops/ai/daily-summary',
          '  那麼 回應 200',
          '  而且 target 為 "2026-11-13" 且 state 為 "done"',
          '  而且 summary.result.text 為 Markdown 摘要',
          '',
          '場景: 重試後仍失敗',
          '  假如 AI 主機無法使用',
          '  當 系統產生 2026-11-13 的摘要失敗並重試一次仍失敗',
          '  那麼 GET /api/netops/ai/daily-summary 的 state 為 "failed"',
          '  而且 summary 為最近一份完成的摘要(較早的日子)',
          '  而且 對帳與每日同步照常完成',
          '',
          '場景: 日期格式錯誤',
          '  當 呼叫 GET /api/netops/ai/daily-summary?day=2026/11/13',
          '  那麼 回應 400 VALIDATION_FAILED',
        ].join('\n'),
        querystring: { type: 'object', additionalProperties: false, properties: { day: DAY } },
        response: { 200: looseObject('{ enabled, at, target, state, error, summary: { day, state, tries, at, result: { text, model, partial, clipped, contextChars, counts } | null, error } | null, days: [{ day, state }] }') },
      },
    },
    async (req) => {
      if (!daily) return { enabled: false, at: null, target: '', state: 'disabled', error: null, summary: null, days: [] };
      return daily.status(req.query.day);
    },
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
  app.post<{ Body: { kind: (typeof KINDS)[number]; params: SliceQuery | InsightParams | ThreatProfileQuery | HeatmapParams; think?: boolean } }>(
    '/v1/ai/explanations',
    {
      schema: {
        operationId: 'netops.ai.explain',
        summary: 'AI 解讀畫面上的統計(SSE)',
        description:
          'PA 頁面的 AI 按鈕共用(AC4–AC6,ARCHITECTURE D44 ③;細節見 docs/API.md §10.3)。後端依 params 自己取資料(不接受前端送來的統計),只送統計與排行給模型,以 SSE 回答;不送原始 log。' +
          'kind:slice = 時段明細(params 同 GET /pa/slice,重用同一人同條件的工作);insight = 分析儀表板(params { view, from, to },用儀表板快取);' +
          'threat = 威脅說明與處理建議(params { name, from, to }:名稱完全相同,或只有數字時當威脅 ID 比對名稱結尾;最長 31 天);heatmap = 熱力圖異常格(params 同 GET /pa/heatmap,metric 不含 ad;只送統計與異常格,meta.cells 列出異常時段);events = 安全事件摘要(params { from, to? } 同 GET /pa-events/overview,威脅、URL 過濾、資料過濾、WildFire 四類一起;meta.types 為各類筆數與是否不完整)。' +
          '事件:open、meta、scan、thinking、content、done、error、heartbeat。錯誤:參數 400;時段明細照 GET /pa/slice;儀表板 429 NETOPS_INSIGHT_BUSY;威脅整段(events 為四類都)超過保留期限 404 NETOPS_PA_OUT_OF_RETENTION;日視圖超過 1 年 422;ClickHouse 503;未設定 AI 409 NETOPS_AI_DISABLED;名額 429 NETOPS_STREAM_BUSY。',
        tags: ['AI'],
        'x-permission': 'netops.ai.use',
        'x-audit-level': 'meta',
        ...sse,
        'x-gherkin': [
          '場景: 時段明細 AI 解讀沿用同一份查詢結果',
          '  假如 使用者擁有 netops.ai.use',
          '  而且 使用者剛查過 GET /api/netops/pa/slice?start=…&end=…',
          '  當 呼叫 POST /api/netops/ai/explanations 帶 { kind: "slice", params: 同樣的條件 }',
          '  那麼 回應 200 且 Content-Type 為 text/event-stream',
          '  而且 依序收到 open、meta、content、done 事件',
          '  而且 不重查 ClickHouse',
          '  而且 送給模型的資料只有摘要與 Top 10,沒有明細列',
          '',
          '場景: 分析儀表板 AI 摘要用儀表板快取',
          '  假如 使用者剛看過 GET /api/netops/pa/insight/threat?from=2026-11-05&to=2026-11-11',
          '  當 呼叫 POST /api/netops/ai/explanations 帶 { kind: "insight", params: { view: "threat", from: "2026-11-05", to: "2026-11-11" } }',
          '  那麼 meta 事件的 prev 表示有沒有前一期可比較',
          '  而且 不重查 ClickHouse',
          '',
          '場景: 威脅說明只送彙總',
          '  假如 使用者在 Log 明細查到威脅 "generic:xxx(52316871)"',
          '  當 呼叫 POST /api/netops/ai/explanations 帶 { kind: "threat", params: { name: "generic:xxx(52316871)", from, to } }',
          '  那麼 meta 事件的 count 為本期同名筆數',
          '  而且 送給模型的資料有嚴重度、方向、動作與影響主機,沒有原始 log 列',
          '',
          '場景: 熱力圖只送異常格',
          '  假如 月視圖有 720 格',
          '  當 呼叫 POST /api/netops/ai/explanations 帶 { kind: "heatmap", params: { granularity: "month", metric: "traffic", date } }',
          '  那麼 送給模型的異常格最多 10 格(另加最多 3 格異常低)',
          '  而且 meta.cells 列出這些格子的時間,畫面可點開時段明細',
          '',
          '場景: 安全事件摘要四類一起',
          '  假如 使用者在安全事件頁選了 2026-11-12 ~ 2026-11-13',
          '  當 呼叫 POST /api/netops/ai/explanations 帶 { kind: "events", params: { from: "2026-11-12", to: "2026-11-13" } }',
          '  那麼 meta.types 列出 threat、url、data、wildfire 的筆數',
          '  而且 送給模型的資料只有筆數、KPI 與排行,沒有原始 log 列',
          '',
          '場景: 資料有字數上限',
          '  假如 排行的名稱很長',
          '  當 呼叫 POST /api/netops/ai/explanations',
          '  那麼 送給模型的資料不超過上限,並註明「已省略」',
          '',
          '場景: 參數錯誤',
          '  當 呼叫 POST /api/netops/ai/explanations 帶 { kind: "slice", params: { start, end } } 而 end − start 超過 1 天',
          '  那麼 回應 400 VALIDATION_FAILED',
        ].join('\n'),
        body: {
          type: 'object',
          required: ['kind', 'params'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: KINDS, description: 'slice = 時段明細;insight = 分析儀表板;threat = 威脅說明(AC5);heatmap = 熱力圖異常格(AC5);events = 安全事件摘要(AC6)' },
            params: { type: 'object', description: 'slice 同 GET /pa/slice 的條件;insight { view, from, to };threat { name, from, to };heatmap 同 GET /pa/heatmap;events { from, to? }' },
            think: { type: 'boolean', default: false, description: '深入思考(比較久)' },
          },
          allOf: KINDS.map((k) => ({ if: { properties: { kind: { const: k } } }, then: { properties: { params: PARAMS_OF[k] } } })),
        },
        response: SSE_RESPONSE('open、meta、scan、thinking、content、done、error、heartbeat'),
      },
    },
    async (req, reply) => {
      // 名額先檢查一次(取資料前),開始串流前再檢查一次
      hub.reserve(req);
      // params 已依 kind 驗證(schema 的 allOf)
      const input = { kind: req.body.kind, params: req.body.params } as ExplainInput;
      const ctx = await ai.prepareExplanation(input, ownerOf(req.identity));
      const owner = hub.reserve(req);
      return hub.open(req, reply, owner, (s) => ai.explain(s, { think: req.body.think === true }, ctx));
    },
  );
};

export default aiRoutes;
