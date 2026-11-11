/**
 * netops-clickhouse 存取(ARCHITECTURE D27–D29、AGENT.md §7.2;手冊 docs/PA-LOG-CLICKHOUSE-GUIDE.md §6、§7)。
 * 只經這裡的具名函式存取 ClickHouse:表名只用程式內常數(TABLES),不接受外部字串;查詢條件一律 query_params(C3 起)。
 * C2 只有 netops-ingest 的寫入(帳號 netops_writer);netops-api 的唯讀查詢在 C3 加。
 *
 * 用 ClickHouse 的 HTTP 介面(:8123)與 Node 內建 fetch,不另加套件:寫入只需要 INSERT … FORMAT JSONEachRow。
 * 帳密放在 X-ClickHouse-User / X-ClickHouse-Key 標頭,不放 URL(避免出現在 log)。錯誤訊息不含密碼與資料內容。
 */

/** 可寫入的表(netops-ingest);新增表要同時改 deploy/clickhouse/schema.sql 或 migrations/ */
export const TABLES = {
  traffic: 'netops.pa_traffic_logs',
  threat: 'netops.pa_threat_logs',
} as const;
export type TableKey = keyof typeof TABLES;

export interface ClickHouseConfig {
  /** http://netops-clickhouse:8123(只在 Compose 內部網路) */
  url: string;
  user: string;
  password: string;
  /** 單次請求逾時(毫秒) */
  timeoutMs?: number;
}

/**
 * ClickHouse 回的錯誤。code 是 ClickHouse 錯誤代碼(X-ClickHouse-Exception-Code;連線失敗、逾時時為 undefined)。
 * message 只留第一行並截斷,不含請求內容。
 */
export class ClickHouseError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = 'ClickHouseError';
  }
}

/**
 * 資料本身的錯誤(解析、型別、超出範圍):重試也不會成功,呼叫端要拆批找出壞列(手冊 §6.6)。
 * 結構性錯誤(isSchemaError)與其他錯誤(連線、逾時、記憶體、Too many parts)都視為暫時性,退避重試。
 * 代碼對照 ClickHouse 26.3 src/Common/ErrorCodes.cpp。
 */
const DATA_ERROR_CODES = new Set([
  6, // CANNOT_PARSE_TEXT
  26, // CANNOT_PARSE_QUOTED_STRING
  27, // CANNOT_PARSE_INPUT_ASSERTION_FAILED
  32, // ATTEMPT_TO_READ_AFTER_EOF
  38, // CANNOT_PARSE_DATE
  41, // CANNOT_PARSE_DATETIME
  53, // TYPE_MISMATCH
  69, // ARGUMENT_OUT_OF_BOUND
  70, // CANNOT_CONVERT_TYPE
  72, // CANNOT_PARSE_NUMBER
  117, // INCORRECT_DATA
  131, // TOO_LARGE_STRING_SIZE
  321, // VALUE_IS_OUT_OF_RANGE_OF_DATA_TYPE
  675, // CANNOT_PARSE_IPV4
  676, // CANNOT_PARSE_IPV6
]);

/**
 * 結構性錯誤:表或欄位對不上(migration 沒套用、程式與 schema 不同步)、帳密或權限錯誤。
 * 每一列都會失敗,拆批只會把整批丟光,所以**當暫時性錯誤**:不拆批、不 ACK、退避重試,等人修好(程式碼審查 2026-11-10 #1)。
 * 117 INCORRECT_DATA 也用在 JSONEachRow 的「Unknown field found」,依訊息另外判斷。
 */
const SCHEMA_ERROR_CODES = new Set([
  16, // NO_SUCH_COLUMN_IN_TABLE
  47, // UNKNOWN_IDENTIFIER
  60, // UNKNOWN_TABLE
  81, // UNKNOWN_DATABASE
  192, // UNKNOWN_USER
  193, // WRONG_PASSWORD
  194, // REQUIRED_PASSWORD
  497, // ACCESS_DENIED
  516, // AUTHENTICATION_FAILED
]);
export const isSchemaError = (e: unknown): boolean =>
  e instanceof ClickHouseError && e.code !== undefined && (SCHEMA_ERROR_CODES.has(e.code) || /unknown field|no such column|missing columns/i.test(e.message));

/** 資料錯誤(可拆批找出壞列);結構性錯誤除外 */
export const isDataError = (e: unknown): boolean =>
  e instanceof ClickHouseError && e.code !== undefined && DATA_ERROR_CODES.has(e.code) && !isSchemaError(e);

/** 已知的暫時性錯誤(逾時、同時查詢過多、記憶體、Too many parts 等):無限重試,不拆批 */
const TRANSIENT_CODES = new Set([159, 202, 209, 210, 241, 252, 425]);

/**
 * 不在任何清單裡的 HTTP 400(ClickHouse 對輸入問題回 400)。整批連續失敗多次後,寫入端改用拆批找出壞列,
 * 避免一筆無法分類的壞資料卡住整條管線(資安審查 2026-11-10 M2)。
 */
export const isUnknownBadRequest = (e: unknown): boolean =>
  e instanceof ClickHouseError && e.status === 400 && !isSchemaError(e) && !isDataError(e) && !(e.code !== undefined && TRANSIENT_CODES.has(e.code));

export interface ClickHouseWriter {
  /**
   * 一批列寫進 table(JSONEachRow)。dedupToken:同一批重送時用同一個 token,伺服器略過已寫過的區塊
   * (表要設 non_replicated_deduplication_window,schema.sql 已設 1000)。失敗拋 ClickHouseError。
   */
  insert(table: TableKey, rows: readonly Record<string, unknown>[], dedupToken: string): Promise<void>;
  /** 連線與帳密是否可用(SELECT 1) */
  ping(): Promise<void>;
}

type Fetch = typeof fetch;

export function createClickHouseWriter(cfg: ClickHouseConfig, fetchImpl: Fetch = fetch): ClickHouseWriter {
  const base = new URL(cfg.url);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('CLICKHOUSE_URL 必須是 http:// 或 https://');
  if (base.username || base.password) throw new Error('CLICKHOUSE_URL 不可帶帳密,請改用 CLICKHOUSE_USER 與 CLICKHOUSE_PASSWORD_FILE');
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const headers = { 'X-ClickHouse-User': cfg.user, 'X-ClickHouse-Key': cfg.password };

  async function post(params: Record<string, string>, body: string): Promise<string> {
    const u = new URL(base);
    u.pathname = '/';
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    let res: Response;
    try {
      // redirect: 'error':轉址時 X-ClickHouse-Key 會被帶到別的主機,一律不跟隨(資安審查 L4)
      res = await fetchImpl(u, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // 連線拒絕、DNS、逾時:不帶 URL 以外的細節
      const name = (e as Error).name === 'TimeoutError' ? `逾時 ${timeoutMs} ms` : ((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name);
      throw new ClickHouseError(`ClickHouse 連線失敗:${name}`, undefined, undefined);
    }
    const text = await res.text();
    if (!res.ok) {
      const code = Number(res.headers.get('x-clickhouse-exception-code') ?? /Code: (\d+)/.exec(text)?.[1]);
      // 只留第一行、截斷;ClickHouse 的解析錯誤訊息可能帶一小段輸入資料,不寫進心跳以外的地方
      const first = text.split('\n', 1)[0]?.slice(0, 200) ?? '';
      throw new ClickHouseError(`ClickHouse HTTP ${res.status}:${first}`, Number.isFinite(code) ? code : undefined, res.status);
    }
    return text;
  }

  return {
    async insert(table, rows, dedupToken) {
      if (!rows.length) return;
      await post(
        {
          query: `INSERT INTO ${TABLES[table]} FORMAT JSONEachRow`,
          insert_deduplication_token: dedupToken,
          // received_at 以 ISO 8601(UTC,Z 結尾)送;event_time 是台灣當地時間字串,依欄位時區 Asia/Taipei 解析
          date_time_input_format: 'best_effort',
          // 欄位名稱寫錯時直接失敗,不默默丟掉
          input_format_skip_unknown_fields: '0',
          // 等寫入完成才回應(成功才 ACK Redis)
          wait_end_of_query: '1',
          // 26.x 的 HTTP 寫入預設走 async insert(伺服器端合併批次),去重 token 不生效、成功回應也不代表已落地;
          // 本服務自己批次,一律同步寫入(2026-11-11 CI 整合測試發現:同一 token 重送被寫了兩次)
          async_insert: '0',
          // 物化檢視(每小時彙總)也用衍生的 token 去重:26.x 來源表略過重送的區塊時仍會推給物化檢視,
          // 不開這個彙總會重複計算(目標表要設 non_replicated_deduplication_window,migrations/002)
          deduplicate_blocks_in_dependent_materialized_views: '1',
        },
        rows.map((r) => JSON.stringify(r)).join('\n'),
      );
    },
    async ping() {
      const out = await post({ query: 'SELECT 1' }, '');
      if (out.trim() !== '1') throw new ClickHouseError('ClickHouse ping 回應不符', undefined, undefined);
    },
  };
}
