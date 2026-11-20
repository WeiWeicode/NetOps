/**
 * PA 威脅特徵碼 AI 摘要(TS-3;docs/THREAT-SIGNATURE-PLAN.md §5.3):
 *   純函式組裝送給 AI 主機的統計文字(只送統計,絕不送 IP、姓名、規則名稱或原始 log;AGENT.md §7.4)。
 *   - 新增高危(critical / high)特徵太多時只送前 50 筆(有命中優先、嚴重度 critical > high、命中數高者優先),並告知總數
 *   - 結合本環境近 30 天前 30 個 App、這些特徵的命中筆數與動作分布、規則覆蓋缺口條數
 *   - 歷史不足(since)、索引重建(rebuilt)、快照過期(stale)、外部依賴失敗都要明確標示(AGENT.md §5)
 */
import type { PaSigVersionMeta } from '../../infra/store/pa-signature.js';
import { clean, joinCapped } from '../ai/core/explain.js';
import type { CoverageResult, SigDays, SigItem, SigMeta } from './core.js';

/** 單次送給 AI 的新增高危特徵碼上限(計畫 §5.3) */
export const SIG_AI_MAX_ITEMS = 50;
/** 送給 AI 的環境近 30 天熱門 App 數量 */
export const SIG_AI_TOP_APPS = 30;
/** 送給 AI 的資料文字總字數上限 */
export const SIG_AI_MAX_CHARS = 24_000;
/** AI 回答開頭免責提示(只放開頭,同 PR-5 決定) */
export const PA_SIGNATURE_AI_DISCLAIMER = 'AI 建議,需網通確認;系統不會自動修改防火牆設定或特徵動作';

export interface SigAiHitStat {
  id: string;
  hits: number;
  repeats: number;
  blocked: number;
  alerted: number;
  actions: Record<string, number>;
  /** 命中的安全規則中有幾條缺少弱點 / 間諜軟體防護(只傳條數,不傳規則名稱) */
  unprotectedRuleCount: number;
}

export interface SigAiCoverageSummary {
  totalAllowEnabled: number;
  covered: number;
  missingBoth: number;
  missingVulnerability: number;
  missingSpyware: number;
  unknown: number;
  profilesAvailable: boolean;
}

export interface SigAiBuildInput {
  meta: SigMeta;
  stale: boolean;
  days: SigDays;
  baselineAt: string | null;
  since: string | null;
  /** 本期間(含目前版本)是否有任何版本因索引重建而無法計算差異 */
  rebuilt: boolean;
  /** 僅有基準版本,尚未發生過內容版本更新 */
  baselineOnly: boolean;
  /** 最新一版版本摘要(可能為 null) */
  latestVersion: PaSigVersionMeta | null;
  /** 近 days 天新增的全部特徵(含各嚴重度) */
  newItems: readonly SigItem[];
  /** 近 days 天各特徵 ID 命中筆數(ClickHouse 不可用時為 null) */
  hitCounts: Record<string, number> | null;
  /** 挑出送 AI 的高危特徵詳細命中統計與動作分布(不含 IP / 規則名稱) */
  hitStats: Record<string, SigAiHitStat> | null;
  /** 本環境近 30 天前 N 個 App 與連線數(ClickHouse 不可用時為 null) */
  topApps: readonly { app: string; sessions: number }[] | null;
  /** 安全規則覆蓋缺口條數(安全規則快照不可用時為 null) */
  coverage: SigAiCoverageSummary | null;
}

export interface PaSignatureForAi {
  text: string;
  clipped: boolean;
  threatVersion: string;
  threatReleaseDate: string | null;
  fetchedAt: string;
  stale: boolean;
  days: SigDays;
  baselineAt: string | null;
  since: string | null;
  rebuilt: boolean;
  totalNew: number;
  totalHighRiskNew: number;
  sentSignatures: number;
  truncatedSignatures: boolean;
  hitsAvailable: boolean;
  appsAvailable: boolean;
  coverageAvailable: boolean;
}

const n = (v: unknown) => (Number(v) || 0).toLocaleString('en-US');
const HIGH_SEV_RANK: Record<string, number> = { critical: 2, high: 1 };
const isHighRisk = (sev: string) => {
  const s = sev.trim().toLowerCase();
  return s === 'critical' || s === 'high';
};

/** 挑選最多 max 筆新增高危(critical / high)特徵:有命中優先 → severity(critical > high) → 命中數多者優先 → ID 升冪 */
export function pickHighRiskSignatures(
  newItems: readonly SigItem[],
  hitCounts: Record<string, number> | null,
  max = SIG_AI_MAX_ITEMS,
): { picked: SigItem[]; totalHighRisk: number; truncated: boolean } {
  const highRisk = newItems.filter((item) => isHighRisk(item.severity));
  const sorted = highRisk.slice().sort((a, b) => {
    const ha = hitCounts ? (hitCounts[a.id] ?? 0) : 0;
    const hb = hitCounts ? (hitCounts[b.id] ?? 0) : 0;
    const hasDiff = (hb > 0 ? 1 : 0) - (ha > 0 ? 1 : 0);
    if (hasDiff !== 0) return hasDiff;
    const sevDiff = (HIGH_SEV_RANK[b.severity.toLowerCase()] ?? 0) - (HIGH_SEV_RANK[a.severity.toLowerCase()] ?? 0);
    if (sevDiff !== 0) return sevDiff;
    if (hb !== ha) return hb - ha;
    return Number(a.id) - Number(b.id);
  });
  const picked = sorted.slice(0, max);
  return { picked, totalHighRisk: highRisk.length, truncated: highRisk.length > picked.length };
}

/** 統計各嚴重度數量 */
function countSeverities(items: readonly SigItem[]): Record<'critical' | 'high' | 'medium' | 'low' | 'informational', number> {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
  for (const item of items) {
    const s = item.severity.trim().toLowerCase();
    if (s === 'critical') counts.critical++;
    else if (s === 'high') counts.high++;
    else if (s === 'medium') counts.medium++;
    else if (s === 'low') counts.low++;
    else counts.informational++;
  }
  return counts;
}

const formatActions = (actions: Record<string, number>): string => {
  const entries = Object.entries(actions)
    .filter(([, cnt]) => cnt > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return '';
  return entries.map(([act, cnt]) => `${clean(act, 30)} ${n(cnt)}`).join('、');
};

/** 把 CoverageResult 壓成純統計(只留條數,不含規則名稱) */
export function toAiCoverageSummary(cov: CoverageResult['summary'], profilesAvailable: boolean): SigAiCoverageSummary {
  return {
    totalAllowEnabled: cov.totalAllowEnabled,
    covered: cov.covered,
    missingBoth: cov.missingBoth,
    missingVulnerability: cov.missingVulnerability,
    missingSpyware: cov.missingSpyware,
    unknown: cov.unknown,
    profilesAvailable,
  };
}

/** 組裝送給 AI 主機的純統計資料(只含統計與特徵庫公開欄位,絕不含 IP、姓名、規則名稱或原始 log) */
export function buildSignatureAiContext(input: SigAiBuildInput, maxChars = SIG_AI_MAX_CHARS): PaSignatureForAi {
  const { meta, stale, days, baselineAt, since, rebuilt, baselineOnly, latestVersion, newItems, hitCounts, hitStats, topApps, coverage } = input;
  const sevCounts = countSeverities(newItems);
  const { picked, totalHighRisk, truncated } = pickHighRiskSignatures(newItems, hitCounts, SIG_AI_MAX_ITEMS);
  const hitsAvailable = hitCounts !== null && hitStats !== null;
  const appsAvailable = topApps !== null;
  const coverageAvailable = coverage !== null;

  /* ───── 1. 內容版本與統計範圍 ───── */
  const headLines: string[] = [
    `## 本次內容版本與統計範圍`,
    `- 威脅特徵版本：${clean(meta.threatVersion, 64)}${meta.threatReleaseDate ? `（發布時間 ${clean(meta.threatReleaseDate, 40)}）` : ''}`,
    `- 快照讀取時間：${clean(meta.fetchedAt, 40)}${stale ? '（注意：快照已超過 2 小時未更新，可能不是 PA 最新版本）' : ''}`,
    `- 本機特徵總數：${n(meta.counts.total)} 筆（弱點 ${n(meta.counts.vulnerability)}、間諜軟體 ${n(meta.counts.spyware)}）`,
  ];
  const otherVers = [
    meta.appVersion ? `App ${clean(meta.appVersion, 40)}` : '',
    meta.avVersion ? `防毒(AV) ${clean(meta.avVersion, 40)}` : '',
    meta.wildfireVersion ? `WildFire ${clean(meta.wildfireVersion, 40)}` : '',
  ].filter(Boolean);
  if (otherVers.length) headLines.push(`- 其他內容版本（僅供版本參考，未讀清單）：${otherVers.join('；')}`);
  headLines.push(`- 統計期間：近 ${days} 天${baselineAt ? `（基準建立日 ${clean(baselineAt.slice(0, 10), 10)}）` : ''}`);
  if (since) headLines.push(`- 歷史不足限制：系統自 ${clean(since, 10)} 起建立基準統計，未滿 ${days} 天，不可將基準前的特徵視為 0 筆新增`);
  if (baselineOnly) headLines.push(`- 基準狀態：目前僅有首次基準版本（不算新增），尚未發生後續內容版本更新`);
  if (rebuilt) headLines.push(`- 資料不完整警告：本期間有內容版本因精簡索引遺失或損壞而重建，該版差異無法計算，部分新增特徵可能未計入`);
  if (latestVersion && !latestVersion.isBaseline && !latestVersion.rebuilt) {
    headLines.push(
      `- 最新一版（${clean(latestVersion.threatVersion, 64)}）變動：新增 ${n(latestVersion.added)}、變更 ${n(latestVersion.changed)}、停用/移除 ${n(latestVersion.removed)}`,
    );
  }
  headLines.push(
    `- 近 ${days} 天新增特徵總數：${n(newItems.length)} 筆（嚴重 ${n(sevCounts.critical)}、高 ${n(sevCounts.high)}、中 ${n(sevCounts.medium)}、低 ${n(sevCounts.low)}、資訊 ${n(sevCounts.informational)}）`,
  );
  if (truncated) {
    headLines.push(
      `- 新增高危特徵（critical / high）總數：${n(totalHighRisk)} 筆；因筆數過多，依「有命中優先、嚴重度高者優先」僅列出前 ${n(picked.length)} 筆（其餘 ${n(totalHighRisk - picked.length)} 筆高危與中低危未列出）`,
    );
  } else {
    headLines.push(`- 新增高危特徵（critical / high）總數：${n(totalHighRisk)} 筆${totalHighRisk > 0 ? '（已全數列出）' : ''}`);
  }

  /* ───── 2. 新增高危特徵清單(最多 50 筆) ───── */
  const sigLines: string[] = [];
  if (picked.length) {
    sigLines.push(
      `## 新增高危特徵碼（共 ${n(totalHighRisk)} 筆，列出前 ${n(picked.length)} 筆；依有命中優先與嚴重度排序）`,
    );
    picked.forEach((item, idx) => {
      const kindText = item.kind === 'vulnerability' ? '弱點' : '間諜軟體';
      const cves = item.cves.length ? item.cves.slice(0, 6).map((c) => clean(c, 32)).join(',') + (item.cves.length > 6 ? ` 等共${item.cves.length}個` : '') : '無';
      const vendors = item.vendorIds.length ? item.vendorIds.slice(0, 4).map((v) => clean(v, 40)).join(',') : '';
      const act = item.defaultAction ? clean(item.defaultAction, 32) : '未指定';
      const parts = [
        `${idx + 1}. ID ${clean(item.id, 16)}`,
        kindText,
        clean(item.severity, 20),
        clean(item.name, 100) || '(無名稱)',
        `類別 ${clean(item.category, 48) || '無'}`,
        item.affectedHost ? `目標 ${clean(item.affectedHost, 32)}` : '',
        `預設動作 ${act}`,
        `CVE ${cves}`,
        vendors ? `廠商參考 ${vendors}` : '',
        item.disabled ? '預設停用' : '',
      ].filter(Boolean);

      if (hitsAvailable) {
        const st = hitStats![item.id];
        if (st && st.hits > 0) {
          const actDist = formatActions(st.actions);
          const unprot = st.unprotectedRuleCount > 0 ? `；其中 ${n(st.unprotectedRuleCount)} 條命中規則缺防護` : '';
          parts.push(`近${days}天命中 ${n(st.hits)} 筆（阻擋 ${n(st.blocked)}、告警 ${n(st.alerted)}${actDist ? `；動作 ${actDist}` : ''}${unprot}）`);
        } else {
          parts.push(`近${days}天命中 0 筆`);
        }
      }
      sigLines.push(parts.join('｜'));
    });
  } else {
    sigLines.push('## 新增高危特徵碼');
    sigLines.push(
      baselineOnly
        ? '- 目前僅有基準版本，尚無內容版本更新帶來的新增高危特徵。'
        : `- 近 ${days} 天沒有新增 critical / high 等級的威脅特徵碼。`,
    );
  }

  /* ───── 3. 命中統計與動作分布(不含 IP / 規則名稱) ───── */
  const hitSection: string[] = [`## 近 ${days} 天新增高危特徵命中統計與動作分布`];
  if (!hitsAvailable) {
    hitSection.push('- ClickHouse 暫時無法連線，本次未取得特徵碼命中統計，無法判斷新特徵是否已有命中。');
  } else {
    let hitSigCount = 0;
    let totalHits = 0;
    let totalRepeats = 0;
    let totalBlocked = 0;
    let totalAlerted = 0;
    let unprotectedHitSigs = 0;
    const aggActions: Record<string, number> = {};
    for (const item of picked) {
      const st = hitStats![item.id];
      if (!st || st.hits <= 0) continue;
      hitSigCount++;
      totalHits += st.hits;
      totalRepeats += st.repeats;
      totalBlocked += st.blocked;
      totalAlerted += st.alerted;
      if (st.unprotectedRuleCount > 0) unprotectedHitSigs++;
      for (const [act, cnt] of Object.entries(st.actions)) {
        aggActions[act] = (aggActions[act] ?? 0) + cnt;
      }
    }
    const allNewHitSigs = newItems.filter((x) => (hitCounts![x.id] ?? 0) > 0).length;
    const allNewTotalHits = newItems.reduce((acc, x) => acc + (hitCounts![x.id] ?? 0), 0);
    hitSection.push(`- 全部新增特徵（含中低危）：${n(allNewHitSigs)} 個有命中，共 ${n(allNewTotalHits)} 筆`);
    hitSection.push(
      `- 已列出之新增高危特徵：${n(hitSigCount)} / ${n(picked.length)} 個有命中，共 ${n(totalHits)} 筆（含重複累計 ${n(totalRepeats)} 次；阻擋 ${n(totalBlocked)} 筆、僅告警/放行 ${n(totalAlerted)} 筆）`,
    );
    const actText = formatActions(aggActions);
    if (actText) hitSection.push(`- 動作分布：${actText}`);
    if (unprotectedHitSigs > 0) {
      hitSection.push(`- 風險提示：有 ${n(unprotectedHitSigs)} 個已命中之新增高危特徵落在缺少威脅防護 Profile 的安全規則上（命中可能僅記錄而未攔截）`);
    }
  }

  /* ───── 4. 本環境近 30 天熱門 App ───── */
  const appSection: string[] = [`## 本環境近 30 天前 ${SIG_AI_TOP_APPS} 個 App（依連線數，僅統計）`];
  if (!appsAvailable) {
    appSection.push('- ClickHouse 暫時無法連線，本次未取得本環境 App 統計，無法比對 App 相關性。');
  } else if (!topApps!.length) {
    appSection.push('- 近 30 天每小時彙總表沒有 App 流量資料。');
  } else {
    topApps!.slice(0, SIG_AI_TOP_APPS).forEach((x, idx) => {
      appSection.push(`${idx + 1}. ${clean(x.app, 80)}｜${n(x.sessions)} 次`);
    });
  }

  /* ───── 5. 規則覆蓋缺口條數(不含規則名稱 / IP) ───── */
  const covSection: string[] = ['## 安全規則威脅防護覆蓋缺口統計（條數，僅看啟用中的 allow 規則）'];
  if (!coverageAvailable) {
    covSection.push('- 尚未取得 PA 安全規則快照，本次無法評估規則覆蓋缺口。');
  } else {
    const gapTotal = coverage!.missingBoth + coverage!.missingVulnerability + coverage!.missingSpyware;
    covSection.push(`- 啟用中的 allow 規則總數：${n(coverage!.totalAllowEnabled)} 條`);
    covSection.push(`- 已同時掛弱點防護與間諜軟體 Profile：${n(coverage!.covered)} 條`);
    covSection.push(
      `- 缺少防護缺口：共 ${n(gapTotal)} 條（同時缺弱點與間諜軟體 ${n(coverage!.missingBoth)} 條、僅缺弱點防護 ${n(coverage!.missingVulnerability)} 條、僅缺間諜軟體 ${n(coverage!.missingSpyware)} 條）`,
    );
    if (coverage!.unknown > 0) {
      covSection.push(
        `- 無法判定：${n(coverage!.unknown)} 條（Profile Group 內容讀不到或群組不存在，不可當成已有防護，需人工確認）`,
      );
    }
    if (!coverage!.profilesAvailable) {
      covSection.push('- 限制：尚未取得 vsys1 Profile Group 快照，使用群組的規則暫列為「無法判定」');
    }
  }

  const joined = joinCapped(
    [headLines.join('\n'), sigLines.join('\n'), hitSection.join('\n'), appSection.join('\n'), covSection.join('\n')],
    maxChars,
  );

  return {
    text: joined.text,
    clipped: joined.clipped,
    threatVersion: meta.threatVersion,
    threatReleaseDate: meta.threatReleaseDate,
    fetchedAt: meta.fetchedAt,
    stale,
    days,
    baselineAt,
    since,
    rebuilt,
    totalNew: newItems.length,
    totalHighRiskNew: totalHighRisk,
    sentSignatures: picked.length,
    truncatedSignatures: truncated,
    hitsAvailable,
    appsAvailable,
    coverageAvailable,
  };
}
