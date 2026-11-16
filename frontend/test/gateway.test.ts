/**
 * describeError:Gateway 路由未發佈(404 ROUTE_NOT_FOUND)顯示「功能尚未啟用」(2026-11-09 驗收 §4.4)
 */
import { describe, expect, it } from 'vitest';
import { ApiError, describeError } from '@/api/gateway';

describe('describeError', () => {
  it('ROUTE_NOT_FOUND → 功能尚未啟用(路由未發佈),附 requestId', () => {
    const msg = describeError(new ApiError(404, 'ROUTE_NOT_FOUND', '找不到此 API', 'f5cf4458e5d332a32d5e7f3082500101'));
    expect(msg).toBe('功能尚未啟用(路由未發佈)(requestId f5cf4458e5d3)');
  });
  it('其他錯誤照後端訊息', () => {
    expect(describeError(new ApiError(404, 'NETOPS_NOT_FOUND', '找不到此 API', null))).toBe('找不到此 API');
  });
});
