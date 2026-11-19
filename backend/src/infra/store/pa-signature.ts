/**
 * PA 威脅特徵碼版本歷史與上一版精簡索引(TS-2;docs/THREAT-SIGNATURE-PLAN.md §4.2、Claude 審查 D1 / D2):pa-signature/ 目錄。
 *   pa-signature/index.json                   持久基準日 baselineAt / baselineVersion + 最近 90 份版本摘要清單(新到舊)
 *   pa-signature/history/<threatVersion>.json 該版差異(added / changed / removed)與版本摘要(不存 3.5 萬筆全量)
 *   pa-signature/latest-index.json.gz         上一版精簡索引(id → 必要欄位與 cvesHash)與各 id 首次出現紀錄(firstSeen)
 *
 * 寫入順序(承受中途失敗,D1):
 *   1. 原子寫入 history/<threatVersion>.json(.tmp + rename)
 *   2. 原子寫入 index.json(保留最新 90 份;基準日以第一份為準,不依賴 Redis 7 天 TTL,D2)
 *   3. 最後原子寫入 latest-index.json.gz
 *   4. 清理超出 90 份的舊差異檔
 * 中途任何一步失敗都不會造成「精簡索引已換成新版、差異卻沒寫入」的不一致狀態;重跑 sync 具有冪等性。
 */
import path from 'node:path';
import { ensureDir, listFiles, readGzipJson, readJson, removeFile, safeJoin, writeGzipJson, writeJson } from './files.js';

/** 保留版本歷史份數(TS-Q3 已決定:90 份) */
export const PA_SIG_HISTORY_KEEP = 90;
/** threat-version 檔名白名單(例 9173-10354;拒絕 .. 與路徑字元) */
export const PA_SIG_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type SigKind = 'vulnerability' | 'spyware';

export interface CompactSigEntry {
  id: string;
  kind: SigKind;
  name: string;
  severity: string;
  category: string;
  defaultAction: string | null;
  disabled: boolean;
  cves: string[];
  cvesHash: string;
}

export interface SigFirstSeen {
  version: string;
  seenAt: string;
  isBaseline: boolean;
  /** true = 因精簡索引遺失或損壞而重建,不得視為該版新增(P2) */
  rebuilt?: boolean;
}

export interface LatestSigIndex {
  threatVersion: string;
  savedAt: string;
  hash: string;
  items: Record<string, CompactSigEntry>;
  firstSeen: Record<string, SigFirstSeen>;
}

export interface SigDiffSummaryItem {
  id: string;
  kind: SigKind;
  name: string;
  severity: string;
  category: string;
  defaultAction: string | null;
  disabled: boolean;
  cves: string[];
}

export interface SigDiffFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface SigDiffChangedItem {
  id: string;
  kind: SigKind;
  name: string;
  severity: string;
  category: string;
  fields: SigDiffFieldChange[];
}

export interface PaSigVersionMeta {
  threatVersion: string;
  releaseDate: string | null;
  fetchedAt: string;
  savedAt: string;
  isBaseline: boolean;
  /** true = 有歷史但精簡索引遺失或損壞而重建,本版差異無法計算(P2) */
  rebuilt: boolean;
  counts: { vulnerability: number; spyware: number; total: number };
  added: number;
  changed: number;
  removed: number;
  hash: string;
}

export interface PaSigVersionDiffFile {
  threatVersion: string;
  baseVersion: string | null;
  releaseDate: string | null;
  fetchedAt: string;
  savedAt: string;
  isBaseline: boolean;
  /** true = 有歷史但精簡索引遺失或損壞而重建,本版差異無法計算(P2) */
  rebuilt: boolean;
  counts: { vulnerability: number; spyware: number; total: number };
  hash: string;
  added: SigDiffSummaryItem[];
  changed: SigDiffChangedItem[];
  removed: SigDiffSummaryItem[];
}

export interface PaSigHistoryIndex {
  /** 第一份基準版本的寫入時間(D2:不依賴 Redis meta 的 baselineAt) */
  baselineAt: string | null;
  baselineVersion: string | null;
  versions: PaSigVersionMeta[];
}

export interface PaSignatureStore {
  readHistoryIndex(): PaSigHistoryIndex;
  readVersionDiff(threatVersion: string): PaSigVersionDiffFile | null;
  readLatestIndex(): LatestSigIndex | null;
  /** 依 D1 順序寫入:先寫 history/<version>.json → index.json → 最後更新 latest-index.json.gz → 清理超出份數的舊檔 */
  commitVersion(input: {
    meta: PaSigVersionMeta;
    diff: PaSigVersionDiffFile;
    nextIndex: LatestSigIndex;
  }): PaSigHistoryIndex;
}

export function createPaSignatureStore(root: string, keep = PA_SIG_HISTORY_KEEP): PaSignatureStore {
  const dir = path.join(root, 'pa-signature');
  const historyDir = path.join(dir, 'history');
  const indexFile = path.join(dir, 'index.json');
  const latestIndexFile = path.join(dir, 'latest-index.json.gz');

  const readHistoryIndex = (): PaSigHistoryIndex => {
    const raw = readJson<unknown>(indexFile);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { baselineAt: null, baselineVersion: null, versions: [] };
    const o = raw as Record<string, unknown>;
    const versions = Array.isArray(o.versions)
      ? (o.versions as PaSigVersionMeta[])
          .filter((m) => m && typeof m.threatVersion === 'string' && PA_SIG_VERSION_RE.test(m.threatVersion))
          .map((m) => ({ ...m, rebuilt: Boolean(m.rebuilt) }))
      : [];
    return {
      baselineAt: typeof o.baselineAt === 'string' && o.baselineAt ? o.baselineAt : null,
      baselineVersion: typeof o.baselineVersion === 'string' && o.baselineVersion ? o.baselineVersion : null,
      versions,
    };
  };

  return {
    readHistoryIndex,
    readVersionDiff(threatVersion) {
      if (!PA_SIG_VERSION_RE.test(threatVersion)) return null;
      const file = safeJoin(historyDir, `${threatVersion}.json`);
      const raw = readJson<PaSigVersionDiffFile>(file);
      if (!raw || raw.threatVersion !== threatVersion) return null;
      return { ...raw, rebuilt: Boolean(raw.rebuilt) };
    },
    readLatestIndex() {
      const raw = readGzipJson<unknown>(latestIndexFile);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const o = raw as Record<string, unknown>;
      if (typeof o.threatVersion !== 'string' || !PA_SIG_VERSION_RE.test(o.threatVersion)) return null;
      if (!o.items || typeof o.items !== 'object' || Array.isArray(o.items)) return null;
      const firstSeen =
        o.firstSeen && typeof o.firstSeen === 'object' && !Array.isArray(o.firstSeen)
          ? (o.firstSeen as Record<string, SigFirstSeen>)
          : {};
      return {
        threatVersion: o.threatVersion,
        savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
        hash: typeof o.hash === 'string' ? o.hash : '',
        items: o.items as Record<string, CompactSigEntry>,
        firstSeen,
      };
    },
    commitVersion({ meta, diff, nextIndex }) {
      if (!PA_SIG_VERSION_RE.test(meta.threatVersion)) throw new Error(`不合法的 threatVersion:${meta.threatVersion}`);
      ensureDir(historyDir);
      const diffFile = safeJoin(historyDir, `${meta.threatVersion}.json`);

      // 1. 先原子寫差異歷史檔
      writeJson(diffFile, diff);

      // 2. 更新歷史清單(去重同版本以支援崩潰後冪等重試;基準日一旦寫入就永久固定,D2)
      const prev = readHistoryIndex();
      const baselineAt = prev.baselineAt ?? meta.savedAt;
      const baselineVersion = prev.baselineVersion ?? meta.threatVersion;
      const merged = [meta, ...prev.versions.filter((v) => v.threatVersion !== meta.threatVersion)];
      const kept = merged.slice(0, keep);
      const nextHistory: PaSigHistoryIndex = { baselineAt, baselineVersion, versions: kept };
      writeJson(indexFile, nextHistory);

      // 3. 最後才原子更新精簡索引:保證索引更新前差異檔與歷史清單都已落地
      writeGzipJson(latestIndexFile, nextIndex);

      // 4. 清除不在保留清單內的舊差異檔
      const keepNames = new Set(kept.map((v) => `${v.threatVersion}.json`));
      for (const name of listFiles(historyDir)) {
        if (name.endsWith('.json') && !keepNames.has(name)) removeFile(path.join(historyDir, name));
      }
      return nextHistory;
    },
  };
}
