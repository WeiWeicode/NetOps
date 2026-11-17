/**
 * 映像檔設定檢查:DB-IP GeoIP 的 SHA-256 必須是 64 位十六進位(2026-11-17 少一碼導致 pipeline #1055 建置失敗)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('backend/Dockerfile', () => {
  it('DBIP_SHA256 為 64 位十六進位,且建置時檢查長度', () => {
    const text = fs.readFileSync(path.join(here, '../../Dockerfile'), 'utf8');
    const m = /^ARG DBIP_SHA256=(\S*)$/m.exec(text);
    assert.ok(m, '找不到 ARG DBIP_SHA256');
    assert.match(m[1]!, /^[0-9a-f]{64}$/);
    assert.match(text, /test "\$\{#DBIP_SHA256\}" -eq 64/);
  });
});
