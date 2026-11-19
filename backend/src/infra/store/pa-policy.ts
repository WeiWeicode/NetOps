/**
 * PA 安全規則版本歷史(PR-2;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3):papolicy/ 目錄。
 *   papolicy/index.json                         版本清單(新到舊;id、hash、fetchedAt、savedAt、ruleCount)
 *   papolicy/versions/<id>.json                 一個版本的規則與物件(收集器快照的內容,不含命中數)
 * 規則內容雜湊變了才存新版本(呼叫端判斷);保留最近 KEEP 份,同 SG warroom/history 做法。納入 NAS 每日備份(deploy/kb-backup/backup.sh)。
 * 不含姓名等個資(§3.6:IP 對照只在前端即時查)。這裡只讀寫原始 JSON,驗證與差異在 modules/pa-policy。
 */
import path from 'node:path';
import { ensureDir, listFiles, readJson, removeFile, writeJson } from './files.js';

/** 保留份數(§3.3) */
export const PA_POLICY_KEEP = 50;
/** 版本 id:20261119T010203000Z-<雜湊前 12 碼>(可排序、不含冒號) */
export const PA_POLICY_VERSION_ID = /^\d{8}T\d{9}Z-[0-9a-f]{12}$/;

export interface PaPolicyVersionMeta {
  id: string;
  hash: string;
  /** 收集器讀取 PA 的時間 */
  fetchedAt: string;
  /** 本服務存成版本的時間 */
  savedAt: string;
  ruleCount: number;
}

export interface PaPolicyStore {
  /** 版本清單(新到舊) */
  listVersions(): PaPolicyVersionMeta[];
  /** 一個版本的內容;id 格式不符或不存在回 null */
  readVersion(id: string): { meta: PaPolicyVersionMeta; rules: unknown[]; objects: Record<string, unknown> } | null;
  /** 存新版本並刪除超過 KEEP 份的舊版本;回傳 meta */
  saveVersion(v: { hash: string; fetchedAt: string; rules: unknown[]; objects: Record<string, unknown> }, at?: Date): PaPolicyVersionMeta;
}

export function createPaPolicyStore(root: string, keep = PA_POLICY_KEEP): PaPolicyStore {
  const dir = path.join(root, 'papolicy');
  const versionsDir = path.join(dir, 'versions');
  const indexFile = path.join(dir, 'index.json');
  const readIndex = (): PaPolicyVersionMeta[] => {
    const v = readJson<unknown>(indexFile);
    return Array.isArray(v) ? (v as PaPolicyVersionMeta[]).filter((m) => m && PA_POLICY_VERSION_ID.test(String(m.id))) : [];
  };
  return {
    listVersions: readIndex,
    readVersion(id) {
      if (!PA_POLICY_VERSION_ID.test(id)) return null;
      const meta = readIndex().find((m) => m.id === id);
      if (!meta) return null;
      const body = readJson<{ rules?: unknown; objects?: unknown }>(path.join(versionsDir, `${id}.json`));
      if (!body || !Array.isArray(body.rules)) return null;
      const objects = body.objects && typeof body.objects === 'object' && !Array.isArray(body.objects) ? (body.objects as Record<string, unknown>) : {};
      return { meta, rules: body.rules, objects };
    },
    saveVersion(v, at = new Date()) {
      ensureDir(versionsDir);
      const id = `${at.toISOString().replace(/[-:.]/g, '')}-${v.hash.slice(0, 12).toLowerCase()}`;
      if (!PA_POLICY_VERSION_ID.test(id)) throw new Error('版本 id 格式不符(hash 不是十六進位)');
      const meta: PaPolicyVersionMeta = { id, hash: v.hash, fetchedAt: v.fetchedAt, savedAt: at.toISOString(), ruleCount: v.rules.length };
      // 先寫內容再寫清單:中途失敗時清單不會指向不存在的檔
      writeJson(path.join(versionsDir, `${id}.json`), { hash: v.hash, fetchedAt: v.fetchedAt, rules: v.rules, objects: v.objects });
      const list = [meta, ...readIndex().filter((m) => m.id !== id)];
      const kept = list.slice(0, keep);
      writeJson(indexFile, kept);
      // 刪除不在清單內的版本檔(超過份數、或之前中途失敗留下的)
      const keepIds = new Set(kept.map((m) => `${m.id}.json`));
      for (const n of listFiles(versionsDir)) if (n.endsWith('.json') && !keepIds.has(n)) removeFile(path.join(versionsDir, n));
      return meta;
    },
  };
}
