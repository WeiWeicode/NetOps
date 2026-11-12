/**
 * PA Log 明細查詢與匯出(docs/API.md §4.3;舊版 POST /palog/search)
 *   舊版同步等待最長 180 秒,超過路由上限,改成工作模式(ARCHITECTURE D6):送出 → 輪詢 → 分頁取結果 / 匯出 CSV
 *   C3(2026-11-11 需求方決定,ARCHITECTURE D43):只查 ClickHouse 原始 log(期間 ≤ 30 天),不再掃 FTP;
 *   條件語意同舊版 core/palog.js buildFilter(SQL 在 infra/clickhouse/reader.ts 的 trafficWhere)
 */
import type { FastifyPluginAsync } from 'fastify';
import { JobRunner, ownerOf } from '../../infra/jobs/index.js';
import { toCsv } from '../../shared/csv.js';
import { ACCEPTED, looseObject, NO_CONTENT, TIME } from '../../shared/schemas.js';
import { logTimeOut, taipeiTimeMs, timeIn, validation } from '../../shared/time.js';
import { cancelQuietly } from '../ftp/ad-routes.js';
import { AppError } from '../../errors.js';
import { ClickHouseError } from '../../infra/clickhouse/index.js';
import { ROW_FIELDS } from './core/palog.js';
import { checkCoverage, need, unavailable, viaClickHouse, type ChOverviewDeps } from './ch-overview.js';
import { SOURCE } from './routes.js';

const KIND = 'pa-log-search';
/** 查詢期間上限(天;D29:ClickHouse TRAFFIC 保留 30 天) */
export const SEARCH_MAX_DAYS = 30;
/** 明細查詢的執行秒數上限(netops_reader 的 constraints 上限 50) */
const CH_SEARCH_SECONDS = 50;

/** 匯出欄名(同舊版畫面 FIELD_LABELS) */
const FIELD_LABELS: Record<string, string> = {
  time: '時間', subtype: '類型', action: '動作', src: '來源 IP', sport: '來源 Port', dst: '目的 IP', dport: '目的 Port', proto: '協定',
  app: '應用程式', rule: '規則', fromZone: '來源區域', toZone: '目的區域', srcUser: '使用者', natSrc: 'NAT 來源', natDst: 'NAT 目的',
  bytes: '位元組', sent: '送出', recv: '接收', packets: '封包', elapsed: '持續(秒)', endReason: '結束原因', category: 'URL 類別',
  srcCountry: '來源國家', dstCountry: '目的國家', appRisk: 'App 風險', threat: '威脅名稱', severity: '嚴重性', url: 'URL / 檔名',
};
const FIELDS = ROW_FIELDS as string[];
const TIME_INDEX = FIELDS.indexOf('time');

interface SearchBody {
  from: string;
  to: string;
  src?: string;
  dst?: string;
  ip?: string;
  port?: string;
  proto?: string;
  app?: string;
  rule?: string;
  action?: string;
  fromZone?: string;
  toZone?: string;
  user?: string;
  country?: string;
  q?: string;
  limit?: number;
  /** 只有 clickhouse(相容用,可省略) */
  source?: string;
}

/** 工作結果(rows 只在伺服器端保留,狀態查詢不回傳) */
interface SearchResult {
  source: 'clickhouse';
  from: string;
  to: string;
  total: number;
  limit: number;
  /** 舊欄位(FTP 檔案數),固定 0 */
  files: number;
  filesScanned: number;
  scanned: number;
  seconds: number;
  stopReason: '' | 'limit';
  /** 期間有一部分在 ClickHouse 有資料之前 */
  partial: boolean;
  coverage: { from: string; to: string };
  /** 完成後取消(DELETE)時清空,釋放記憶體 */
  rows: (string | number)[][];
}

/** IP 條件:只允許 IP / CIDR 字元與最多 4 個 *(萬用字元;ClickHouse 端轉 LIKE,線性時間) */
const IP = { type: 'string', maxLength: 64, pattern: '^[0-9a-fA-F:./]*(\\*[0-9a-fA-F:./]*){0,4}$' } as const;
/** 連續的 * 合併成一個(意義相同) */
const ipCond = (v?: string) => (v ? v.replace(/\*+/g, '*') : v);

const text = (max: number) => ({ type: 'string', maxLength: max });
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

const logRoutes: FastifyPluginAsync<{ limit: number; seconds: number; ch: ChOverviewDeps }> = async (app, { limit, seconds, ch }) => {
  // 全系統同時 2 個、每人 1 個、全部保留 30 份(查詢可佔滿 ClickHouse 50 秒;結果佔記憶體;資安審查 M2、L2)
  const jobs = new JobRunner({ concurrency: 2, maxActivePerOwner: 1, maxRetained: 30, maxRetainedPerOwner: 5 }, (kind, err) => app.log.error({ err, kind }, '工作執行發生非預期錯誤'));
  app.addHook('onClose', async () => jobs.close());
  const jobsOf = (_id: string, _owner: string): JobRunner => jobs;
  /** 狀態查詢:結果只回摘要,資料列走 /rows 分頁(回應不會太大) */
  const view = (id: string, owner: string) => {
    const job = jobsOf(id, owner).get<SearchResult>(id, owner, KIND);
    if (!job.result) return job;
    const { rows: _rows, ...summary } = job.result;
    return { ...job, result: summary };
  };
  const rowOut = (r: (string | number)[]) => Object.fromEntries(FIELDS.map((k, i) => [k, i === TIME_INDEX ? logTimeOut(String(r[i])) : r[i]]));

  app.post<{ Body: SearchBody }>(
    '/v1/pa/log-searches',
    {
      schema: {
        operationId: 'netops.pa-log.search',
        summary: 'PA Log 明細查詢(送出工作)',
        description: `依時間與條件查 ClickHouse 的 PA TRAFFIC 原始 log(IP 支援完全相同、萬用字元與 CIDR,並比對 NAT 位址);回 202 與工作狀態,完成後分頁取結果或匯出 CSV。依時間由舊到新取前 limit 筆(預設與上限 ${limit}),還有更多時 stopReason 為 limit;執行上限 ${CH_SEARCH_SECONDS} 秒。期間最長 ${SEARCH_MAX_DAYS} 天,只用關鍵字 q 時最長 1 天。期間整個超過保留期限回 404 NETOPS_PA_OUT_OF_RETENTION;期間內沒有資料回 404 NETOPS_PA_NO_DATA;ClickHouse 無法使用回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。`,
        tags: ['PA Log 明細'],
        'x-permission': 'netops.pa-log.read',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 送出明細查詢',
          '  假如 ClickHouse 有 2026-11-12 08:00–09:00 的 TRAFFIC',
          '  當 呼叫 POST /api/netops/pa/log-searches 帶 from、to 與 src',
          '  那麼 回應 202',
          '  而且 之後 GET /api/netops/pa/log-searches/{id} 的 status 會變成 "done",result.source 為 "clickhouse"',
          '',
          '場景: 期間沒有資料',
          '  當 呼叫 POST /api/netops/pa/log-searches 的期間在保留範圍內但 ClickHouse 沒有 log',
          '  那麼 回應 404 NETOPS_PA_NO_DATA',
          '',
          '場景: 明細超過保留期限',
          '  假如 ClickHouse 從 2026-11-11 起有資料',
          '  當 呼叫 POST /api/netops/pa/log-searches 的期間在 2026-10-01',
          '  那麼 回應 404 NETOPS_PA_OUT_OF_RETENTION',
          '',
          '場景: 明細期間超過 30 天',
          '  當 呼叫 POST /api/netops/pa/log-searches 的期間 31 天',
          '  那麼 回應 400 VALIDATION_FAILED',
        ].join('\n'),
        body: {
          type: 'object',
          required: ['from', 'to'],
          additionalProperties: false,
          properties: {
            from: TIME,
            to: TIME,
            src: IP,
            dst: IP,
            ip: IP,
            port: { type: 'string', maxLength: 200, pattern: '^[\\d,\\s]*$' },
            proto: text(20),
            app: text(100),
            rule: text(100),
            action: text(30),
            fromZone: text(100),
            toZone: text(100),
            user: text(100),
            country: text(100),
            q: text(200),
            limit: { type: 'integer', minimum: 1, maximum: limit },
            source: SOURCE,
          },
        },
        response: ACCEPTED,
      },
    },
    async (req, reply) => {
      const { reader } = need(ch);
      const b = { ...req.body, src: ipCond(req.body.src), dst: ipCond(req.body.dst), ip: ipCond(req.body.ip) };
      const from = timeIn(b.from, 'from');
      const to = timeIn(b.to, 'to');
      if (to < from) throw validation('to', '結束時間不可早於開始時間');
      // to 含該分鐘(同舊版 buildFilter:to + ':59')
      const fromMs = taipeiTimeMs(from);
      const toMs = taipeiTimeMs(to) + 60_000;
      if (toMs - fromMs > SEARCH_MAX_DAYS * 86400_000 + 60_000) throw validation('to', `查詢期間最長 ${SEARCH_MAX_DAYS} 天`);
      // 只有關鍵字 q、沒有其他條件:用不到排序鍵,會掃完整段期間;只接受 1 天內(資安審查 M2)
      const qOnly = Boolean(b.q?.trim()) && !['src', 'dst', 'ip', 'port', 'proto', 'app', 'rule', 'action', 'fromZone', 'toZone', 'user', 'country'].some((k) => String(b[k as keyof SearchBody] ?? '').trim());
      if (qOnly && toMs - fromMs > 86400_000 + 60_000) throw validation('q', '只用關鍵字查詢時期間最長 1 天,請加上 IP、Port 等條件或縮短期間');
      const max = Math.min(b.limit ?? limit, limit);
      const cov = await checkCoverage(ch, 'traffic', fromMs, toMs);
      const n = await viaClickHouse(() => reader.trafficCount(fromMs, toMs));
      if (!n) throw new AppError(404, 'NETOPS_PA_NO_DATA', '這段時間 ClickHouse 沒有 log');
      const filter = { fromMs, toMs, src: b.src, dst: b.dst, ip: b.ip, port: b.port, proto: b.proto, app: b.app, rule: b.rule, action: b.action, fromZone: b.fromZone, toZone: b.toZone, user: b.user, country: b.country, q: b.q };
      const secs = Math.min(seconds, CH_SEARCH_SECONDS);
      const job = jobs.submit<SearchResult>(
        KIND,
        ownerOf(req.identity),
        async ({ signal, progress }) => {
          progress({ found: 0 });
          const t0 = Date.now();
          let r: Awaited<ReturnType<typeof reader.searchTraffic>>;
          try {
            r = await reader.searchTraffic(filter, max, secs, signal);
          } catch (err) {
            if (signal.aborted || !(err instanceof ClickHouseError)) throw err;
            // 159 TIMEOUT_EXCEEDED:超過秒數上限;其他:連線或查詢失敗。原文只寫日誌(只記代碼)
            app.log.warn({ code: err.code, status: err.status }, 'ClickHouse 明細查詢失敗');
            if (err.code === 159) throw new AppError(503, 'NETOPS_CLICKHOUSE_UNAVAILABLE', `查詢超過 ${secs} 秒,請縮短期間或加上條件`);
            throw unavailable();
          }
          return {
            source: 'clickhouse' as const,
            from: logTimeOut(from),
            to: logTimeOut(to),
            total: r.rows.length,
            limit: max,
            files: 0,
            filesScanned: 0,
            scanned: r.scanned,
            seconds: Math.round((Date.now() - t0) / 100) / 10,
            stopReason: r.more ? ('limit' as const) : ('' as const),
            ...cov,
            rows: r.rows.map((rec) => FIELDS.map((k) => rec[k] ?? '')),
          };
        },
        { timeoutMs: (secs + 30) * 1000 },
      );
      return reply.status(202).send(job);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/pa/log-searches/:id',
    {
      schema: {
        operationId: 'netops.pa-log.search-get',
        summary: 'PA Log 明細查詢(查詢工作)',
        description: '查詢明細工作的狀態與進度;完成時 result 為查詢摘要(筆數、ClickHouse 讀過的列數、秒數、stopReason、coverage),資料列用 /rows 分頁取得。別人的工作、已逾期或服務重新啟動後回 404 NETOPS_JOB_NOT_FOUND。',
        tags: ['PA Log 明細'],
        'x-permission': 'netops.pa-log.read',
        'x-gherkin': ['場景: 查詢自己的工作', '  當 呼叫 GET /api/netops/pa/log-searches/{id}', '  那麼 回應 200', '', '場景: 別人的工作', '  當 另一位使用者查詢同一個 id', '  那麼 回應 404 NETOPS_JOB_NOT_FOUND'].join('\n'),
        params: ID,
        response: { 200: looseObject('工作狀態(docs/API.md §1.1、§4.3)') },
      },
    },
    async (req) => view(req.params.id, ownerOf(req.identity)),
  );

  app.get<{ Params: { id: string }; Querystring: { page?: number; pageSize?: number } }>(
    '/v1/pa/log-searches/:id/rows',
    {
      schema: {
        operationId: 'netops.pa-log.search-rows',
        summary: 'PA Log 明細查詢結果(分頁)',
        description: '完成的明細工作的資料列,依時間排序、分頁回傳;工作尚未完成或失敗回 409 NETOPS_JOB_NOT_DONE。',
        tags: ['PA Log 明細'],
        'x-permission': 'netops.pa-log.read',
        'x-audit-level': 'meta',
        'x-gherkin': ['場景: 取第一頁', '  假如 明細工作已完成', '  當 呼叫 GET /api/netops/pa/log-searches/{id}/rows?page=1&pageSize=50', '  那麼 回應 200', '  而且 回應含 items、total、page、pageSize'].join('\n'),
        params: ID,
        querystring: { type: 'object', additionalProperties: false, properties: { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 } } },
        response: { 200: looseObject('{ items, total, page, pageSize }') },
      },
    },
    async (req) => {
      const owner = ownerOf(req.identity);
      const r = jobsOf(req.params.id, owner).result<SearchResult>(req.params.id, owner, KIND);
      const page = req.query.page ?? 1;
      const pageSize = req.query.pageSize ?? 50;
      return { items: r.rows.slice((page - 1) * pageSize, page * pageSize).map(rowOut), total: r.rows.length, page, pageSize };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/pa/log-searches/:id/export',
    {
      schema: {
        operationId: 'netops.pa-log.search-export',
        summary: 'PA Log 明細查詢結果匯出',
        description: '下載完成的明細工作的全部資料列(CSV,UTF-8 BOM,欄名中文,同舊版畫面匯出)。',
        tags: ['PA Log 明細'],
        'x-permission': 'netops.pa-log.read',
        'x-audit-level': 'meta',
        'x-gherkin': ['場景: 匯出 CSV', '  假如 明細工作已完成', '  當 呼叫 GET /api/netops/pa/log-searches/{id}/export', '  那麼 回應 200', '  而且 Content-Type 為 text/csv'].join('\n'),
        params: ID,
        produces: ['text/csv'],
      },
    },
    async (req, reply) => {
      const owner = ownerOf(req.identity);
      const r = jobsOf(req.params.id, owner).result<SearchResult>(req.params.id, owner, KIND);
      const rows = r.rows.map((row) => row.map((v, i) => (i === TIME_INDEX ? logTimeOut(String(v)) : v)));
      // 期間有一部分超過保留期限時檔名標出來(AGENT.md §5)
      const name = `PA_log_${r.from.slice(0, 16).replace(/\D/g, '')}_${r.to.slice(0, 16).replace(/\D/g, '')}${r.partial ? '_部分期間超過保留期限' : ''}.csv`;
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(toCsv(FIELDS.map((f) => FIELD_LABELS[f] ?? f), rows));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/pa/log-searches/:id',
    {
      schema: {
        operationId: 'netops.pa-log.search-cancel',
        summary: '取消 PA Log 明細查詢',
        description: '取消自己的明細工作並中斷 ClickHouse 查詢;已完成的工作則丟棄結果(之後查詢回 404)。已逾期或不存在也回 204(冪等)。',
        tags: ['PA Log 明細'],
        'x-permission': 'netops.pa-log.read',
        'x-gherkin': ['場景: 取消工作', '  當 呼叫 DELETE /api/netops/pa/log-searches/{id}', '  那麼 回應 204', '  而且 再呼叫一次也回 204'].join('\n'),
        params: ID,
        response: NO_CONTENT,
      },
    },
    async (req, reply) => {
      // 已完成的工作:取消即丟棄結果,釋放記憶體(資料列最多 PA_SEARCH_LIMIT 筆 × 28 欄)
      const owner = ownerOf(req.identity);
      cancelQuietly(() => jobsOf(req.params.id, owner).cancel(req.params.id, owner, KIND, { discard: true }));
      return reply.status(204).send();
    },
  );
};

export default logRoutes;
