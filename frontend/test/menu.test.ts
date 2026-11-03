// 由入口網 test/menu.test.ts 複製(buildMenu、findActive 與入口網相同);NetOps 另加一般連結(href)的案例
import { describe, expect, it } from 'vitest';
import { buildMenu, findActive, type BffMenu, type MenuGroupDef, type MenuPage } from '../src/composables/menu';

const GROUPS: MenuGroupDef[] = [
  { key: 'home', code: 'portal.group.home', title: '首頁', icon: 'home' },
  { key: 'personal', code: 'portal.group.personal', title: '個人資訊', icon: 'user' },
  { key: 'approval', code: 'portal.group.approval', title: '表單與簽核', icon: 'file-check' },
];
const PAGES: MenuPage[] = [
  { path: '/', group: 'home', title: '首頁', permission: 'portal.home.read' },
  { path: '/personal/profile', group: 'personal', title: '個人基本資料', permission: 'portal.profile.read' },
  { path: '/personal/query', group: 'personal', title: '自助查詢', permission: 'portal.query.read' },
  { path: '/approval', group: 'approval', title: '待我簽核', permission: 'portal.approval.read', requires: ['bpm.approval.read'] },
  { path: '/forms', group: 'approval', title: '表單下載', permission: 'portal.form.read' },
];
const canOf = (perms: string[]) => (c: string) => perms.includes(c);
const all = () => true;
const bff = (rows: Record<string, Partial<BffMenu>>) => (code: string | undefined) =>
  code && rows[code] ? { name: code, kind: 'menu', parentCode: null, sort: null, icon: null, ...rows[code] } : undefined;

// rbac/button.feature、ui/navigation.feature
describe('選單依權限過濾', () => {
  it('沒有任何可見功能的大項不顯示', () => {
    const menu = buildMenu(GROUPS, PAGES, { can: canOf(['portal.home.read', 'portal.profile.read']) });
    expect(menu.map((g) => g.key)).toEqual(['home', 'personal']);
    expect(menu[1]!.children.map((p) => p.path)).toEqual(['/personal/profile']);
  });

  it('缺少該頁需要的 API 讀取權限(requires)不顯示', () => {
    const menu = buildMenu(GROUPS, PAGES, { can: canOf(['portal.approval.read', 'portal.form.read']) });
    expect(menu[0]!.children.map((p) => p.path)).toEqual(['/forms']);
  });

  it('沒有可看 Tab 的功能頁不顯示', () => {
    const menu = buildMenu(GROUPS, PAGES, { can: all, pageVisible: (p) => p !== '/personal/query' });
    expect(menu[1]!.children.map((p) => p.path)).toEqual(['/personal/profile']);
  });

  it('BFF 沒有資料時,大項順序與名稱用前端預設', () => {
    const menu = buildMenu(GROUPS, PAGES, { can: all });
    expect(menu.map((g) => g.key)).toEqual(['home', 'personal', 'approval']);
    expect(menu.map((g) => g.code)).toEqual(['portal.group.home', 'portal.group.personal', 'portal.group.approval']);
  });

  it('兩層選單與 Tab 對應網址', () => {
    const menu = buildMenu(GROUPS, PAGES, { can: all });
    const hit = findActive(menu, '/personal/query/overtime');
    expect(hit?.group.title).toBe('個人資訊');
    expect(hit?.item.title).toBe('自助查詢');
    expect(findActive(menu, '/')?.item.title).toBe('首頁');
    expect(findActive(menu, '/personal')).toBeNull();
    expect(findActive(menu, '/approvalx')).toBeNull();
  });
});

// 對齊 GigaItApp:名稱 / 圖示 / 順序 / 頁面歸屬以 BFF 為準(FRAMEWORK-PLAN §3)
describe('選單以 BFF 設定為準', () => {
  it('大項與功能頁的名稱、排序取自 BFF', () => {
    const menuOf = bff({
      'portal.group.personal': { kind: 'group', name: '我的資料', sort: 5 },
      'portal.group.home': { kind: 'group', sort: 10 },
      'portal.profile.read': { name: '基本資料維護', sort: 20 },
      'portal.query.read': { name: '自助查詢', sort: 10 },
    });
    const menu = buildMenu(GROUPS, PAGES, { can: all, menuOf });
    expect(menu.map((g) => g.key)).toEqual(['personal', 'home', 'approval']);
    expect(menu[0]!.title).toBe('我的資料');
    expect(menu[0]!.children.map((p) => p.title)).toEqual(['自助查詢', '基本資料維護']);
  });

  it('頁面在 BFF 改掛到其他大項時歸到該大項', () => {
    const menuOf = bff({ 'portal.form.read': { parentCode: 'portal.group.personal' } });
    const menu = buildMenu(GROUPS, PAGES, { can: all, menuOf });
    expect(menu.find((g) => g.key === 'personal')!.children.map((p) => p.path)).toContain('/forms');
    expect(menu.find((g) => g.key === 'approval')!.children.map((p) => p.path)).toEqual(['/approval']);
  });

  it('BFF 新增的大項(前端沒有預設)以 BFF 名稱顯示', () => {
    const menuOf = bff({
      'portal.group.extra': { kind: 'group', name: '其他', sort: 99, icon: 'star' },
      'portal.form.read': { parentCode: 'portal.group.extra' },
    });
    const menu = buildMenu(GROUPS, PAGES, { can: all, menuOf, hasIcon: (n) => n === 'grid' });
    const extra = menu.find((g) => g.code === 'portal.group.extra')!;
    expect(extra.title).toBe('其他');
    // 不認得的圖示用預設
    expect(extra.icon).toBe('layers');
  });

  it('上層只是一般選單(非 group)時維持預設大項', () => {
    const menuOf = bff({ 'portal.form.read': { parentCode: 'portal.app.access' } });
    const menu = buildMenu(GROUPS, PAGES, { can: all, menuOf });
    expect(menu.find((g) => g.key === 'approval')!.children.map((p) => p.path)).toEqual(['/approval', '/forms']);
  });
});

// NetOps:選單上的一般連結(ARCHITECTURE D11、D18)
describe('一般連結', () => {
  const LINK: MenuPage = { path: 'link:ask', href: 'https://legacy.example/NetOps/Main/PaAsk', group: 'approval', title: 'AI 問答(舊版)' };

  it('沒有權限代碼的連結,有應用權限即顯示,排在同群組功能頁之後', () => {
    const menu = buildMenu(GROUPS, [...PAGES, LINK], { can: canOf(['portal.form.read']) });
    expect(menu.find((g) => g.key === 'approval')!.children.map((p) => p.title)).toEqual(['表單下載', 'AI 問答(舊版)']);
  });

  it('連結不參與目前位置判斷', () => {
    const menu = buildMenu(GROUPS, [LINK], { can: all });
    expect(findActive(menu, '/link:ask')).toBeNull();
  });
});
