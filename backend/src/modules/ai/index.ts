/**
 * AI 模組組裝(IMPL-PLAN A1、ARCHITECTURE D23):依設定建立模型、向量庫、RDAP 用戶端,註冊路由與排程
 *   - 模型:LLM_URL 空白時 AI 功能回 409 NETOPS_AI_DISABLED,畫面依 GET /ai/status 隱藏
 *   - 向量同步(VECTOR_SYNC=1 才寫入):筆記異動 3 秒後、啟動 5 秒後、每 30 分鐘(同舊版 vector.js)
 *   - 外部 IP 自動學習:每 10 分鐘檢查一次是否到 IPLEARN_HOUR(同舊版 iplearn.js;預設 -1 不自動)
 * 背景同步在程序內執行,只跑單一容器(AGENT.md §7.3)。
 * AC2:分析、問答、外部 IP 學習的資料來源依 config.ai.source(NETOPS_AI_SOURCE):clickhouse 查 ClickHouse(ch-source.ts),
 *   ftp 沿用 FTP 摘要(正式區 C6 之前;需求方 2026-11-13 AQ4)。
 */
import type { FastifyInstance } from 'fastify';
import type { Config, FtpConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import type { Ftp } from '../../infra/ftp/index.js';
import { createLlm } from '../../infra/llm/index.js';
import { createRdap } from '../../infra/rdap/index.js';
import type { PaStore } from '../../infra/store/index.js';
import { createEmbedder, createQdrant } from '../../infra/vector/index.js';
import type { AdImporter } from '../ad/importer.js';
import { AUTHOR, createIpLearner, parseRdap, TAG } from '../iplearn/core/iplearn.js';
import kbAiRoutes, { type IpLearner, type VectorIndex } from '../kb/ai-routes.js';
import { nowText } from '../kb/core/notes.js';
import { createVectorIndex } from '../kb/core/vector.js';
import type { KbService } from '../kb/service.js';
import type { EventImporter } from '../pa-events/importer.js';
import type { TrafficImporter } from '../pa/importer.js';
import type { ClickHouseReader } from '../../infra/clickhouse/reader.js';
import type { ChSummaryBuilder } from '../pa/ch-summary.js';
import { createChAiSource } from './ch-source.js';
import aiRoutes from './routes.js';
import { createAiService, type ExplainSources } from './service.js';
import { createSseHub } from './sse.js';
import { createDailySummary, type DailySummaryScheduler } from './daily-summary.js';
import { aiNamesSection } from '../ip-names/service.js';

const pad = (n: number) => String(n).padStart(2, '0');
/** Date → 'yyyy/MM/dd'(本地時間,容器 TZ=Asia/Taipei;舊版 utils.fmtDate) */
const fmtDate = (d: Date) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
const oneLine = (s: unknown) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

export interface AiDeps {
  config: Config;
  traffic: TrafficImporter;
  events: EventImporter;
  ad: AdImporter;
  kb: KbService;
  ftp: Ftp;
  paStore: PaStore;
  /** ClickHouse 唯讀查詢與每小時摘要(未設定 ClickHouse 時為 null;clickhouse 來源的 AI 回 503) */
  chReader?: ClickHouseReader | null;
  chBuilder?: ChSummaryBuilder | null;
  /** 測試時固定「現在」(ClickHouse 來源的 30 天分界、保留期限) */
  now?: () => number;
  /** 測試時注入假的 AI 主機 / RDAP */
  fetch?: typeof fetch;
  /** 測試時縮短 SSE 心跳 */
  heartbeatMs?: number;
  /** AC4 AI 解讀的資料來源(時段明細、分析儀表板) */
  explain?: ExplainSources;
  /**
   * AC7 每日摘要的排程條件:autoRecon = 有自動對帳(ClickHouse + NETOPS_RECON_TIME ≥ 0);
   * syncReady = 每日同步(AC1)今天這一輪已結束(完成、停止重試或未啟用)
   */
  daily?: { autoRecon: boolean; syncReady(): boolean };
}

export async function registerAi(app: FastifyInstance, deps: AiDeps): Promise<{ daily: DailySummaryScheduler }> {
  const { config, traffic, events, ad, kb, ftp, paStore } = deps;
  const cfg = config.ai;
  const fetchImpl = deps.fetch ?? fetch;
  const log = { info: (m: string) => app.log.info(m), error: (o: object, m: string) => app.log.error(o, m) };

  const llm = cfg.llm.url ? createLlm(cfg.llm, fetchImpl) : null;
  const ch =
    cfg.source === 'clickhouse'
      ? createChAiSource({
          reader: deps.chReader ?? null,
          builder: deps.chBuilder ?? null,
          events,
          ttlDays: config.paTtlDays,
          summaryDays: config.chSummary.days,
          log: app.log,
          now: deps.now,
        })
      : null;
  const vector = createVectorIndex({
    qdrant: createQdrant(cfg.vector, fetchImpl),
    embed: createEmbedder(cfg.vector, fetchImpl).embed,
    listNotes: () => kb.listNotes(),
    nowText,
    log,
    allowWrite: cfg.vectorSync,
  }) as unknown as VectorIndex;

  /** 筆記目前是否仍是自動學習的(管理者改過:拿掉標籤或最後修改人不是 AI 自動學習) */
  const noteState = (id: string): 'auto' | 'manual' | null => {
    try {
      const n = kb.getNote(id);
      return n.tags.includes(TAG) && (n.updatedBy || n.author) === AUTHOR ? 'auto' : 'manual';
    } catch (err) {
      if (err instanceof AppError && err.status === 404) return null;
      throw err;
    }
  };
  const rdap = createRdap(fetchImpl, parseRdap);
  const learner = llm
    ? (createIpLearner({
        loadState: () => paStore.loadIpLearnState(),
        saveState: (s: unknown) => paStore.saveIpLearnState(s),
        recentSummaries: (days: number) => {
          // AC2:clickhouse 來源取原始 TRAFFIC 建的每小時摘要(上限 30 天,不新增彙總表)
          if (ch) return ch.recentSummaries(days);
          // 同舊版 candidates:今天往前 days 天(含今天)
          const to = new Date();
          const from = new Date(Date.now() - (days - 1) * 86400000);
          const files = traffic.filesInRange(fmtDate(from), fmtDate(to));
          return { summaries: files.map((f) => traffic.readSummary(f.summary!)).filter(Boolean), from: fmtDate(from), to: fmtDate(to), files: files.length };
        },
        listNotes: () => kb.listNotes(),
        // 新版筆記的標題與標籤不可含換行(B2-kb 資安修正):模型回的值壓成一行
        // 錯誤訊息會出現在學習紀錄(kb.read 看得到):非 AppError(可能含容器路徑)只留固定文字,原文寫日誌(審查修正)
        saveNote: (data: { title: string; ips: string[]; tags: string[]; content: string; source: string }, author: string, id?: string) => {
          try {
            return kb.saveNote({ ...data, title: oneLine(data.title).slice(0, 300), tags: data.tags.map((t) => oneLine(t).slice(0, 100)).filter(Boolean).slice(0, 10), content: data.content.slice(0, 20000) }, author, id);
          } catch (err) {
            if (err instanceof AppError) throw err;
            app.log.error({ err }, '[外部 IP 學習] 寫入知識庫失敗');
            throw new Error('寫入知識庫失敗(細節見服務日誌)');
          }
        },
        noteState,
        chatOnce: (opts: { messages: { role: 'system' | 'user'; content: string }[]; maxTokens: number }) => llm.chatOnce(opts),
        rdap: async (ip: string) => {
          try {
            return await rdap.lookup(ip);
          } catch (err) {
            // 「RDAP 404」「RDAP 沒有網段資料」等是自己的分類訊息;連線錯誤只留固定文字
            const msg = (err as Error).message;
            throw new Error(/^(RDAP|不是 IPv4)/.test(msg) ? msg : 'RDAP 連線失敗');
          }
        },
        reverseDns: rdap.reverseDns,
        nowText,
        log,
        options: { days: cfg.ipLearn.days, max: cfg.ipLearn.max, ttlDays: cfg.ipLearn.ttlDays },
      }) as unknown as IpLearner & { shouldAutoRun(today: string): boolean })
    : null;

  /* ───────── 排程 ───────── */
  const timers: NodeJS.Timeout[] = [];
  const intervals: NodeJS.Timeout[] = [];
  let closing = false;
  let debounce: NodeJS.Timeout | null = null;
  const syncQuietly = () => void (closing ? null : vector.syncVectors().catch(() => {}));
  if (vector.vectorEnabled() && cfg.vectorSync) {
    kb.onChange(() => {
      if (closing) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(syncQuietly, 3000);
      debounce.unref();
    });
    app.addHook('onReady', async () => {
      timers.push(setTimeout(syncQuietly, 5000).unref());
      intervals.push(setInterval(syncQuietly, 30 * 60000).unref());
    });
  }
  if (learner && cfg.ipLearn.hour >= 0) {
    app.addHook('onReady', async () => {
      intervals.push(
        setInterval(() => {
          const now = new Date();
          if (closing || now.getHours() !== cfg.ipLearn.hour || !learner.shouldAutoRun(fmtDate(now))) return;
          learner.learnIps({ by: '每日自動' }).catch((err: unknown) => app.log.error({ err }, '[外部 IP 學習] 每日自動執行失敗'));
        }, 10 * 60000).unref(),
      );
    });
  }
  // 關閉時停掉排程;進行中的外部 IP 學習不中止(同舊版;狀態檔每查 10 個 IP 存一次,重啟後已查的 IP 不重查)
  app.addHook('onClose', async () => {
    closing = true;
    if (debounce) clearTimeout(debounce);
    for (const t of timers) clearTimeout(t);
    for (const t of intervals) clearInterval(t);
  });

  const ftpConfig: FtpConfig | null = config.ftp;
  const ai = createAiService({
    llm,
    traffic,
    events,
    ad,
    kb,
    vector,
    ftp,
    ftpConfig,
    readFlows: (name) => paStore.readFlows(name),
    searchSeconds: config.search.seconds,
    kbMaxChars: cfg.kbMaxChars,
    source: cfg.source,
    ch,
    // AC3(D45):提示詞附 IP 對照(姓名、部門只送公司內部 AI 主機,不寫日誌)
    ipNames: (text) => aiNamesSection(app.ipNames, text),
    explain: deps.explain,
  });
  // AC7:對帳與每日同步後自動產生前一天的摘要(要有 LLM_URL、自動對帳、AI 解讀的資料來源;NETOPS_AI_DAILY_SUMMARY)
  const daily = createDailySummary({
    enabled: cfg.dailySummary && Boolean(llm) && Boolean(deps.daily?.autoRecon) && Boolean(deps.explain?.insight && deps.explain.events),
    at: config.reconAt,
    generate: (day) => ai.dailySummary(day),
    store: paStore,
    ready: () => deps.daily?.syncReady() ?? true,
    log: app.log,
    now: deps.now,
  });
  const hub = createSseHub(app, { maxStreams: cfg.maxStreams, maxPerUser: cfg.maxStreamsPerUser, heartbeatMs: deps.heartbeatMs });
  await app.register(aiRoutes, { ai, hub, daily });
  await app.register(kbAiRoutes, { kb, vector, learner, learnHour: cfg.ipLearn.hour, learnDefaults: { days: cfg.ipLearn.days, max: cfg.ipLearn.max }, log });
  return { daily };
}
