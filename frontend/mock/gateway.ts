/**
 * 本機假 Gateway(只在 dev 且設定 MOCK 時啟用,不進建置輸出):不連測試區,用來看畫面與三種帳號。
 *   MOCK=admin   netops-admin:全部權限(ARCHITECTURE §5)
 *   MOCK=viewer  netops-viewer:全部 .read,沒有 netops.ftp.write、netops.kb.write 與管理按鈕
 *   MOCK=noapp   已登入但沒有 netops.app.access(應導回入口網 /?denied=netops)
 *   MOCK=anon    未登入(/api/auth/me 回 401,應導向 /login)
 * 回應格式以 docs/API.md 為準;各模組的假 API 在 mock/<模組>.ts(後端尚未實作的也在這裡提供假資料)。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { handleAd } from './ad.ts';
import { handleAi } from './ai.ts';
import { handleFtp } from './ftp.ts';
import { handleKb } from './kb.ts';
import { handlePaLog } from './paLog.ts';
import { handlePa } from './pa.ts';
import { handlePaEvents } from './paEvents.ts';
import { handlePaLive, streamPaLive } from './paLive.ts';
import type { MockCtx } from './types.ts';
import { handleViz } from './viz.ts';

type Role = 'admin' | 'viewer' | 'noapp' | 'anon';
type LoggedIn = Exclude<Role, 'anon'>;

const MENUS = [
  { code: 'netops.app.access', name: '資訊網通管理系統使用權限', kind: 'app', parentCode: null, sort: 30, icon: null },
  { code: 'netops.group.firewall', name: '防火牆 PA-560', kind: 'group', parentCode: 'netops.app.access', sort: 10, icon: 'shield' },
  { code: 'netops.group.ad', name: 'AD 網域', kind: 'group', parentCode: 'netops.app.access', sort: 20, icon: 'gateway' },
  { code: 'netops.group.knowledge', name: '網通知識', kind: 'group', parentCode: 'netops.app.access', sort: 30, icon: 'book-open' },
  { code: 'netops.pa-live.read', name: '即時監控', kind: 'menu', parentCode: 'netops.group.firewall', sort: 5, icon: null },
  { code: 'netops.pa-live.manage', name: '測試區暫停 / 繼續收集器', kind: 'button', parentCode: 'netops.pa-live.read', sort: 10, icon: null },
  { code: 'netops.pa-dashboard.read', name: '流量總覽', kind: 'menu', parentCode: 'netops.group.firewall', sort: 10, icon: null },
  // V-b1:活動熱力圖、分析儀表板(gateway-rbac.yaml sort 12、15)
  { code: 'netops.pa-heatmap.read', name: '活動熱力圖', kind: 'menu', parentCode: 'netops.group.firewall', sort: 12, icon: null },
  { code: 'netops.pa-insight.read', name: '分析儀表板', kind: 'menu', parentCode: 'netops.group.firewall', sort: 15, icon: null },
  { code: 'netops.pa-events.read', name: '安全事件', kind: 'menu', parentCode: 'netops.group.firewall', sort: 20, icon: null },
  { code: 'netops.pa-search.read', name: 'Log 明細查詢', kind: 'menu', parentCode: 'netops.group.firewall', sort: 30, icon: null },
  { code: 'netops.pa-files.read', name: 'FTP Log 檔案', kind: 'menu', parentCode: 'netops.group.firewall', sort: 40, icon: null },
  { code: 'netops.pa-files.manage', name: '管理', kind: 'button', parentCode: 'netops.pa-files.read', sort: 10, icon: null },
  { code: 'netops.ad-events.read', name: 'AD 事件總覽', kind: 'menu', parentCode: 'netops.group.ad', sort: 10, icon: null },
  { code: 'netops.ad-search.read', name: 'Log 明細查詢', kind: 'menu', parentCode: 'netops.group.ad', sort: 20, icon: null },
  { code: 'netops.ad-files.read', name: 'FTP Log 檔案', kind: 'menu', parentCode: 'netops.group.ad', sort: 30, icon: null },
  { code: 'netops.ad-files.manage', name: '管理', kind: 'button', parentCode: 'netops.ad-files.read', sort: 10, icon: null },
  { code: 'netops.kb-page.read', name: '知識庫', kind: 'menu', parentCode: 'netops.group.knowledge', sort: 10, icon: null },
  { code: 'netops.kb-page.write', name: '編輯', kind: 'button', parentCode: 'netops.kb-page.read', sort: 10, icon: null },
  // A1:AI 問答與分析(netops.ai.use 由按鈕綁定;admin 與 viewer 都有)
  { code: 'netops.pa-ask.read', name: 'AI 問答', kind: 'menu', parentCode: 'netops.group.firewall', sort: 50, icon: null },
  { code: 'netops.pa-ask.use', name: '使用 AI 問答', kind: 'button', parentCode: 'netops.pa-ask.read', sort: 10, icon: null },
  { code: 'netops.pa-dashboard.ai', name: 'AI 分析', kind: 'button', parentCode: 'netops.pa-dashboard.read', sort: 10, icon: null },
  { code: 'netops.ad-ask.read', name: 'AI 問答', kind: 'menu', parentCode: 'netops.group.ad', sort: 40, icon: null },
  { code: 'netops.ad-ask.use', name: '使用 AI 問答', kind: 'button', parentCode: 'netops.ad-ask.read', sort: 10, icon: null },
];
const READ_API = ['netops.ping.read', 'netops.pa-realtime.read', 'netops.pa.read', 'netops.pa-log.read', 'netops.ftp.read', 'netops.ad.read', 'netops.ad-log.read', 'netops.kb.read', 'netops.ai.use'];
/** viewer 也有的 AI 按鈕(netops.ai.use 給 admin 與 viewer,2026-11-05 決定) */
const AI_BUTTONS = ['netops.pa-ask.use', 'netops.pa-dashboard.ai', 'netops.ad-ask.use'];
const WRITE_API = ['netops.ftp.write', 'netops.kb.write', 'netops.pa-realtime.write'];
const BUTTONS = MENUS.filter((m) => m.kind === 'button').map((m) => m.code);
const PAGES = MENUS.filter((m) => m.kind === 'app' || m.kind === 'menu').map((m) => m.code);

function me(role: LoggedIn) {
  const perms = role === 'admin' ? [...PAGES, ...BUTTONS, ...READ_API, ...WRITE_API] : role === 'viewer' ? [...PAGES, ...AI_BUTTONS, ...READ_API] : ['portal.app.access'];
  const own = new Set(perms);
  return {
    user: { userId: 1, employeeNo: 'T000001', name: '測試人員', email: null, deptCode: 'IT', department: '資訊部', title: '工程師', authType: 'ad' },
    companies: ['GSMC'],
    roles: role === 'admin' ? ['netops-admin'] : role === 'viewer' ? ['netops-viewer'] : [],
    permissions: perms,
    // BFF 回傳擁有的畫面節點與其所在目錄
    menus: MENUS.filter((m) => own.has(m.code) || (m.kind === 'group' && role !== 'noapp')),
    // gw.app 在 D1 才登記 netops:apps 不含本系統,前端以 netops.app.access 暫時推導
    apps: [
      { code: 'portal', name: '員工入口網', basePath: '/', icon: 'home' },
      { code: 'it', name: 'IT 管理系統', basePath: '/it/', icon: 'monitor' },
    ],
  };
}

const rid = () => `mock-${Date.now().toString(36)}`;
function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('X-Request-Id', rid());
  if (status === 204) return void res.end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** 讀 JSON body(假 Gateway 只處理小量 JSON) */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** 各模組的假 API(依序嘗試,處理了就回 true) */
const HANDLERS: ((ctx: MockCtx) => boolean)[] = [handleViz, handleAi, handleFtp, handleAd, handlePaEvents, handlePa, handlePaLog, handleKb, handlePaLive];
const fail = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { code, message, requestId: rid() });

export function mockGateway(role: string | undefined): Plugin | null {
  if (!role) return null;
  if (!['admin', 'viewer', 'noapp', 'anon'].includes(role)) throw new Error(`MOCK 只能是 admin / viewer / noapp / anon,收到 ${role}`);
  const r = role as Role;
  return {
    name: 'netops-mock-gateway',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? '/', 'http://mock');
        const path = url.pathname;
        // 入口網首頁與登入頁的替身:守衛導回 / 或 /login 時停在這裡(否則 Vite 會把 / 轉回 /netops/ 造成迴圈)
        if (path === '/' || path === '/login') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end(`<!doctype html><meta charset="utf-8"><title>假入口網</title><p>假入口網 ${path}${url.search.replace(/[<>&"]/g, '')}</p>`);
        }
        if (!path.startsWith('/api/')) return next();
        if (path === '/api/auth/me') return r === 'anon' ? fail(res, 401, 'UNAUTHORIZED', '尚未登入') : send(res, 200, me(r));
        if (path === '/api/auth/logout') return send(res, 200, { ok: true });
        if (r === 'anon' || path === '/api/auth/refresh') return fail(res, 401, 'UNAUTHORIZED', '尚未登入');
        const m = me(r);
        const need = (perm: string) => m.permissions.includes(perm) || (fail(res, 403, 'PERMISSION_DENIED', `沒有權限 ${perm}`), false);
        const method = req.method ?? 'GET';
        // 即時監控 SSE(R1):直接寫串流,不經下面的延遲與 JSON 回應
        if (path === '/api/netops/pa-live/stream' && method === 'GET') return need('netops.pa-realtime.read') ? streamPaLive(url, res, fail.bind(null, res)) : undefined;
        const ctx: MockCtx = {
          method,
          path,
          url,
          body: method === 'GET' ? undefined : await readBody(req),
          need,
          send: (status, body) => send(res, status, body),
          fail: (status, code, message) => fail(res, status, code, message),
          user: `${m.user.employeeNo} ${m.user.name}`,
          raw: res,
          sendFile: (contentType, filename, text) => {
            res.statusCode = 200;
            res.setHeader('X-Request-Id', rid());
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
            res.end(text);
          },
        };
        // 模擬網路延遲,看得到載入狀態
        await new Promise((r) => setTimeout(r, 250));
        for (const h of HANDLERS) if (h(ctx)) return;
        return fail(res, 404, 'NETOPS_NOT_FOUND', `假 Gateway 沒有 ${method} ${path}`);
      });
    },
  };
}
