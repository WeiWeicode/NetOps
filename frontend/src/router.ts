/**
 * 路由(History 模式,base = /netops/;FRONTEND-GUIDE §4.2):
 *   第一層:選單群組(MENU_GROUPS,BFF 代碼 netops.group.*;ARCHITECTURE §5)
 *   第二層:功能頁(TabbedPage),meta 定義標題與 Tab;MENU_PAGES 由這裡的路由產生,另加一般連結(D11、D18)
 *   第三層:Tab = 子路由(重新整理停在同一個 Tab);F1 第 1 批各頁還沒有 Tab,逐頁改寫時加入 meta.tabs
 * 守衛(同入口網與 GigaItApp;FRONTEND-GUIDE §7.4):
 *   BFF 無法連線 → /unavailable;未登入 → 入口網 /login?redirect=/netops/...;
 *   沒有 netops.app.access → 整頁導回入口網 /?denied=netops(不可停在本系統造成迴圈);
 *   任一層缺少 meta.permission(選單 / Tab)或 meta.requires(API 讀取權限)→ 同頁第一個可看的 Tab,否則 /403(判斷在 composables/guard.ts)。
 *   前端只是體驗,BFF 一定會再以 API 權限檢查。
 */
import { redirectToLogin } from '@giganexus/web-kit';
import { createRouter, createWebHistory, type RouteMeta, type RouteRecordRaw } from 'vue-router';
import { can, canAll, menuOf } from './api/gateway';
import { API, NETOPS } from './api/perms';
import { decideGuard } from './composables/guard';
import { buildMenu, type MenuGroupDef, type MenuPage } from './composables/menu';
import { ensureMe } from './composables/session';
import { LINKS } from './config/links';
import AppLayout from './layouts/AppLayout.vue';
import TabbedPage from './layouts/TabbedPage.vue';
import { hasIcon } from './ui/icons';

declare module 'vue-router' {
  interface RouteMeta {
    /** 該頁需要的 API 讀取權限(全部具備才可進入) */
    requires?: readonly string[];
    title?: string;
    /** 英文副標(頁首 eyebrow) */
    subtitle?: string;
    description?: string;
    icon?: string;
    /** 功能頁所屬的選單群組(MENU_GROUPS.key) */
    group?: string;
    tab?: string;
    tabs?: { label: string; to: string; icon?: string; permission?: string }[];
  }
}

export const MENU_GROUPS: readonly MenuGroupDef[] = [
  { key: 'firewall', code: 'netops.group.firewall', title: '防火牆 PA-560', icon: 'shield' },
  { key: 'ad', code: 'netops.group.ad', title: 'AD 網域', icon: 'gateway' },
  { key: 'knowledge', code: 'netops.group.knowledge', title: '網通知識', icon: 'book-open' },
  // 只放一般連結,不在 BFF 登記(沒有可授予的節點;有應用權限即可看到)
  { key: 'other', code: 'netops.group.other', title: '其他系統', icon: 'external' },
];

/** 開發中的頁面(F1 逐頁改寫,UI-GUIDE §3);改寫完成時換成正式頁面 */
function wip(summary: string, plan?: string[]): RouteRecordRaw {
  return { path: '', component: () => import('./pages/WipPage.vue'), props: { summary, plan, docs: ['NetOps docs/IMPL-PLAN.md F1', 'NetOps docs/UI-GUIDE.md §3'] } };
}

/** 已改寫的頁面(單一內容) */
const page = (component: NonNullable<RouteRecordRaw['component']>): RouteRecordRaw => ({ path: '', component });

interface PageDef {
  path: string;
  meta: Required<Pick<RouteMeta, 'permission' | 'title' | 'subtitle' | 'icon' | 'group'>> & Pick<RouteMeta, 'requires' | 'description'>;
  /** 單一內容(沒有 Tab;子路由 path '') */
  view: RouteRecordRaw;
}

/** 功能頁(ARCHITECTURE §5 權限草案;選單順序同舊版 src/router/menu.js) */
const PAGES: PageDef[] = [
  {
    path: 'firewall/dashboard',
    meta: {
      permission: NETOPS.paDashboard,
      requires: [API.paRead],
      title: '流量總覽',
      subtitle: 'PA-560 Traffic',
      icon: 'shield-check',
      group: 'firewall',
      description: 'TRAFFIC log 的流量統計、排行與趨勢;點排行或長條帶條件到明細查詢',
    },
    view: page(() => import('./pages/firewall/Dashboard.vue')),
  },
  {
    path: 'firewall/events',
    meta: {
      permission: NETOPS.paEvents,
      requires: [API.paRead],
      title: '安全事件',
      subtitle: 'PA-560 Events',
      icon: 'shield-alert',
      group: 'firewall',
      description: 'TRAFFIC 以外的 log:威脅、URL 過濾、資料過濾、WildFire、解密、GlobalProtect、User-ID',
    },
    view: page(() => import('./pages/firewall/Events.vue')),
  },
  {
    path: 'firewall/search',
    meta: {
      permission: NETOPS.paSearch,
      requires: [API.paLogRead],
      title: 'Log 明細查詢',
      subtitle: 'PA-560 Log Search',
      icon: 'search',
      group: 'firewall',
      description: '從 FTP 即時讀取 TRAFFIC log 明細並匯出;送出後在背景查詢(ARCHITECTURE D6)',
    },
    view: page(() => import('./pages/firewall/Search.vue')),
  },
  {
    path: 'firewall/files',
    meta: {
      permission: NETOPS.paFiles,
      requires: [API.ftpRead],
      title: 'FTP Log 檔案',
      subtitle: 'PA-560 FTP Files',
      icon: 'folder',
      group: 'firewall',
      description: 'FTP 上的 PA log 與分析狀態;FTP 唯讀,刪除只刪本系統的分析結果',
    },
    view: page(() => import('./pages/firewall/Files.vue')),
  },
  {
    path: 'ad/events',
    meta: {
      permission: NETOPS.adEvents,
      requires: [API.adRead],
      title: 'AD 事件總覽',
      subtitle: 'AD Events',
      icon: 'activity',
      group: 'ad',
      description: '網域控制站每天匯出的事件統計、帳號與特權異動;點選帶條件到明細查詢',
    },
    view: page(() => import('./pages/ad/Events.vue')),
  },
  {
    path: 'ad/search',
    meta: {
      permission: NETOPS.adSearch,
      requires: [API.adLogRead],
      title: 'Log 明細查詢',
      subtitle: 'AD Log Search',
      icon: 'search',
      group: 'ad',
      description: '已匯入的 AD 事件(Security / System / 目錄服務 / DNS)依時間與條件查詢並匯出',
    },
    view: page(() => import('./pages/ad/Search.vue')),
  },
  {
    path: 'ad/files',
    meta: {
      permission: NETOPS.adFiles,
      requires: [API.ftpRead],
      title: 'FTP Log 檔案',
      subtitle: 'AD FTP Files',
      icon: 'folder',
      group: 'ad',
      description: 'DC 每天匯出到 FTP 的 AD 事件檔與匯入狀態;FTP 唯讀',
    },
    view: page(() => import('./pages/ad/Files.vue')),
  },
  {
    path: 'knowledge',
    meta: {
      permission: NETOPS.kbPage,
      requires: [API.kbRead],
      title: '知識庫',
      subtitle: 'Network Knowledge',
      icon: 'book-open',
      group: 'knowledge',
      description: '網通環境筆記;AI 問答與分析會自動參考(語意搜尋與自動學習在舊版,ARCHITECTURE D17)',
    },
    view: page(() => import('./pages/knowledge/Knowledge.vue')),
  },
];

/** 一般連結(另開分頁;D11、D18) */
const LINK_PAGES: MenuPage[] = [
  // AI 問答查的是 PA / AD 資料:有對應的讀取權限才顯示
  { path: 'link:pa-ask', href: LINKS.paAsk, group: 'firewall', title: 'AI 問答(舊版)', icon: 'sparkles', requires: [API.paRead] },
  { path: 'link:ad-ask', href: LINKS.adAsk, group: 'ad', title: 'AI 問答(舊版)', icon: 'sparkles', requires: [API.adRead] },
  { path: 'link:veeam', href: LINKS.veeam, group: 'other', title: 'Veeam 備份監控', icon: 'database' },
];

const shell: RouteRecordRaw = {
  path: '/',
  component: AppLayout,
  children: [
    { path: '', redirect: '/firewall/dashboard' },
    ...PAGES.map(
      (p): RouteRecordRaw => ({
        path: p.path,
        component: TabbedPage,
        meta: { ...p.meta },
        children: [p.view],
      }),
    ),
    { path: '403', component: () => import('./pages/Forbidden.vue'), meta: { title: '沒有權限' } },
    { path: ':pathMatch(.*)*', component: () => import('./pages/NotFound.vue'), meta: { title: '找不到頁面' } },
  ],
};

const routes: RouteRecordRaw[] = [
  { path: '/unavailable', component: () => import('./pages/Unavailable.vue'), meta: { public: true, title: '暫時無法連線' } },
  shell,
];

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

const pageOf = (path: string) => (shell.children ?? []).find((r) => `/${r.path}` === path);

/** 功能頁中第一個有權限的 Tab(Tab 權限 ∩ 該 Tab 子路由需要的讀取權限);沒有 Tab 定義時回頁面本身 */
function firstTab(page: RouteRecordRaw): string | null {
  const tabs = page.meta?.tabs ?? [];
  if (!tabs.length) return `/${page.path}`;
  for (const t of tabs) {
    if (t.permission && !can(t.permission)) continue;
    const child = (page.children ?? []).find((c) => `/${page.path}${c.path ? `/${c.path}` : ''}` === t.to);
    if (!child || canAll(child.meta?.requires)) return t.to;
  }
  return null;
}

const MENU_PAGES: MenuPage[] = [
  ...PAGES.map((p) => ({
    path: `/${p.path}`,
    group: p.meta.group,
    title: p.meta.title,
    icon: p.meta.icon,
    permission: p.meta.permission,
    requires: p.meta.requires,
  })),
  ...LINK_PAGES,
];
/** 側欄選單(AppLayout 使用) */
export const netopsMenus = () =>
  buildMenu(MENU_GROUPS, MENU_PAGES, {
    can,
    menuOf,
    hasIcon,
    pageVisible: (path) => {
      const rec = pageOf(path);
      return !rec || firstTab(rec) !== null;
    },
  });

/** 第一個可見的功能頁與 Tab(預設首頁沒有權限時改到這裡) */
function firstAllowed(): string | null {
  for (const p of PAGES) {
    if (can(p.meta.permission) && canAll(p.meta.requires)) {
      const t = firstTab(pageOf(`/${p.path}`)!);
      if (t) return t;
    }
  }
  return null;
}

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  let me;
  try {
    me = await ensureMe();
  } catch {
    // BFF 無法連線(非 401):顯示維護頁,不導向登入
    return { path: '/unavailable', query: { redirect: to.fullPath } };
  }
  const page = to.matched[1];
  const d = decideGuard({
    me,
    matched: to.matched.map((r) => r.meta),
    path: to.path,
    fromRoot: to.redirectedFrom?.path === '/',
    can,
    pageFirstTab: () => {
      const rec = page && pageOf(page.path);
      return rec ? firstTab(rec) : null;
    },
    firstAllowed,
  });
  if (d.kind === 'allow') return true;
  if (d.kind === 'redirect') return d.to;
  if (d.kind === 'login') redirectToLogin();
  // 回入口網並帶提示參數(不可停在本系統造成迴圈)
  else location.replace(d.url);
  return false;
});

router.afterEach((to) => {
  const title = to.matched[1]?.meta.title ?? to.meta.title;
  document.title = title ? `${title} - 資訊網通管理系統` : '資訊網通管理系統';
});
