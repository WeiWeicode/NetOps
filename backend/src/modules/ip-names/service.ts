/**
 * IP 對照表服務(IMPL-PLAN AC3):單筆編輯、匯入預覽 / 確認、查名稱(PA 各 API 的 names、Log 明細名稱搜尋、AI 提示詞)。
 *   - 存取只經 infra/store(listIpNames / saveIpNames);索引快取在記憶體,寫入後重建(單一容器,AGENT.md §7.3)
 *   - 匯入預覽只保留在記憶體 15 分鐘、每人 1 份;確認時對照表版本已變(別人改過)回 409
 *   - 姓名、部門是個資:這裡不寫日誌;錯誤訊息只帶列號與 IP
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';
import type { IpNameStore } from '../../infra/store/index.js';
import {
  buildIndex,
  collectIps,
  ipsInText,
  diffImport,
  MAX_ENTRIES,
  normalizeInput,
  rowsToInputs,
  type ImportDiff,
  type ImportRowError,
  type IpNameEntry,
  type IpNameIndex,
  type IpNameInput,
  type IpNameLabel,
  type NameMatch,
} from './core.js';

const PREVIEW_TTL_MS = 15 * 60_000;

export interface ImportPreview {
  id: string;
  fileName: string;
  total: number;
  skipped: number;
  errors: ImportRowError[];
  /** 各類筆數(diff 的清單各最多 PREVIEW_LIST 筆) */
  counts: { added: number; changed: number; removed: number; unchanged: number };
  diff: ImportDiff;
  expiresAt: string;
}

/** 預覽回應每類最多列出的筆數(回應大小) */
export const PREVIEW_LIST = 500;

export type IpNameService = ReturnType<typeof createIpNameService>;

export function createIpNameService(store: IpNameStore, now: () => number = Date.now) {
  let cache: { mtime: number | null; version: number; entries: IpNameEntry[]; index: IpNameIndex } | null = null;
  const previews = new Map<string, { owner: string; at: number; baseVersion: number; next: IpNameEntry[]; view: ImportPreview }>();

  /** 對照表與索引(檔案被換掉時重讀) */
  function current() {
    const mtime = store.mtime();
    if (!cache || cache.mtime !== mtime) {
      const f = store.listIpNames<IpNameEntry>();
      cache = { mtime, version: f.version, entries: f.entries, index: buildIndex(f.entries) };
    }
    return cache;
  }
  function save(version: number, entries: IpNameEntry[]) {
    store.saveIpNames({ version, entries });
    cache = { mtime: store.mtime(), version, entries, index: buildIndex(entries) };
  }
  const stampNow = () => new Date(now()).toISOString();
  const invalid = (errors: { field: string; message: string }[]) => new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', errors);
  const duplicate = () => new AppError(409, 'NETOPS_IP_NAME_DUPLICATE', '對照表已有這個 IP / 網段');
  const notFound = () => new AppError(404, 'NETOPS_IP_NAME_NOT_FOUND', '找不到這筆對照');
  const sweep = () => {
    for (const [id, p] of previews) if (now() - p.at > PREVIEW_TTL_MS) previews.delete(id);
  };

  return {
    /** 查詢(關鍵字比對 IP、姓名、部門、設備名稱、設備類型、備註;依 IP 排序) */
    list(q = '', page = 1, pageSize = 50) {
      const c = current();
      const k = q.trim().toLowerCase();
      const all = (k ? c.entries.filter((e) => [e.ip, e.name, e.department, e.device, e.deviceType, e.note].some((v) => v.toLowerCase().includes(k))) : c.entries).slice().sort(byIp);
      return { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize, version: c.version };
    },
    /** 全部(匯出) */
    all: () => current().entries.slice().sort(byIp),

    create(input: IpNameInput, by: string): IpNameEntry {
      const r = normalizeInput(input);
      if (!r.value) throw invalid(r.errors);
      const c = current();
      if (c.entries.some((e) => e.ip === r.value!.ip)) throw duplicate();
      if (c.entries.length >= MAX_ENTRIES) throw new AppError(409, 'NETOPS_IP_NAME_LIMIT', `對照表最多 ${MAX_ENTRIES} 筆`);
      const e: IpNameEntry = { ...r.value, id: randomUUID(), updatedAt: stampNow(), updatedBy: by };
      save(c.version + 1, [...c.entries, e]);
      return e;
    },
    update(id: string, input: IpNameInput, by: string): IpNameEntry {
      const r = normalizeInput(input);
      if (!r.value) throw invalid(r.errors);
      const c = current();
      const old = c.entries.find((e) => e.id === id);
      if (!old) throw notFound();
      if (c.entries.some((e) => e.id !== id && e.ip === r.value!.ip)) throw duplicate();
      const e: IpNameEntry = { ...old, ...r.value, updatedAt: stampNow(), updatedBy: by };
      save(c.version + 1, c.entries.map((x) => (x.id === id ? e : x)));
      return e;
    },
    /** 已不存在回 false(冪等) */
    remove(id: string): boolean {
      const c = current();
      if (!c.entries.some((e) => e.id === id)) return false;
      save(c.version + 1, c.entries.filter((e) => e.id !== id));
      return true;
    },

    /** 匯入預覽:解析好的列(含欄名列)→ 差異;不寫入 */
    preview(rows: string[][], fileName: string, owner: string, by: string): ImportPreview {
      sweep();
      const parsed = rowsToInputs(rows);
      if (!parsed.inputs.length && parsed.errors.length && parsed.errors[0]!.row === 1)
        throw new AppError(400, 'NETOPS_IP_NAME_IMPORT_INVALID', parsed.errors[0]!.message);
      // 空檔(只有欄名或全部有問題)會把對照表整份刪光:不接受,要清空請逐筆刪除
      if (!parsed.inputs.length) throw new AppError(400, 'NETOPS_IP_NAME_IMPORT_INVALID', parsed.errors.length ? `檔案沒有可匯入的資料(${parsed.errors.length} 列有問題,第一個在第 ${parsed.errors[0]!.row} 列)` : '檔案沒有任何資料列');
      if (parsed.inputs.length > MAX_ENTRIES) throw new AppError(400, 'NETOPS_IP_NAME_IMPORT_INVALID', `對照表最多 ${MAX_ENTRIES} 筆,檔案有 ${parsed.inputs.length} 筆`);
      const c = current();
      const { diff, next } = diffImport(c.entries, parsed.inputs, { at: stampNow(), by, newId: randomUUID });
      // 每人只保留最新一份預覽
      for (const [id, p] of previews) if (p.owner === owner) previews.delete(id);
      const id = randomUUID();
      const view: ImportPreview = {
        id,
        fileName,
        total: parsed.inputs.length,
        skipped: parsed.skipped,
        errors: parsed.errors.slice(0, 200),
        counts: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, unchanged: diff.unchanged },
        diff: { added: diff.added.slice(0, PREVIEW_LIST), changed: diff.changed.slice(0, PREVIEW_LIST), removed: diff.removed.slice(0, PREVIEW_LIST), unchanged: diff.unchanged },
        expiresAt: new Date(now() + PREVIEW_TTL_MS).toISOString(),
      };
      previews.set(id, { owner, at: now(), baseVersion: c.version, next, view });
      return view;
    },
    /** 確認匯入(整份取代);預覽不存在 / 逾期 / 別人的回 404,預覽後對照表被改過回 409 */
    confirm(id: string, owner: string) {
      sweep();
      const p = previews.get(id);
      if (!p || p.owner !== owner) throw new AppError(404, 'NETOPS_IP_NAME_IMPORT_NOT_FOUND', '找不到這次匯入預覽(可能已逾期 15 分鐘),請重新上傳');
      const c = current();
      if (c.version !== p.baseVersion) {
        previews.delete(id);
        throw new AppError(409, 'NETOPS_IP_NAME_IMPORT_STALE', '預覽之後對照表已被修改,請重新上傳檔案預覽');
      }
      save(c.version + 1, p.next);
      previews.delete(id);
      return { ...p.view.counts, total: p.next.length };
    },
    /** 取消預覽(冪等) */
    discard(id: string, owner: string) {
      const p = previews.get(id);
      if (p && p.owner === owner) previews.delete(id);
    },

    /** 這些 IP 的名稱(只回查得到的) */
    labels: (ips: Iterable<string>): Record<string, IpNameLabel> => current().index.labels(ips),
    /** 回應物件附上 names(只含本回應出現的 IP);對照表是空的時回空物件 */
    namesFor(payload: unknown): Record<string, IpNameLabel> {
      const c = current();
      return c.index.size ? c.index.labels(collectIps(payload)) : {};
    },
    match: (keyword: string): NameMatch => current().index.match(keyword),
    lookup: (ip: string) => current().index.lookup(ip),
    size: () => current().index.size,
  };
}

/** IP 排序(數值;網段在前) */
function byIp(a: IpNameEntry, b: IpNameEntry): number {
  const n = (s: string) => {
    const [ip = '', bits = '32'] = s.split('/');
    return ip.split('.').reduce((x, p) => x * 256 + Number(p), 0) * 64 + Number(bits);
  };
  return n(a.ip) - n(b.ip);
}

/**
 * AI 提示詞附的 IP 對照(D45;AQ2「全部不遮,姓名也送」):text 中出現、查得到名稱的 IP,最多 max 筆。
 * 只送公司內部 AI 主機(D23);不寫日誌。沒有任何對照時回空字串
 */
export function aiNamesSection(svc: Pick<IpNameService, 'labels' | 'size'>, text: string, max = 200): string {
  if (!svc.size()) return '';
  const labels = Object.entries(svc.labels(ipsInText(text, max * 3))).slice(0, max);
  if (!labels.length) return '';
  const line = ([ip, l]: [string, IpNameLabel]) => {
    const who = [l.name, l.department && `部門 ${l.department}`].filter(Boolean).join(',');
    const dev = [l.device, l.deviceType].filter(Boolean).join(',');
    return `- ${ip}:${[who, dev && `設備 ${dev}`].filter(Boolean).join(';')}`;
  };
  return `\n\n## IP 對照表(公司內部 IP 的使用者 / 設備;回答時可直接稱呼名稱)\n${labels.map(line).join('\n')}`;
}
