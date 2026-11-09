/**
 * 即時監控頁的邏輯(R1,docs/API.md §3.2):
 *   - collectorView:收集器狀態 → 提示語氣與文字;資料停止更新時要明確顯示(AGENT.md §5),不把舊資料當即時
 *   - mergeLogs:新的 log 放前面、去重、保留上限(瀏覽器記憶體)
 *   - useLiveStream:EventSource 連線、暫停、斷線重連(伺服器每 5 分鐘結束連線,瀏覽器自動重連)
 */
import { onScopeDispose, ref, shallowRef } from 'vue';
import { paLive, type CollectorStatus, type LiveLog, type LogFilter, type LogType, type PaLiveSnapshot } from '@/api/paLive';

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
    src.addEventListener('open', touch);
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
        // 不會自動重連(非 200):用一般 API 檢查登入(401 時 web-kit 會更新 Session 或導向登入),稍後再連
        streamError.value = '即時串流中斷,10 秒後重新連線';
        void paLive.snapshot().then(onSnapshot, () => undefined);
        retry = setTimeout(() => args && connect(args[0], args[1], false), 10_000);
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
