import { describe, expect, it } from 'vitest';
import { resolveStyle, resolveTheme } from '../src/composables/themeRules';

// ui/theme.feature
describe('風格切換', () => {
  const ok = { supportsBlur: true, reducedTransparency: false };

  it('預設玻璃,記住扁平偏好', () => {
    expect(resolveStyle(null, ok)).toEqual({ style: 'glass', forced: false });
    expect(resolveStyle('flat', ok)).toEqual({ style: 'flat', forced: false });
    expect(resolveStyle('bogus', ok)).toEqual({ style: 'glass', forced: false });
  });

  it('不支援模糊效果時自動扁平', () => {
    expect(resolveStyle('glass', { supportsBlur: false, reducedTransparency: false })).toEqual({ style: 'flat', forced: true });
    expect(resolveStyle(null, { supportsBlur: true, reducedTransparency: true })).toEqual({ style: 'flat', forced: true });
  });

  it('明暗未設定時依系統設定', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });
});
