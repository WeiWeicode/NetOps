/**
 * PA 流量總覽(docs/API.md §4.1;舊版 server/routes/palog.js 的 days、summary、options)
 * 只做驗證、權限宣告與格式轉換;合併與研判在 core/palog.js(AGENT.md §9)。
 */
import type { FastifyPluginAsync } from 'fastify';
import { dayRangeQuery, importStatus, looseObject, TOP } from '../../shared/schemas.js';
import { dayOut, dayRange, logTimeOut } from '../../shared/time.js';
import { mergeSummaries } from './core/palog.js';
import type { TrafficImporter } from './importer.js';
import { dayRangeMs, pickSource, trafficOptions, trafficOverview, viaClickHouse, type ChOverviewDeps } from './ch-overview.js';

/** 資料來源(C3;docs/API.md §4.1):省略時依設定 NETOPS_PA_OVERVIEW_SOURCE */
export const SOURCE = { type: 'string', enum: ['ftp', 'clickhouse', 'auto'], description: '資料來源;省略時依設定(預設 auto)' } as const;

type Merged = ReturnType<typeof mergeSummaries> & { hours: { hour: string }[]; timeMin: string; timeMax: string };

/** 期間內摘要的合併結果;missing:index 有、摘要檔讀不到(總覽不完整) */
export function mergeRange(traffic: TrafficImporter, from: string, to: string, topN: number) {
  const files = traffic.filesInRange(from, to);
  const sums = files.map((f) => traffic.readSummary(f.summary!)).filter(Boolean);
  return { files: files.length, missing: files.length - sums.length, merged: mergeSummaries(sums, topN) as Merged };
}

const paRoutes: FastifyPluginAsync<{ traffic: TrafficImporter; ch: ChOverviewDeps }> = async (app, { traffic, ch }) => {
  const importBrief = () => {
    const { running: _running, ...s } = traffic.status();
    return s;
  };

  app.get(
    '/v1/pa/days',
    {
      schema: {
        operationId: 'netops.pa.days',
        summary: 'PA 有資料的日期',
        description: '列出已分析的 PA TRAFFIC log 有資料的日期(依 log 內的資料時間),每天的檔案數與筆數,新的在前;附匯入狀態,畫面據此提示資料是否還在分析。',
        tags: ['PA 流量總覽'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': [
          '場景: 列出有資料的日期',
          '  假如 2026-11-02 有 6 個已分析的 TRAFFIC 檔案',
          '  當 呼叫 GET /api/netops/pa/days',
          '  那麼 回應 200',
          '  而且 days 第一筆的 day 為 "2026-11-02"、files 為 6',
        ].join('\n'),
        response: { 200: looseObject('{ days: [{ day, files, rows }], import }') },
      },
    },
    async () => ({ days: traffic.availableDays().map((d) => ({ ...d, day: dayOut(d.day) })), import: importBrief() }),
  );

  app.get<{ Querystring: { from: string; to?: string; top?: number; source?: string } }>(
    '/v1/pa/overview',
    {
      schema: {
        operationId: 'netops.pa.overview',
        summary: 'PA 流量總覽',
        description:
          '期間內的總筆數、允許 / 阻擋、流量、每小時統計、動作、各項排行與疑似掃描來源。source 為實際來源:clickhouse(C3,筆數與每小時統計來自每小時彙總、排行來自 ClickHouse 每小時摘要,只到 topsUntil;files 為有資料的小時數)或 ftp(已分析的 FTP 檔案摘要;files 為檔案數)。files 為 0 表示沒有資料(不是沒有流量);missing 大於 0 或匯入中時結果不完整。指定 source=clickhouse 而 ClickHouse 無法使用時回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。',
        tags: ['PA 流量總覽'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': [
          '場景: 查詢期間總覽',
          '  假如 2026-11-02 有已分析的 TRAFFIC 檔案',
          '  當 呼叫 GET /api/netops/pa/overview?from=2026-11-02',
          '  那麼 回應 200',
          '  而且 files 大於 0、hours 的時間為 ISO 8601 +08:00',
          '',
          '場景: 沒有資料的期間',
          '  當 呼叫 GET /api/netops/pa/overview?from=2020-01-01',
          '  那麼 回應 200',
          '  而且 files 為 0',
          '',
          '場景: 日期格式錯誤',
          '  當 呼叫 GET /api/netops/pa/overview?from=2026/11/02',
          '  那麼 回應 400 VALIDATION_FAILED',
          '',
          '場景: 期間在 ClickHouse 範圍內時查 ClickHouse',
          '  假如 ClickHouse 從 2026-11-11 08:00 起有資料,總覽來源設定為 auto',
          '  當 呼叫 GET /api/netops/pa/overview?from=2026-11-12',
          '  那麼 回應 200',
          '  而且 source 為 "clickhouse"、files 為有資料的小時數、topsUntil 為排行涵蓋到的時間',
          '',
          '場景: 期間早於 ClickHouse 範圍時查 FTP',
          '  假如 ClickHouse 從 2026-11-11 08:00 起有資料,總覽來源設定為 auto',
          '  當 呼叫 GET /api/netops/pa/overview?from=2026-11-11',
          '  那麼 回應 200',
          '  而且 source 為 "ftp"',
          '',
          '場景: 指定 ClickHouse 但無法使用',
          '  假如 ClickHouse 連不上',
          '  當 呼叫 GET /api/netops/pa/overview?from=2026-11-12&source=clickhouse',
          '  那麼 回應 503 NETOPS_CLICKHOUSE_UNAVAILABLE',
        ].join('\n'),
        querystring: dayRangeQuery({ top: TOP, source: SOURCE }),
        response: { 200: looseObject('合併摘要(docs/API.md §4.1)') },
      },
    },
    async (req) => {
      const { from, to } = dayRange(req.query);
      const topN = req.query.top ?? 20;
      if (pickSource(ch, req.query.source, dayRangeMs(from, to)[0]) === 'clickhouse') {
        const r = await viaClickHouse(ch, req.query.source, () => trafficOverview(ch, from, to, topN));
        if (r) {
          const b = ch.builder!.status();
          return {
            ...r,
            from: dayOut(from),
            to: dayOut(to),
            import: { busy: b.busy, failed: b.lastError ? 1 : 0 },
            timeMin: logTimeOut(r.timeMin),
            timeMax: logTimeOut(r.timeMax),
            topsUntil: logTimeOut(r.topsUntil),
            hours: r.hours.map((h) => ({ ...h, hour: logTimeOut(h.hour) })),
          };
        }
      }
      const { files, missing, merged } = mergeRange(traffic, from, to, topN);
      // 小時統計只留期間內(跨日的檔案會帶到前後一天的零星資料)
      const hours = merged.hours.filter((h) => h.hour.slice(0, 10) >= from && h.hour.slice(0, 10) <= to).map((h) => ({ ...h, hour: logTimeOut(h.hour) }));
      const st = traffic.status();
      return {
        ...merged,
        source: 'ftp',
        from: dayOut(from),
        to: dayOut(to),
        files,
        missing,
        import: { busy: st.busy, failed: st.failed },
        timeMin: logTimeOut(merged.timeMin),
        timeMax: logTimeOut(merged.timeMax),
        hours,
      };
    },
  );

  app.get<{ Querystring: { from: string; to?: string; source?: string } }>(
    '/v1/pa/options',
    {
      schema: {
        operationId: 'netops.pa.options',
        summary: 'PA 明細查詢的篩選選項',
        description: '期間內出現過的應用程式、規則、區域與動作,供明細查詢的下拉選單使用。',
        tags: ['PA 流量總覽'],
        'x-permission': 'netops.pa.read',
        'x-gherkin': ['場景: 取得篩選選項', '  當 呼叫 GET /api/netops/pa/options?from=2026-11-02', '  那麼 回應 200', '  而且 回應含 apps、rules、zones、actions'].join('\n'),
        querystring: dayRangeQuery({ source: SOURCE }),
        response: { 200: looseObject('{ apps, rules, zones, actions }') },
      },
    },
    async (req) => {
      const { from, to } = dayRange(req.query);
      if (pickSource(ch, req.query.source, dayRangeMs(from, to)[0]) === 'clickhouse') {
        const r = await viaClickHouse(ch, req.query.source, () => trafficOptions(ch, from, to));
        if (r) return r;
      }
      const m = mergeRange(traffic, from, to, 200).merged as unknown as { top: Record<string, { key: string }[]>; actions: Record<string, number> };
      const keys = (name: string) => (m.top[name] ?? []).map((x) => x.key);
      const zones = new Set<string>();
      for (const z of keys('zone')) for (const part of z.split(' → ')) if (part && part !== '?') zones.add(part);
      return { apps: keys('app'), rules: keys('rule'), zones: [...zones].sort(), actions: Object.keys(m.actions).sort() };
    },
  );
};

export default paRoutes;
