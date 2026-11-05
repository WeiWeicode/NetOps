#!/usr/bin/env node
/**
 * S0 串流驗證腳本(IMPL-PLAN S0、docs/test-reports/2026-11-05-s0-sse.md):
 * 經 Gateway 連線 GET /api/netops/pa-live/stream-test,記錄每個事件的到達時間、間隔、斷線與重連,結束時列出判定結果。
 *
 * 登入 Cookie 由執行者自己從瀏覽器複製(腳本不經手帳密,不印出、不寫檔 Cookie):
 *   1. 瀏覽器登入測試區入口網,開 /netops/,F12 → Network → 任一 /api/netops/ 請求 → Request Headers 的 Cookie,複製整串值
 *   2. 在 NetOps repo 根目錄執行 `node backend/scripts/sse-probe.mjs --minutes 6 --drop-at 120`,
 *      出現「貼上 Cookie」時貼上按 Enter(輸入不顯示,也不會留在 PowerShell 歷史紀錄)
 *   3. 驗證完到入口網登出,讓這組 Cookie 失效
 *   也可以先設環境變數 NETOPS_COOKIE(例如 PowerShell 7 `$env:NETOPS_COOKIE = Read-Host -MaskInput 'Cookie'`);
 *   不要直接在指令列寫 `$env:NETOPS_COOKIE = '<值>'`,會留在 PSReadLine 歷史檔。
 *   測試區憑證不是公開 CA 簽發時,設定 NODE_EXTRA_CA_CERTS 指向公司 CA 憑證檔(不要關閉 TLS 驗證)。
 *
 * 參數:
 *   --url <網址>         預設 https://giganexus-test.gigasolar.com.tw/api/netops/pa-live/stream-test(或環境變數 NETOPS_SSE_URL)
 *                        只接受 https 與下列主機;http 只限 localhost / 127.0.0.1(本機模擬)
 *   --allow-host <主機>  另外允許的主機(確定是 GigaNexus Gateway 才加)
 *   --minutes <分>       連線總時長,預設 6(完成條件要 5 分鐘以上)
 *   --drop-at <秒>       到這個秒數時主動斷線一次,驗證以 Last-Event-ID 重連;0 = 不主動斷線(預設 120)
 *   --log <檔案>         另把每個事件寫成 JSON Lines(不含 Cookie;不要提交進版控)
 *
 * 結束碼:0 = 全部判定通過;1 = 有判定失敗;2 = 參數或連線設定錯誤(401 / 403 / 404 / 429、轉址、網址不允許)。
 */
import fs from 'node:fs';
import readline from 'node:readline';

const ALLOWED_HOSTS = new Set(['giganexus-test.gigasolar.com.tw', 'giganexus.gigasolar.com.tw']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const FLAGS = new Set(['url', 'allow-host', 'minutes', 'drop-at', 'log']);

function usage(msg) {
  console.error(`${msg}(參數說明見 backend/scripts/sse-probe.mjs 檔頭)`);
  process.exit(2);
}

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const flag = argv[i].replace(/^--/, '');
  if (!argv[i].startsWith('--') || !FLAGS.has(flag)) usage(`不認得的參數:${argv[i]}`);
  if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) usage(`${argv[i]} 缺少值`);
  args[flag] = argv[i + 1];
}
const url = new URL(args.url ?? process.env.NETOPS_SSE_URL ?? 'https://giganexus-test.gigasolar.com.tw/api/netops/pa-live/stream-test');
if (args['allow-host']) ALLOWED_HOSTS.add(args['allow-host'].toLowerCase());
const local = LOCAL_HOSTS.has(url.hostname);
if (!(url.protocol === 'https:' && (ALLOWED_HOSTS.has(url.hostname) || local)) && !(url.protocol === 'http:' && local))
  usage(`不允許的網址 ${url.origin}:Cookie 只送到 https 的 GigaNexus Gateway`);
const totalMs = Number(args.minutes ?? 6) * 60_000;
const dropAtMs = Number(args['drop-at'] ?? 120) * 1000;
const logFile = args.log;
if (!(totalMs > 0) || !(dropAtMs >= 0)) usage('--minutes 需大於 0、--drop-at 需大於等於 0');

/** 從 stdin 讀 Cookie,不回顯 */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(prompt)) process.stdout.write(s);
    };
    rl.question(prompt, (v) => {
      rl.close();
      process.stdout.write('\n');
      resolve(v.trim());
    });
  });
}
const cookie = process.env.NETOPS_COOKIE || (process.stdin.isTTY ? await askHidden('貼上 Cookie(不顯示): ') : '');
if (!cookie) usage('沒有 Cookie:請在提示時貼上,或設定環境變數 NETOPS_COOKIE');

/** 預期的心跳間隔與允許誤差:超過 20 秒沒有事件視為被緩衝或卡住 */
const HEARTBEAT_MS = 15_000;
const MAX_GAP_MS = 20_000;
const FIRST_EVENT_MS = 3_000;
/** 連續非預期錯誤(5xx、連線錯誤)幾次就停止,避免一直打 Gateway */
const MAX_ERRORS = 3;

const t0 = Date.now();
const since = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const connections = [];
let lastId = null;
let retryMs = 5000;
let dropped = false;
let fatal = null;

/** 一次連線:回傳 'done'(到時長)、'drop'(主動斷線)、'ended'(伺服器結束)、'error'、'fatal' */
async function connectOnce() {
  const conn = { n: connections.length + 1, start: Date.now(), sentLastId: lastId, firstEventMs: null, events: 0, maxGapMs: 0, end: null, reason: null, resumedFrom: null, firstSeqAfterOpen: null };
  connections.push(conn);
  const ctrl = new AbortController();
  const stopTimer = setTimeout(() => ctrl.abort('done'), totalMs - (Date.now() - t0));
  let dropTimer = null;
  if (!dropped && dropAtMs > 0 && dropAtMs < totalMs) {
    const wait = dropAtMs - (Date.now() - t0);
    if (wait > 0) dropTimer = setTimeout(() => ((dropped = true), ctrl.abort('drop')), wait);
  }
  const headers = { accept: 'text/event-stream', cookie, 'cache-control': 'no-cache' };
  if (lastId !== null) headers['last-event-id'] = lastId;
  console.log(`[${since()}s] 連線 #${conn.n}${lastId !== null ? `(Last-Event-ID: ${lastId})` : ''}`);
  let prev = Date.now();
  try {
    // 不跟隨轉址:避免 Cookie 被帶到別的路徑或主機
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'manual' });
    const type = res.headers.get('content-type') ?? '';
    console.log(`[${since()}s]   HTTP ${res.status} ${type} x-accel-buffering=${res.headers.get('x-accel-buffering')} x-route-code=${res.headers.get('x-route-code')}`);
    if ([301, 302, 303, 307, 308, 401, 403, 404, 429].includes(res.status)) {
      const body = (await res.text()).slice(0, 200);
      const hint = { 401: 'Cookie 過期或貼錯', 403: '帳號沒有 netops.ping.read', 404: '路由尚未發佈', 429: '串流名額已滿(每人 2 條),關閉其他分頁或稍候' }[res.status] ?? '被轉址(網址不對,或未登入被導向登入頁)';
      fatal = `HTTP ${res.status}(${hint}):${body}`;
      conn.reason = fatal;
      return 'fatal';
    }
    if (!res.ok || !type.startsWith('text/event-stream')) {
      conn.reason = `HTTP ${res.status} ${type}`;
      await res.body?.cancel();
      return 'error';
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = {};
        for (const line of block.split('\n')) {
          const p = line.indexOf(': ');
          if (p >= 0) ev[line.slice(0, p)] = line.slice(p + 2);
        }
        if (ev.retry) retryMs = Number(ev.retry) || retryMs;
        if (!ev.event) continue;
        const now = Date.now();
        const gap = now - prev;
        prev = now;
        let data = {};
        try {
          data = JSON.parse(ev.data ?? '{}');
        } catch {
          /* 格式錯誤照樣記錄 */
        }
        if (ev.id !== undefined) lastId = ev.id;
        conn.events++;
        if (conn.firstEventMs === null) conn.firstEventMs = now - conn.start;
        else conn.maxGapMs = Math.max(conn.maxGapMs, gap);
        if (ev.event === 'open') conn.resumedFrom = data.resumedFrom ?? null;
        else if (conn.firstSeqAfterOpen === null) conn.firstSeqAfterOpen = data.seq;
        const lagMs = data.time ? now - Date.parse(data.time) : null;
        const rec = { t: new Date(now).toISOString(), elapsedSec: (now - t0) / 1000, conn: conn.n, event: ev.event, id: ev.id, seq: data.seq, serverTime: data.time, gapMs: gap, lagMs };
        if (logFile) fs.appendFileSync(logFile, JSON.stringify(rec) + '\n');
        console.log(`[${since()}s]   ${ev.event.padEnd(9)} id=${String(ev.id).padStart(4)} 間隔 ${(gap / 1000).toFixed(1).padStart(5)}s 伺服器時間差 ${lagMs ?? '-'} ms`);
      }
    }
    conn.reason = '伺服器結束連線';
    return 'ended';
  } catch (err) {
    if (ctrl.signal.aborted) {
      conn.reason = ctrl.signal.reason === 'drop' ? '主動斷線(驗證重連)' : '到達設定時長';
      return ctrl.signal.reason;
    }
    conn.reason = `連線錯誤:${err.cause?.code ?? err.message}`;
    return 'error';
  } finally {
    clearTimeout(stopTimer);
    if (dropTimer) clearTimeout(dropTimer);
    conn.end = Date.now();
    // 最後一個事件到連線結束的空窗也要算:被緩衝或卡住時,事件之間的間隔看起來正常,但之後一直沒有資料
    if (conn.events > 0) conn.maxGapMs = Math.max(conn.maxGapMs, conn.end - prev);
    console.log(`[${since()}s] 連線 #${conn.n} 結束:${conn.reason}`);
  }
}

let errors = 0;
while (Date.now() - t0 < totalMs) {
  const r = await connectOnce();
  if (r === 'fatal' || r === 'done') break;
  errors = r === 'error' ? errors + 1 : 0;
  if (errors >= MAX_ERRORS) {
    console.log(`[${since()}s] 連續 ${MAX_ERRORS} 次錯誤,停止重連(避免累積 BFF 斷路器失敗)`);
    break;
  }
  // 模擬瀏覽器 EventSource:依 retry 等待後重連;錯誤時加倍等待
  await new Promise((ok) => setTimeout(ok, retryMs * 2 ** errors));
}

// ── 判定 ──
const ok = (pass, name, detail) => ({ pass, name, detail });
const elapsed = Date.now() - t0;
const longest = Math.max(0, ...connections.map((c) => (c.end ?? Date.now()) - c.start));
const firstConn = connections[0];
const unexpected = connections.filter((c) => /連線錯誤|HTTP|伺服器結束/.test(c.reason ?? ''));
const totalEvents = connections.reduce((n, c) => n + c.events, 0);
const expectedEvents = Math.floor((elapsed / HEARTBEAT_MS) * 0.8);
const maxGap = Math.max(0, ...connections.map((c) => c.maxGapMs));
const reconnect = connections.find((c, i) => i > 0 && c.sentLastId !== null);
const resumedOk = reconnect && reconnect.resumedFrom === Number(reconnect.sentLastId) && (reconnect.firstSeqAfterOpen === null || reconnect.firstSeqAfterOpen === reconnect.resumedFrom + 1);
const checks = fatal
  ? [ok(false, '連線設定', fatal)]
  : [
      ok(firstConn?.firstEventMs !== null && firstConn.firstEventMs <= FIRST_EVENT_MS, '不被緩衝:第一個事件立即到達', `${firstConn?.firstEventMs ?? '-'} ms(上限 ${FIRST_EVENT_MS})`),
      ok(maxGap > 0 && maxGap <= MAX_GAP_MS, `事件間隔(含最後一個事件到斷線)不超過 ${MAX_GAP_MS / 1000} 秒(心跳 ${HEARTBEAT_MS / 1000} 秒)`, `最大 ${(maxGap / 1000).toFixed(1)} 秒`),
      ok(totalEvents >= expectedEvents, '事件數量足夠(至少為 總時長 / 15 秒 的八成)', `${totalEvents} 個(至少 ${expectedEvents})`),
      // Nginx proxy_read_timeout 與 BFF 路由逾時都是 60 秒(閒置時間,不是總時長):單一連線要撐過 65 秒以上才算驗證到
      ok(longest >= 65_000 && unexpected.length === 0, '單一連線超過 65 秒仍不中斷、沒有非預期斷線', `最長一次連線 ${(longest / 1000).toFixed(0)} 秒;非預期斷線 ${unexpected.length} 次`),
      ok(elapsed >= 5 * 60_000, '總時長 5 分鐘以上', `${(elapsed / 60_000).toFixed(1)} 分鐘`),
      dropAtMs > 0 && dropAtMs < totalMs
        ? ok(Boolean(resumedOk), '斷線後以 Last-Event-ID 重連,序號接續', reconnect ? `連線 #${reconnect.n} 送出 ${reconnect.sentLastId},resumedFrom=${reconnect.resumedFrom},下一個 seq=${reconnect.firstSeqAfterOpen}` : '沒有重連')
        : ok(true, '斷線重連(未測,--drop-at 0)', '略過'),
    ];

console.log('\n── 連線 ──');
for (const c of connections)
  console.log(`#${c.n} ${(((c.end ?? Date.now()) - c.start) / 1000).toFixed(0).padStart(4)} 秒 事件 ${String(c.events).padStart(3)} 個 首個事件 ${c.firstEventMs ?? '-'} ms 最大間隔 ${(c.maxGapMs / 1000).toFixed(1)} 秒 resumedFrom=${c.resumedFrom} 結束:${c.reason}`);
console.log('\n── 判定 ──');
for (const c of checks) console.log(`${c.pass ? '✅' : '❌'} ${c.name}:${c.detail}`);
console.log('\n斷路器是否累積失敗,請另查 giga-observe 與 BFF 日誌(見測試報告 §3.5)。驗證完請到入口網登出。');
process.exit(fatal ? 2 : checks.every((c) => c.pass) ? 0 : 1);
