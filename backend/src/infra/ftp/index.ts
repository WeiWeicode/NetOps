/**
 * FTP(10.10.130.66,FileZilla Server;由舊版 server/lib/ftp.js 搬移,IMPL-PLAN B2)
 *   - **唯讀**:只列目錄與下載,不刪除、不改名、不上傳(AGENT.md §7.4)
 *   - 每個操作開一條新連線、用完就關;同時連線數由 FTP_MAX_CONNECTIONS 控制,匯入與明細查詢共用(AGENT.md §6)
 *   - 畫面上的瀏覽(listDir)優先拿到連線,最多等 FTP_WAIT_MS,等不到回 503 NETOPS_FTP_BUSY(不讓請求超過路由逾時);
 *     背景工作(匯入、明細查詢、AD)排隊等候,可用 AbortSignal 取消
 *   - 下載以串流讀取,不存到本機(原始 log 不落地,§7.2);withSession.download 只給 AD 小檔,有大小上限
 *   - 錯誤回 502 NETOPS_FTP_UNAVAILABLE,訊息只寫分類過的原因(逾時、拒絕連線、帳密錯誤、FTP 回應碼…),
 *     不含 FTP 主機、port 與原始錯誤;原始錯誤放在 cause,只寫進服務日誌(AGENT.md §7.5、§8)
 * 與舊版不同:連線逾時 30 秒改 20 秒;FTPS 預設驗證憑證;列目錄失敗由 404 改 502(docs/API.md §8)。
 */
import path from 'node:path';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { Client } from 'basic-ftp';
import type { FtpConfig } from '../../config.js';
import { AppError } from '../../errors.js';

export interface FtpEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modified: Date | null;
  /** 伺服器回傳的原始修改時間字串(解析不出 modified 時使用;AD 匯入比對檔案是否變更,格式同舊版) */
  rawModified: string;
}

export interface FtpStream {
  stream: Readable;
  /** 傳輸結束(成功或失敗)時 resolve;失敗時 stream 會收到錯誤 */
  done: Promise<void>;
  /** 中斷並關閉連線(取消、達到筆數上限、讀取失敗) */
  abort(): void;
}

/** 同一條連線做多個操作(AD 匯入逐一下載一天的檔案)。fn 內不可再呼叫 listDir / openStream(連線上限 1 時會互等) */
export interface FtpSession {
  list(dir: string): Promise<FtpEntry[]>;
  download(file: string): Promise<Buffer>;
}

export interface Ftp {
  /** 畫面傳來的路徑 → FTP 絕對路徑;不可跳出 FTP_ROOT */
  safePath(p?: string): string;
  /** 畫面瀏覽用:優先、等候有上限 */
  listDir(dir: string): Promise<FtpEntry[]>;
  /** 背景工作用:排隊等候;signal 中止時放棄等候或中斷傳輸 */
  openStream(file: string, opts?: { signal?: AbortSignal }): Promise<FtpStream>;
  withSession<T>(fn: (s: FtpSession) => Promise<T>, opts?: { signal?: AbortSignal }): Promise<T>;
}

/** 畫面瀏覽等連線的上限:等候 + 連線(20 秒)+ 列目錄要在路由逾時 60 秒內 */
export const FTP_WAIT_MS = 25_000;
/** withSession.download 的檔案大小上限(AD 每日匯出檔通常幾 MB) */
export const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

export const cancelledError = () => Object.assign(new AppError(409, 'NETOPS_JOB_CANCELLED', '已取消'), { cancelled: true });

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** 連線上限:優先的等候者先拿到;可設等候逾時與取消 */
export class Semaphore {
  private active = 0;
  private readonly high: Waiter[] = [];
  private readonly low: Waiter[] = [];
  constructor(private readonly max: number) {}

  async acquire({ priority = false, timeoutMs, signal }: { priority?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<() => void> {
    if (signal?.aborted) throw cancelledError();
    if (this.active < this.max) this.active++;
    else {
      const list = priority ? this.high : this.low;
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const leave = (err: unknown) => {
          const i = list.indexOf(w);
          if (i >= 0) list.splice(i, 1);
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        };
        const onAbort = () => leave(cancelledError());
        const w: Waiter = {
          resolve: () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
          reject: leave,
        };
        list.push(w);
        if (timeoutMs) timer = setTimeout(() => leave(new AppError(503, 'NETOPS_FTP_BUSY', 'FTP 連線忙碌中(匯入或查詢進行中),請稍後再試')), timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // 名額直接交給下一位(active 不變)
      const next = this.high.shift() ?? this.low.shift();
      if (next) next.resolve();
      else this.active--;
    };
  }
}

const sortEntries = (a: FtpEntry, b: FtpEntry) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-Hant', { numeric: true }) : a.dir ? -1 : 1);
/**
 * FTP 原始錯誤 → 給使用者看的分類(不含主機、port 與錯誤原文)
 * basic-ftp 的 FTPError 帶 FTP 回應碼(code 為數字);連線錯誤帶 Node 的 errno 代碼(code 為字串)
 */
export function ftpReason(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown };
  const msg = String(e?.message ?? '');
  if (typeof e?.code === 'number') {
    const known: Record<number, string> = { 421: '伺服器忙碌或已關閉連線', 425: '無法建立資料連線', 426: '資料連線中斷', 450: '檔案暫時無法使用', 451: '伺服器處理錯誤', 530: '帳號或密碼錯誤', 550: '檔案或目錄不存在,或沒有權限' };
    return `${known[e.code] ?? 'FTP 伺服器回應錯誤'}(FTP ${e.code})`;
  }
  const code = typeof e?.code === 'string' ? e.code : '';
  if (code === 'ECONNREFUSED') return '拒絕連線';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '找不到主機';
  if (code === 'ECONNRESET' || code === 'EPIPE') return '連線中斷';
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) return '連線逾時';
  if (/cert|self.signed|tls|ssl/i.test(code + msg)) return 'TLS 憑證驗證失敗';
  if (/超過 \d+ MB 上限/.test(msg)) return msg;
  return '連線或傳輸失敗';
}

/** 502:訊息只含分類過的原因,原始錯誤放在 cause(寫日誌用) */
export function unavailable(what: string, cause: unknown): AppError {
  const e = new AppError(502, 'NETOPS_FTP_UNAVAILABLE', `${what}:${ftpReason(cause)}`);
  (e as { cause?: unknown }).cause = cause;
  return e;
}

export function createFtp(config: FtpConfig | null): Ftp {
  if (!config) {
    const notConfigured = (): never => {
      throw new AppError(503, 'NETOPS_FTP_NOT_CONFIGURED', '尚未設定 FTP(FTP_HOST)');
    };
    return { safePath: notConfigured, listDir: async () => notConfigured(), openStream: async () => notConfigured(), withSession: async () => notConfigured() };
  }
  const slots = new Semaphore(config.maxConnections);

  function safePath(p = ''): string {
    // 控制字元一律拒絕(basic-ftp 也會擋 CR / LF / NUL,這裡多一層)
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(String(p))) throw new AppError(400, 'VALIDATION_FAILED', '路徑含不允許的字元', [{ field: 'path', message: '不可含控制字元' }]);
    const abs = path.posix.normalize('/' + String(p).replace(/\\/g, '/')).replace(/\/+$/, '') || '/';
    const root = config!.root;
    if (root !== '/' && abs !== root && !abs.startsWith(root + '/')) throw new AppError(403, 'NETOPS_FTP_PATH_FORBIDDEN', `只能存取 ${root} 以下的目錄`);
    return abs;
  }

  async function connect(): Promise<Client> {
    const c = new Client(20000);
    try {
      await c.access({
        host: config!.host,
        port: config!.port,
        user: config!.user,
        password: config!.password,
        secure: config!.secure,
        secureOptions: { rejectUnauthorized: !config!.tlsInsecure },
      });
    } catch (err) {
      c.close();
      throw unavailable('FTP 連線失敗', err);
    }
    return c;
  }

  async function list(c: Client, dir: string): Promise<FtpEntry[]> {
    const abs = safePath(dir);
    try {
      const entries = await c.list(abs);
      return entries
        .filter((f) => f.name !== '.' && f.name !== '..')
        .map((f) => ({ name: f.name, path: path.posix.join(abs, f.name), dir: f.isDirectory, size: f.size, modified: f.modifiedAt ?? null, rawModified: f.rawModifiedAt }))
        .sort(sortEntries);
    } catch (err) {
      throw unavailable(`無法讀取 FTP 目錄 ${abs}`, err);
    }
  }

  async function session<T>(fn: (s: FtpSession) => Promise<T>, acquireOpts: Parameters<Semaphore['acquire']>[0]): Promise<T> {
    const release = await slots.acquire(acquireOpts);
    let c: Client | null = null;
    try {
      c = await connect();
      const client = c;
      return await fn({
        list: (dir) => list(client, dir),
        async download(file) {
          const abs = safePath(file);
          const chunks: Buffer[] = [];
          let size = 0;
          try {
            await client.downloadTo(
              new Writable({
                write(chunk: Buffer, _e, cb) {
                  size += chunk.length;
                  if (size > DOWNLOAD_MAX_BYTES) return cb(new Error(`檔案超過 ${DOWNLOAD_MAX_BYTES / 1024 / 1024} MB 上限`));
                  chunks.push(chunk);
                  cb();
                },
              }),
              abs,
            );
          } catch (err) {
            throw unavailable(`讀取 FTP 檔案失敗 ${abs}`, err);
          }
          return Buffer.concat(chunks);
        },
      });
    } finally {
      c?.close();
      release();
    }
  }

  async function openStream(file: string, { signal }: { signal?: AbortSignal } = {}): Promise<FtpStream> {
    const abs = safePath(file);
    const release = await slots.acquire({ signal });
    let opened: Client | null = null;
    try {
      opened = await connect();
      if (signal?.aborted) throw cancelledError();
    } catch (err) {
      // connect 後才發現被取消:已連上的也要關
      opened?.close();
      release();
      throw err;
    }
    const c = opened;
    const stream = new PassThrough({ highWaterMark: 1 << 20 });
    let aborted = false;
    const abort = () => {
      aborted = true;
      c.close();
      stream.destroy();
    };
    signal?.addEventListener('abort', abort, { once: true });
    const done = c
      .downloadTo(stream, abs)
      .then(() => undefined)
      .catch((err) => {
        if (!aborted) stream.destroy(unavailable(`讀取 FTP 檔案失敗 ${abs}`, err));
      })
      .finally(() => {
        signal?.removeEventListener('abort', abort);
        c.close();
        release();
      });
    return { stream, done, abort };
  }

  return {
    safePath,
    listDir: (dir) => session((s) => s.list(dir), { priority: true, timeoutMs: FTP_WAIT_MS }),
    openStream,
    withSession: (fn, { signal } = {}) => session(fn, { signal }),
  };
}
