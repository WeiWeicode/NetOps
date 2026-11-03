import { describe, expect, it } from 'vitest';
import { decideGuard, type GuardInput } from '../src/composables/guard';

const APP = 'netops.app.access';
const DASH = { permission: 'netops.pa-dashboard.read', requires: ['netops.pa.read'] };
const shell = {};
function input(perms: string[] | null, over: Partial<GuardInput> = {}): GuardInput {
  return {
    me: perms && { permissions: perms },
    matched: [shell, DASH, {}],
    path: '/firewall/dashboard',
    fromRoot: false,
    can: (c) => !!perms?.includes(c),
    pageFirstTab: () => '/firewall/dashboard',
    firstAllowed: () => null,
    ...over,
  };
}

// FRONTEND-GUIDE §7.4、§7.5.3
describe('路由守衛', () => {
  it('未登入導向登入頁', () => {
    expect(decideGuard(input(null))).toEqual({ kind: 'login' });
  });

  it('沒有本系統應用權限時整頁導回入口網並帶提示參數', () => {
    expect(decideGuard(input(['portal.app.access']))).toEqual({ kind: 'leave', url: '/?denied=netops' });
  });

  it('有選單與 API 讀取權限時可進入', () => {
    expect(decideGuard(input([APP, DASH.permission, ...DASH.requires]))).toEqual({ kind: 'allow' });
  });

  it('有選單但缺少該頁的 API 讀取權限時 403', () => {
    expect(decideGuard(input([APP, DASH.permission]))).toEqual({ kind: 'redirect', to: '/403' });
  });

  it('直接輸入沒有權限的網址顯示 403,不改道', () => {
    expect(decideGuard(input([APP], { firstAllowed: () => '/knowledge' }))).toEqual({ kind: 'redirect', to: '/403' });
  });

  it('從 / 進入而預設首頁沒有權限時,改到第一個可見功能', () => {
    expect(decideGuard(input([APP], { fromRoot: true, firstAllowed: () => '/knowledge' }))).toEqual({ kind: 'redirect', to: '/knowledge' });
    // 沒有任何可見功能 → 403(不迴圈)
    expect(decideGuard(input([APP], { fromRoot: true }))).toEqual({ kind: 'redirect', to: '/403' });
  });

  it('功能頁可看、目前 Tab 沒權限時改到同頁第一個可看的 Tab', () => {
    const tab = { permission: 'netops.x.tab-b' };
    const r = decideGuard(input([APP, DASH.permission, ...DASH.requires], { matched: [shell, DASH, tab], path: '/firewall/dashboard/b' }));
    expect(r).toEqual({ kind: 'redirect', to: '/firewall/dashboard' });
  });
});
