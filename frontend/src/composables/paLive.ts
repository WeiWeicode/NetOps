/**
 * 即時監控頁的邏輯(R1,docs/API.md §3.2):
 *   - collectorView:收集器狀態 → 提示語氣與文字;資料停止更新時要明確顯示(AGENT.md §5),不把舊資料當即時
 *   - mergeLogs:新的 log 放前面、去重、保留上限(瀏覽器記憶體)
 *   - collectorBadges / logSource / controlView:頁首的輪詢 / 接收狀態、log 來源說明、測試區開關按鈕(2026-11-09 驗收 §7.4、需求方決定)
 *   - useLiveStream:EventSource 連線、暫停、斷線重連(伺服器每 5 分鐘結束連線,瀏覽器自動重連;429 / 404 拉長重試間隔)
 */
import { onScopeDispose, ref, shallowRef } from 'vue';
import { paLive, type CollectorControl, type CollectorStatus, type LiveLog, type LogFilter, type LogType, type PaLiveSnapshot } from '@/api/paLive';

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

/** 收集器狀態 → 頁面提示(ok 不顯示提示) */
export function collectorView(c: CollectorStatus | null | undefined): { tone: Tone; title: string; live: boolean } {
  switch (c?.state) {
    case 'ok':
      return { tone: 'success', title: '即時', live: true };
    case 'degraded':
      return { tone: 'warning', title: '部分資料停止更新', live: true };
    case 'disabled':
      return { tone: 'neutral', title: '收集器未啟用', live: false };
    case 'paused':
      return { tone: 'warning', title: '收集器已暫停', live: false };
    case 'stopped':
      return { tone: 'danger', title: '資料停止更新', live: false };
    case 'not-running':
      return { tone: 'danger', title: '收集器沒有啟動', live: false };
    case 'unavailable':
      return { tone: 'danger', title: '無法連線即時資料庫', live: false };
    default:
      return { tone: 'neutral', title: '載入中', live: false };
  }
}

/** 收集器停止回報(心跳過期、沒有心跳、Redis 連不上):輪詢 / 接收的狀態都不可信 */
const NOT_REPORTING = new Set(['stopped', 'not-running', 'unavailable']);

export interface Badge {
  key: 'poll' | 'receive';
  tone: Tone;
  text: string;
}

/**
 * 頁首的收集器狀態(驗收 §7.4-1):設備狀態來自 SDK 輪詢,排行與即時 log 來自接收端點,兩者分開顯示。
 * 輪詢:輪詢中 / 輪詢失敗 / 輪詢暫停 / 輪詢未啟用 / 輪詢停止更新;接收:接收中 / 接收暫停 / 接收未啟用 / 接收停止更新。
 */
export function collectorBadges(c: CollectorStatus | null | undefined): Badge[] {
  if (!c) return [];
  const down = NOT_REPORTING.has(c.state);
  const poll: Badge = !c.poll.enabled
    ? { key: 'poll', tone: 'neutral', text: '輪詢未啟用' }
    : down
      ? { key: 'poll', tone: 'danger', text: '輪詢停止更新' }
      : c.poll.paused
        ? { key: 'poll', tone: 'warning', text: '輪詢暫停' }
        : c.poll.error
          ? { key: 'poll', tone: 'danger', text: '輪詢失敗' }
          : { key: 'poll', tone: 'success', text: '輪詢中' };
  const receive: Badge = !c.receive.enabled
    ? { key: 'receive', tone: 'neutral', text: '接收未啟用' }
    : down
      ? { key: 'receive', tone: 'danger', text: '接收停止更新' }
      : c.receive.paused
        ? { key: 'receive', tone: 'warning', text: '接收暫停' }
        : { key: 'receive', tone: 'success', text: '接收中' };
  return [poll, receive];
}

/**
 * 排行與即時 log 的資料來源(接收端點)說明(驗收 §7.4-2):接收沒開或暫停時永遠不會有 log,不可寫成「這段期間沒有收到」。
 * live:接收端點正在收資料;empty:沒有資料時的說明;stale:有舊資料時要標示「不是即時的」。
 */
export function logSource(c: CollectorStatus | null | undefined): { live: boolean; empty: string; stale: string } {
  if (!c || NOT_REPORTING.has(c.state))
    return { live: false, empty: '收集器沒有在更新,沒有資料不代表沒有發生', stale: '收集器沒有在更新:以下只含停止前收到的資料,不是即時的。' };
  if (!c.receive.enabled)
    return { live: false, empty: '接收端點未啟用,沒有 log 來源', stale: '接收端點未啟用:以下只含停用前收到的資料,不是即時的。' };
  if (c.receive.paused)
    return { live: false, empty: '接收已暫停(測試區手動開關),沒有 log 來源', stale: '接收已暫停:以下只含暫停前收到的資料,不是即時的。' };
  return { live: true, empty: '接收端點運作中,這段期間沒有收到這種 log', stale: '' };
}

/** 設備狀態的最後更新時間(各指標快照 time 的最新者;都沒有為 null)(驗收 §7.4-3) */
export function latestSnapTime(metrics: PaLiveSnapshot['metrics'] | null | undefined): string | null {
  let best: string | null = null;
  for (const v of Object.values(metrics ?? {})) {
    const t = (v as { time?: unknown } | null)?.time;
    if (typeof t === 'string' && !Number.isNaN(Date.parse(t)) && (!best || Date.parse(t) > Date.parse(best))) best = t;
  }
  return best;
}

export interface ControlButton {
  /** 要求的狀態(按鈕顯示「繼續」或「暫停」) */
  paused: boolean;
  disabled: boolean;
  /** 停用原因(總開關關閉、收集器沒有回報) */
  reason: string;
}

/**
 * 測試區開關按鈕(2026-11-09 需求方決定):正式區(control.available false)或沒有權限時不顯示。
 * 總開關(主機環境變數)關閉時停用並說明原因;按鈕只切換暫停 / 繼續。
 */
export function controlView(
  c: CollectorStatus | null | undefined,
  control: CollectorControl | null | undefined,
  canManage: boolean,
): { visible: boolean; poll: ControlButton; receive: ControlButton } {
  const visible = !!(canManage && control?.available);
  const down = !c || NOT_REPORTING.has(c.state);
  const btn = (enabled: boolean | undefined, paused: boolean, what: string, env: string): ControlButton => ({
    paused,
    disabled: down || !enabled,
    reason: down ? '收集器沒有回報狀態,無法切換' : !enabled ? `主機設定未開啟${what}(${env}),無法從畫面開啟` : '',
  });
  return {
    visible,
    poll: btn(c?.poll.enabled, !!control?.pollPaused, '輪詢', 'PA_POLL_ENABLED'),
    receive: btn(c?.receive.enabled, !!control?.receivePaused, '接收', 'PA_RECEIVE_ENABLED'),
  };
}

/**
 * 串流連不上(非 200)時的提示與重試間隔(驗收 §6-5、§4.4):
 *   429 名額滿 → 說明要關閉其他分頁,30 秒起倍增到 5 分鐘(不再每 10 秒重試、一直產生 429)
 *   404 ROUTE_NOT_FOUND → 功能尚未啟用(路由未發佈),5 分鐘後再試
 *   其他 → 10 秒起倍增到 2 分鐘
 */
export function streamFailure(status: number, code: string | null, attempt: number): { message: string; delayMs: number } {
  const grow = (base: number, max: number) => Math.min(max, base * 2 ** Math.max(0, attempt));
  const after = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} 分鐘` : `${Math.round(ms / 1000)} 秒`);
  if (status === 429) {
    const d = grow(30_000, 300_000);
    return { message: `串流連線數已達上限,請關閉其他即時監控分頁(${after(d)}後再試)`, delayMs: d };
  }
  if (status === 404 && code === 'ROUTE_NOT_FOUND') return { message: '即時串流功能尚未啟用(路由未發佈),5 分鐘後再試', delayMs: 300_000 };
  const d = grow(10_000, 120_000);
  return { message: `即時串流中斷,${after(d)}後重新連線`, delayMs: d };
}

/** 合併 log:新的在前、依 id 去重、最多 max 筆 */
export function mergeLogs(current: LiveLog[], incoming: LiveLog[], max: number): LiveLog[] {
  if (!incoming.length) return current;
  const seen = new Set<string>();
  const out: LiveLog[] = [];
  // incoming 由舊到新(SSE)→ 反轉成新的在前
  for (const x of [...incoming].reverse().concat(current)) {
    const k = `${x.type}:${x.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

/** 較舊的 log(由新到舊)接在後面:目前清單在前、去重、最多 max 筆 */
export function appendOlder(current: LiveLog[], older: LiveLog[], max: number): LiveLog[] {
  const seen = new Set(current.map((x) => `${x.type}:${x.id}`));
  const out = current.slice(0, max);
  for (const x of older) {
    if (out.length >= max) break;
    const k = `${x.type}:${x.id}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

/** 位元速率顯示(bps → Kbps / Mbps / Gbps) */
export function fmtBps(v: number | null | undefined): string {
  if (v == null) return '—';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  let n = v;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** 篩選條件(畫面輸入)→ API 參數;格式不對的欄位不送,並回報錯誤 */
export function parseFilter(raw: { ip: string; port: string; action: string }): { filter: LogFilter; error: string } {
  const filter: LogFilter = {};
  const errors: string[] = [];
  const ip = raw.ip.trim();
  if (ip) {
    if (/^[0-9A-Fa-f:.]{2,45}$/.test(ip)) filter.ip = ip;
    else errors.push('IP 格式不正確');
  }
  const port = raw.port.trim();
  if (port) {
    const n = Number(port);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) filter.port = n;
    else errors.push('Port 要是 0–65535');
  }
  const action = raw.action.trim().toLowerCase();
  if (action) {
    if (/^[a-z-]{1,30}$/.test(action)) filter.action = action;
    else errors.push('Action 只能是英文字母與 -');
  }
  return { filter, error: errors.join('、') };
}

export const MAX_LOGS = 500;

/**
 * 即時串流:connect(types, filter) 建立連線(會關掉舊的);paused 時仍接收 snapshot,log 先放 pending,恢復時一次加入。
 * EventSource 遇到非 200(例如 401 登入逾時、429 名額滿)會停止重試:改用一般 API 觸發登入檢查,10 秒後再連。
 */
export function useLiveStream(onSnapshot: (s: PaLiveSnapshot) => void) {
  const logs = shallowRef<LiveLog[]>([]);
  const connected = ref(false);
  const lastEventAt = ref<number | null>(null);
  const streamError = ref('');
  const paused = ref(false);
  const skipped = ref(0);
  /** 某些類型讀取失敗、log 暫停更新(SSE degraded 事件;恢復時為 null) */
  const degraded = ref<{ types: string[]; message: string } | null>(null);
  let pending: LiveLog[] = [];
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let args: [LogType[], LogFilter] | null = null;
  /** 連續失敗次數(收到 open 時歸零):決定重試間隔 */
  let failures = 0;

  function close() {
    clearTimeout(retry);
    es?.close();
    es = null;
    connected.value = false;
  }

  function connect(types: LogType[], filter: LogFilter, reset = true) {
    close();
    args = [types, filter];
    if (reset) {
      // 使用者換類型或篩選:重新開始退避
      failures = 0;
      logs.value = [];
      pending = [];
      skipped.value = 0;
      degraded.value = null;
    }
    const src = new EventSource(paLive.streamUrl(types, filter));
    es = src;
    const touch = () => {
      lastEventAt.value = Date.now();
      connected.value = true;
      streamError.value = '';
    };
    src.addEventListener('open', () => {
      failures = 0;
      touch();
    });
    src.addEventListener('heartbeat', touch);
    src.addEventListener('snapshot', (e) => {
      touch();
      try {
        onSnapshot(JSON.parse((e as MessageEvent).data) as PaLiveSnapshot);
      } catch {
        // 格式錯誤的事件略過
      }
    });
    src.addEventListener('degraded', (e) => {
      touch();
      try {
        const d = JSON.parse((e as MessageEvent).data) as { types?: string[]; message?: string };
        degraded.value = d.types?.length ? { types: d.types, message: d.message ?? '' } : null;
      } catch {
        // 略過
      }
    });
    src.addEventListener('logs', (e) => {
      touch();
      try {
        const d = JSON.parse((e as MessageEvent).data) as { items: LiveLog[]; dropped: number; skipped: string[] };
        if (d.dropped || d.skipped?.length) skipped.value += (d.dropped ?? 0) + (d.skipped?.length ? 1 : 0);
        if (paused.value) pending = pending.concat(d.items).slice(-MAX_LOGS);
        else logs.value = mergeLogs(logs.value, d.items, MAX_LOGS);
      } catch {
        // 略過
      }
    });
    src.onerror = () => {
      if (es !== src) return;
      connected.value = false;
      if (src.readyState === EventSource.CLOSED) {
        // 不會自動重連(非 200):用一般 API 檢查登入(401 時 web-kit 會更新 Session 或導向登入);
        // 另外查 HTTP 狀態決定提示與重試間隔(429 名額滿、404 路由未發佈時拉長間隔)
        streamError.value = '即時串流中斷,檢查原因中…';
        void paLive.snapshot().then(onSnapshot, () => undefined);
        void paLive.probeStream(paLive.streamUrl(types, filter)).then(({ status, code }) => {
          if (es !== src) return;
          const f = streamFailure(status, code, failures++);
          streamError.value = f.message;
          retry = setTimeout(() => args && connect(args[0], args[1], false), f.delayMs);
        });
      } else streamError.value = '即時串流重新連線中';
    };
  }

  function setPaused(v: boolean) {
    paused.value = v;
    if (!v && pending.length) {
      logs.value = mergeLogs(logs.value, pending, MAX_LOGS);
      pending = [];
    }
  }

  /** 補上連線之前的 log(API 由新到舊):接在目前清單後面(串流可能已先收到更新的),去重、保留上限 */
  function preload(items: LiveLog[]) {
    logs.value = appendOlder(logs.value, items, MAX_LOGS);
  }

  onScopeDispose(close);
  return { logs, connected, lastEventAt, streamError, paused, skipped, degraded, connect, close, setPaused, preload };
}
