/**
 * PA Log 明細查詢與匯出(docs/API.md §4.3;舊版 POST /palog/search)
 *   舊版同步等待最長 180 秒,超過路由上限,改成工作模式(ARCHITECTURE D6):送出 → 輪詢 → 分頁取結果 / 匯出 CSV
 *   依時間挑出已分析的檔案,從 FTP 串流逐列篩選,原始 log 不落地;找到上限筆數或超過掃描秒數就停止
 * 篩選條件與掃描在 core/palog.js、core/scan.js(舊版邏輯不變)。
 */
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors.js';
import type { Ftp, FtpStream } from '../../infra/ftp/index.js';
import { JobRunner, ownerOf } from '../../infra/jobs/index.js';
import { toCsv } from '../../shared/csv.js';
import { ACCEPTED, looseObject, TIME } from '../../shared/schemas.js';
import { logTimeOut, timeIn, validation } from '../../shared/time.js';
import { cancelQuietly } from '../ftp/ad-routes.js';
import { buildFilter, buildPrefilter, ROW_FIELDS } from './core/palog.js';
import { scanFiles } from './core/scan.js';
import type { TrafficImporter } from './importer.js';

const KIND = 'pa-log-search';
/** 查詢期間上限(天):明細要從 FTP 重讀原始 log */
export const SEARCH_MAX_DAYS = 31;

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
}

/** 工作結果(rows 只在伺服器端保留,狀態查詢不回傳) */
interface SearchResult {
  from: string;
  to: string;
  total: number;
  limit: number;
  files: number;
  filesScanned: number;
  scanned: number;
  seconds: number;
  stopReason: '' | 'limit' | 'timeout' | 'closed' | 'error';
  /** 完成後取消(DELETE)時清空,釋放記憶體 */
  rows: (string | number)[][];
}

/** core/scan.js 的型別(JS 推斷的參數型別太窄) */
type ScanFiles = (
  files: { path: string; name: string; rows?: number }[],
  opts: {
    onRow(rec: Record<string, string | number>, raw: string): boolean | void;
    prefilter: ((line: string) => boolean) | null;
    parallel: number;
    seconds: number;
    isClosed(): boolean;
    onProgress(p: { filesScanned: number; files: number; rows: number }): void;
    openStream(path: string): Promise<FtpStream>;
  },
) => Promise<{ scanned: number; rows: number; filesScanned: number; files: number; seconds: number; stopReason: SearchResult['stopReason'] }>;
const scan = scanFiles as unknown as ScanFiles;

/**
 * IP 條件:只允許 IP / CIDR 字元與最多 4 個 *(萬用字元)。核心 ipMatcher 會把每個 * 轉成 .* 的正規表示式,
 * 連續或大量的 * 會讓比對時間指數成長、卡住整個服務(ReDoS;舊版同樣有此問題,核心依 D4 不改,在這裡擋)
 */
const IP = { type: 'string', maxLength: 64, pattern: '^[0-9a-fA-F:./]*(\\*[0-9a-fA-F:./]*){0,4}$' } as const;
/** 連續的 * 合併成一個(意義相同) */
const ipCond = (v?: string) => (v ? v.replace(/\*+/g, '*') : v);

const text = (max: number) => ({ type: 'string', maxLength: max });
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

const logRoutes: FastifyPluginAsync<{ ftp: Ftp; traffic: TrafficImporter; parallel: number; limit: number; seconds: number }> = async (app, { ftp, traffic, parallel, limit, seconds }) => {
  // 明細查詢專用:同時只執行 1 個(其餘排隊),FTP 連線至少留給匯入輪流使用;每人保留 5 筆結果(資料列佔記憶體)
  const jobs = new JobRunner({ concurrency: 1, maxRetainedPerOwner: 5 }, (kind, err) => app.log.error({ err, kind }, '工作執行發生非預期錯誤'));
  app.addHook('onClose', async () => jobs.close());
  /** 狀態查詢:結果只回摘要,資料列走 /rows 分頁(回應不會太大) */
  const view = (id: string, owner: string) => {
    const job = jobs.get<SearchResult>(id, owner, KIND);
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
        description: `依時間挑出已分析的 log 檔,從 FTP 串流逐列篩選(IP 支援完全相同、萬用字元與 CIDR,並比對 NAT 位址);回 202 與工作狀態,完成後分頁取結果或匯出 CSV。找到上限筆數(預設 ${limit})或超過 ${seconds} 秒就停止,stopReason 標出原因。期間最長 ${SEARCH_MAX_DAYS} 天;期間內沒有已分析的檔案回 404 NETOPS_PA_NO_DATA。`,
        tags: ['PA Log 明細'],
        'x-permission': 'netops.pa-log.read',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 送出明細查詢',
          '  假如 2026-11-02 08:00–09:00 有已分析的 TRAFFIC 檔案',
          '  當 呼叫 POST /api/netops/pa/log-searches 帶 from、to 與 src',
          '  那麼 回應 202',
          '  而且 之後 GET /api/netops/pa/log-searches/{id} 的 status 會變成 "done"',
          '',
          '場景: 期間沒有資料',
          '  當 呼叫 POST /api/netops/pa/log-searches 的期間沒有已分析的檔案',
          '  那麼 回應 404 NETOPS_PA_NO_DATA',
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
          },
        },
        response: ACCEPTED,
      },
    },
    async (req, reply) => {
      const b = { ...req.body, src: ipCond(req.body.src), dst: ipCond(req.body.dst), ip: ipCond(req.body.ip) };
      const from = timeIn(b.from, 'from');
      const to = timeIn(b.to, 'to');
      if (to < from) throw validation('to', '結束時間不可早於開始時間');
      if (Date.parse(b.to) - Date.parse(b.from) > SEARCH_MAX_DAYS * 86400_000) throw validation('to', `查詢期間最長 ${SEARCH_MAX_DAYS} 天`);
      const files = traffic.filesInRange(from, to);
      if (!files.length) throw new AppError(404, 'NETOPS_PA_NO_DATA', '這段時間沒有已分析的 log 檔,請先到「FTP Log 檔案」同步');
      const max = Math.min(b.limit ?? limit, limit);
      const filter = buildFilter({ ...b, from, to });
      const job = jobs.submit<SearchResult>(
        KIND,
        ownerOf(req.identity),
        async ({ signal, progress }) => {
          const rows: (string | number)[][] = [];
          // 本次掃描自己的中止訊號:工作取消時連動;掃描結束(含失敗)一律中止,不留還在佔 FTP 連線的 worker;
          // 掃描期限過後(scan.js 每 2 秒檢查一次,多給 3 秒)叫醒還在排隊等 FTP 連線的 worker
          const local = new AbortController();
          const onAbort = () => local.abort(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          let deadlineHit = false;
          const deadline = setTimeout(() => {
            deadlineHit = true;
            local.abort();
          }, (seconds + 3) * 1000);
          let last = { filesScanned: 0, files: files.length, rows: 0 };
          let r: Awaited<ReturnType<ScanFiles>>;
          try {
            r = await scan(files, {
              prefilter: buildPrefilter(b) as ((line: string) => boolean) | null,
              parallel,
              seconds,
              isClosed: () => signal.aborted,
              openStream: (p: string) => ftp.openStream(p, { signal: local.signal }),
              onProgress: (p) => {
                last = p;
                progress({ ...p, found: rows.length });
              },
              onRow: (rec, raw) => {
                if (filter(rec, raw)) rows.push(FIELDS.map((k) => rec[k] ?? ''));
                if (rows.length >= max) return false;
              },
            });
          } catch (err) {
            // 等 FTP 連線等到超過掃描秒數:回已找到的部分結果,標成 timeout(不完整)
            if (!deadlineHit || signal.aborted) throw err;
            r = { scanned: 0, rows: last.rows, filesScanned: last.filesScanned, files: files.length, seconds, stopReason: 'timeout' };
          } finally {
            clearTimeout(deadline);
            signal.removeEventListener('abort', onAbort);
            local.abort();
          }
          rows.sort((x, y) => String(x[TIME_INDEX]).localeCompare(String(y[TIME_INDEX])));
          const kept = rows.slice(0, max);
          return {
            from: logTimeOut(from),
            to: logTimeOut(to),
            total: kept.length,
            limit: max,
            files: r.files,
            filesScanned: r.filesScanned,
            scanned: r.rows,
            seconds: r.seconds,
            stopReason: r.stopReason,
            rows: kept,
          };
        },
        // 掃描本身有 seconds 上限;等候 FTP 連線與收尾再多給 60 秒
        { timeoutMs: (seconds + 60) * 1000 },
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
        description: '查詢明細工作的狀態與進度;完成時 result 為查詢摘要(筆數、掃描檔案數、秒數、stopReason),資料列用 /rows 分頁取得。別人的工作、已逾期或服務重新啟動後回 404 NETOPS_JOB_NOT_FOUND。',
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
      const r = jobs.result<SearchResult>(req.params.id, ownerOf(req.identity), KIND);
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
      const r = jobs.result<SearchResult>(req.params.id, ownerOf(req.identity), KIND);
      const rows = r.rows.map((row) => row.map((v, i) => (i === TIME_INDEX ? logTimeOut(String(v)) : v)));
      // 掃描逾時的結果不完整,檔名標出來(AGENT.md §5)
      const name = `PA_log_${r.from.slice(0, 16).replace(/\D/g, '')}_${r.to.slice(0, 16).replace(/\D/g, '')}${r.stopReason === 'timeout' ? '_不完整' : ''}.csv`;
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
        description: '取消自己的明細工作並中斷 FTP 掃描;已完成的工作則丟棄結果(之後查詢回 404)。已逾期或不存在也回 204(冪等)。',
        tags: ['PA Log 明細'],
        'x-permission': 'netops.pa-log.read',
        'x-gherkin': ['場景: 取消工作', '  當 呼叫 DELETE /api/netops/pa/log-searches/{id}', '  那麼 回應 204', '  而且 再呼叫一次也回 204'].join('\n'),
        params: ID,
      },
    },
    async (req, reply) => {
      // 已完成的工作:取消即丟棄結果,釋放記憶體(資料列最多 PA_SEARCH_LIMIT 筆 × 28 欄)
      cancelQuietly(() => jobs.cancel(req.params.id, ownerOf(req.identity), KIND, { discard: true }));
      return reply.status(204).send();
    },
  );
};

export default logRoutes;
