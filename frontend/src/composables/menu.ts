/**
 * 兩層選單(由入口網 composables/menu.ts 複製;對齊 GigaItApp api/auth.ts 的 buildMenus):
 *   - 預設值:router.ts 的 MENU_GROUPS(大項,BFF 代碼 netops.group.*)與 MENU_PAGES(功能頁)
 *   - 實際顯示以 BFF 為準(/api/auth/me 的 menus,IT 在 GigaItApp「選單管理」維護):大項的名稱 / 圖示 / 順序、
 *     功能頁的名稱 / 順序,以及功能頁歸在哪個大項(頁面在 BFF 的上層目錄);BFF 沒有資料時用預設值
 *   - 可見 = 選單權限 ∩ 該頁需要的 API 讀取權限(requires)∩ 至少一個可看的 Tab;沒有可見功能的大項不顯示
 *   - NetOps 增加 href:一般連結(另開分頁,ARCHITECTURE D11、D18),不是本系統路由,不參與目前位置判斷
 */
export interface MenuGroupDef {
  key: string;
  /** BFF 的選單目錄代碼(kind = group,登記在 deploy/gateway-rbac.yaml) */
  code: string;
  title: string;
  subtitle?: string;
  icon: string;
}
export interface MenuPage {
  path: string;
  group: string;
  title: string;
  subtitle?: string;
  icon?: string;
  permission?: string;
  /** 該頁需要的 API 讀取權限(Gateway includes) */
  requires?: readonly string[];
  /** 一般連結(其他系統):有值時另開分頁,path 只當識別用 */
  href?: string;
}
export interface MenuGroup extends MenuGroupDef {
  children: MenuPage[];
}

/** BFF 的畫面權限設定(web-kit MeMenu 的子集) */
export interface BffMenu {
  name: string;
  kind: string;
  parentCode: string | null;
  sort: number | null;
  icon: string | null;
}

export interface MenuSource {
  can: (code: string) => boolean;
  /** BFF 的選單設定;沒有時用前端預設 */
  menuOf?: (code: string | undefined) => BffMenu | undefined;
  /** 圖示名稱是否已登記(ui/icons.ts);不認得的 BFF 圖示用前端預設 */
  hasIcon?: (name: string | null | undefined) => boolean;
  /** 功能頁是否至少有一個可看的 Tab(router.ts 提供) */
  pageVisible?: (path: string) => boolean;
}

type Sorted = { sort: number | null; order: number };
const bySort = <T extends Sorted>(a: T, b: T) => (a.sort !== null && b.sort !== null && a.sort !== b.sort ? a.sort - b.sort : a.order - b.order);

export function buildMenu(groups: readonly MenuGroupDef[], pages: readonly MenuPage[], src: MenuSource): MenuGroup[] {
  const { can, menuOf = () => undefined, hasIcon = () => false, pageVisible = () => true } = src;
  const defaults = new Map(groups.map((g, i) => [g.code, { g, i }]));
  const codeOfKey = new Map(groups.map((g) => [g.key, g.code]));
  const buckets = new Map<string, (MenuPage & Sorted)[]>();
  pages.forEach((p, pi) => {
    if (p.permission && !can(p.permission)) return;
    if (p.requires && !p.requires.every(can)) return;
    if (!pageVisible(p.path)) return;
    const m = menuOf(p.permission);
    const parent = m?.parentCode ?? null;
    const fallback = codeOfKey.get(p.group) ?? p.group;
    // 頁面在 BFF 掛到某個目錄(group)時歸到該目錄;否則用預設大項
    const code = parent && (defaults.has(parent) || menuOf(parent)?.kind === 'group') ? parent : fallback;
    const list = buckets.get(code) ?? [];
    list.push({ ...p, title: m?.name ?? p.title, sort: m?.sort ?? null, order: pi });
    buckets.set(code, list);
  });
  return [...buckets.entries()]
    .map(([code, items]) => {
      const d = defaults.get(code);
      const m = menuOf(code);
      return {
        key: d?.g.key ?? code,
        code,
        title: m?.name ?? d?.g.title ?? code,
        subtitle: d?.g.subtitle,
        icon: hasIcon(m?.icon) ? m!.icon! : (d?.g.icon ?? 'layers'),
        sort: m?.sort ?? null,
        order: d?.i ?? 999,
        children: items.sort(bySort).map(({ sort: _s, order: _o, ...c }) => c),
      };
    })
    .sort(bySort)
    .map(({ sort: _s, order: _o, ...g }) => g);
}

/** 目前路徑所在的選單項目(最長前綴相符) */
export function findActive(menu: readonly MenuGroup[], path: string): { group: MenuGroup; item: MenuPage } | null {
  let best: { group: MenuGroup; item: MenuPage } | null = null;
  for (const group of menu)
    for (const item of group.children) {
      if (item.href) continue;
      const hit = item.path === '/' ? path === '/' : path === item.path || path.startsWith(`${item.path}/`);
      if (hit && (!best || item.path.length > best.item.path.length)) best = { group, item };
    }
  return best;
}
