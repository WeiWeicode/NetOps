import { describe, expect, it } from 'vitest';
import { DENIED_URL, hasCurrentApp, resolveApps } from '../src/composables/apps';

const portal = { code: 'portal', name: '員工入口網', basePath: '/', icon: 'home' };
const netops = { code: 'netops', name: '資訊網通管理系統', basePath: '/netops/', icon: 'shield' };

// FRONTEND-GUIDE §7.4 應用層守衛
describe('應用層守衛', () => {
  it('me.apps 有本系統時可進入', () => {
    const r = resolveApps({ apps: [portal, netops], permissions: [] });
    expect(hasCurrentApp(r)).toBe(true);
    expect(r.derived).toBe(false);
  });

  it('gw.app 尚未登記時,以 netops.app.access 暫時推導並標示', () => {
    const r = resolveApps({ apps: [portal], permissions: ['netops.app.access'] });
    expect(hasCurrentApp(r)).toBe(true);
    expect(r.derived).toBe(true);
    expect(r.apps.map((a) => a.basePath)).toEqual(['/', '/netops/']);
  });

  it('沒有應用權限時導回入口網並帶提示參數', () => {
    expect(hasCurrentApp(resolveApps({ apps: [portal], permissions: ['portal.app.access'] }))).toBe(false);
    expect(hasCurrentApp(resolveApps({ permissions: [] }))).toBe(false);
    expect(hasCurrentApp(resolveApps(null))).toBe(false);
    expect(DENIED_URL).toBe('/?denied=netops');
  });
});
