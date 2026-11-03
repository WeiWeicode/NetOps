import { describe, expect, it } from 'vitest';
import { splitList } from '@/api/kb';

describe('splitList', () => {
  it('逗號、全形逗號、頓號、換行分隔,去空白與重複', () => {
    expect(splitList(' 10.0.0.1, 10.0.0.2、10.0.0.1\n10.0.0.0/24 ，10.0.0.3')).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.0/24', '10.0.0.3']);
    expect(splitList('')).toEqual([]);
  });
});
