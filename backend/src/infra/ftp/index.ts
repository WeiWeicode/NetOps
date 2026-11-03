/**
 * FTP(10.10.130.66,FileZilla Server;由舊版 server/lib/ftp.js 搬移,IMPL-PLAN B2)
 *   - **唯讀**:只列目錄與下載,不刪除、不改名、不上傳(AGENT.md §7.4)
 *   - 每個操作開一條新連線、用完就關;同時連線數由 FTP_MAX_CONNECTIONS 控制,匯入與明細查詢共用(AGENT.md §6)
 *   - 下載以串流讀取,不存到本機(原始 log 不落地,§7.2)
 *   - 錯誤回 502 NETOPS_FTP_UNAVAILABLE,訊息含 FTP 回應,不含帳密
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
}

export interface FtpStream {
  stream: Readable;
  /** 傳輸結束(成功或失敗)時 resolve;失敗時 stream 會收到錯誤 */
  done: Promise<void>;
  /** 中斷並關閉連線(取消、達到筆數上限) */
  abort(): void;
}

/** 同一條連線做多個操作(AD 匯入逐一下載一天的檔案) */
export interface FtpSession {
  list(dir: string): Promise<FtpEntry[]>;
  download(file: string): Promise<Buffer>;
}

export interface Ftp {
  /** 畫面傳來的路徑 → FTP 絕對路徑;不可跳出 FTP_ROOT */
  safePath(p?: string): string;
  listDir(dir: string): Promise<FtpEntry[]>;
  openStream(file: string): Promise<FtpStream>;
  withSession<T>(fn: (s: FtpSession) => Promise<T>): Promise<T>;
}

/** 連線上限:先到先用;openStream 持有到傳輸結束或中斷 */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

const sortEntries = (a: FtpEntry, b: FtpEntry) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-Hant', { numeric: true }) : a.dir ? -1 : 1);
const unavailable = (msg: string) => new AppError(502, 'NETOPS_FTP_UNAVAILABLE', msg);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createFtp(config: FtpConfig | null): Ftp {
  if (!config) {
    const notConfigured = (): never => {
      throw new AppError(503, 'NETOPS_FTP_NOT_CONFIGURED', '尚未設定 FTP(FTP_HOST)');
    };
    return { safePath: notConfigured, listDir: async () => notConfigured(), openStream: async () => notConfigured(), withSession: async () => notConfigured() };
  }
  const slots = new Semaphore(config.maxConnections);

  function safePath(p = ''): string {
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
      throw unavailable(`FTP 連線失敗:${errText(err)}`);
    }
    return c;
  }

  async function list(c: Client, dir: string): Promise<FtpEntry[]> {
    const abs = safePath(dir);
    try {
      const entries = await c.list(abs);
      return entries
        .filter((f) => f.name !== '.' && f.name !== '..')
        .map((f) => ({ name: f.name, path: path.posix.join(abs, f.name), dir: f.isDirectory, size: f.size, modified: f.modifiedAt ?? null }))
        .sort(sortEntries);
    } catch (err) {
      throw unavailable(`無法讀取 FTP 目錄 ${abs}:${errText(err)}`);
    }
  }

  async function withSession<T>(fn: (s: FtpSession) => Promise<T>): Promise<T> {
    const release = await slots.acquire();
    let c: Client | null = null;
    try {
      c = await connect();
      const client = c;
      return await fn({
        list: (dir) => list(client, dir),
        async download(file) {
          const abs = safePath(file);
          const chunks: Buffer[] = [];
          try {
            await client.downloadTo(new Writable({ write(chunk, _e, cb) { chunks.push(chunk); cb(); } }), abs);
          } catch (err) {
            throw unavailable(`讀取 FTP 檔案失敗 ${abs}:${errText(err)}`);
          }
          return Buffer.concat(chunks);
        },
      });
    } finally {
      c?.close();
      release();
    }
  }

  async function openStream(file: string): Promise<FtpStream> {
    const abs = safePath(file);
    const release = await slots.acquire();
    let c: Client;
    try {
      c = await connect();
    } catch (err) {
      release();
      throw err;
    }
    const stream = new PassThrough({ highWaterMark: 1 << 20 });
    let aborted = false;
    const done = c
      .downloadTo(stream, abs)
      .then(() => undefined)
      .catch((err) => {
        if (!aborted) stream.destroy(unavailable(`讀取 FTP 檔案失敗 ${abs}:${errText(err)}`));
      })
      .finally(() => {
        c.close();
        release();
      });
    const abort = () => {
      aborted = true;
      c.close();
      stream.destroy();
    };
    return { stream, done, abort };
  }

  return { safePath, listDir: (dir) => withSession((s) => s.list(dir)), openStream, withSession };
}
