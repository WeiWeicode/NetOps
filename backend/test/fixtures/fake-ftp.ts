/**
 * 假 FTP(AGENT.md §9:不對正式 FTP 測試):記憶體中的檔案,實作 infra/ftp 的 Ftp 介面
 */
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { AppError } from '../../src/errors.js';
import type { Ftp, FtpEntry } from '../../src/infra/ftp/index.js';

export interface FakeFtp extends Ftp {
  files: Map<string, { data: Buffer; modified: Date }>;
  put(p: string, data: string | Buffer, modified?: Date): void;
  /** 下一次讀檔時中途斷線(測試傳輸不完整) */
  failNext: boolean;
  opened: number;
  /** abort() 被呼叫的次數(讀取失敗時要中斷傳輸) */
  aborted: number;
}

export function createFakeFtp(root = '/'): FakeFtp {
  const files = new Map<string, { data: Buffer; modified: Date }>();
  const safePath = (p = '') => {
    const abs = path.posix.normalize('/' + String(p).replace(/\\/g, '/')).replace(/\/+$/, '') || '/';
    if (root !== '/' && abs !== root && !abs.startsWith(root + '/')) throw new AppError(403, 'NETOPS_FTP_PATH_FORBIDDEN', `只能存取 ${root} 以下的目錄`);
    return abs;
  };
  const list = (dir: string): FtpEntry[] => {
    const abs = safePath(dir);
    const out = new Map<string, FtpEntry>();
    for (const [p, f] of files) {
      if (!p.startsWith(abs === '/' ? '/' : abs + '/')) continue;
      const rest = p.slice(abs === '/' ? 1 : abs.length + 1);
      const [name, ...more] = rest.split('/');
      if (!name) continue;
      if (more.length) out.set(name, { name, path: path.posix.join(abs, name), dir: true, size: 0, modified: null, rawModified: '' });
      else out.set(name, { name, path: p, dir: false, size: f.data.length, modified: f.modified, rawModified: '' });
    }
    return [...out.values()].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  };
  const ftp: FakeFtp = {
    files,
    failNext: false,
    opened: 0,
    aborted: 0,
    put(p, data, modified = new Date('2026-11-03T00:05:00Z')) {
      files.set(p, { data: Buffer.isBuffer(data) ? data : Buffer.from(data), modified });
    },
    safePath,
    listDir: async (dir) => list(dir),
    async openStream(file, { signal } = {}) {
      const abs = safePath(file);
      if (signal?.aborted) throw Object.assign(new AppError(409, 'NETOPS_JOB_CANCELLED', '已取消'), { cancelled: true });
      const f = files.get(abs);
      if (!f) throw new AppError(502, 'NETOPS_FTP_UNAVAILABLE', `讀取 FTP 檔案失敗 ${abs}:550 not found`);
      ftp.opened++;
      const stream = new PassThrough();
      const fail = ftp.failNext;
      ftp.failNext = false;
      // 分段寫入,模擬網路串流
      const data = fail ? f.data.subarray(0, Math.floor(f.data.length / 2)) : f.data;
      let aborted = false;
      signal?.addEventListener('abort', () => {
        aborted = true;
        stream.destroy();
      });
      const done = (async () => {
        for (let i = 0; i < data.length && !aborted; i += 64 * 1024) {
          if (!stream.write(data.subarray(i, i + 64 * 1024))) await new Promise((r) => stream.once('drain', r));
        }
        if (!aborted) stream.end();
      })();
      return {
        stream,
        done,
        abort() {
          aborted = true;
          ftp.aborted++;
          stream.destroy();
        },
      };
    },
    async withSession(fn) {
      return fn({
        list: async (dir) => list(dir),
        async download(file) {
          const f = files.get(safePath(file));
          if (!f) throw new AppError(502, 'NETOPS_FTP_UNAVAILABLE', `讀取 FTP 檔案失敗 ${file}`);
          return f.data;
        },
      });
    },
  };
  return ftp;
}
