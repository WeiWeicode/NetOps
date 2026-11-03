import { describe, expect, it } from 'vitest';
import { PICK, portCond, scanVerdict, stripNote, withApps, zoneCond } from '@/composables/paDashboard';

describe('流量總覽 → 明細查詢條件', () => {
  it('Port、區域、說明', () => {
    expect(portCond('tcp/443')).toEqual({ proto: 'tcp', port: '443' });
    expect(portCond('icmp')).toEqual({ proto: 'icmp' });
    expect(zoneCond('? → trust')).toEqual({ toZone: 'trust' });
    expect(stripNote('203.0.113.45（CN）')).toBe('203.0.113.45');
    expect(stripNote('ms-rdp(風險 4)')).toBe('ms-rdp');
  });
  it('排行點選條件同舊版', () => {
    expect(PICK.blockDport!('tcp/445')).toEqual({ proto: 'tcp', port: '445', action: 'block' });
    expect(PICK.inboundAllow!('198.51.100.20 → 10.10.20.5:tcp/443')).toEqual({
      src: '198.51.100.20',
      dst: '10.10.20.5',
      proto: 'tcp',
      port: '443',
      action: 'allow',
    });
    expect(PICK.inboundAllow!('奇怪的格式')).toEqual({ q: '奇怪的格式' });
    expect(PICK.dstCountry!('Taiwan')).toEqual({ country: 'Taiwan' });
  });
  it('IP 排行補上 App(最多 3 個,不重複)', () => {
    const r = withApps(
      [
        { key: '10.0.0.1', n: 3 },
        { key: '10.0.0.2', n: 1 },
      ],
      ['a', 'b', 'a', 'c', 'd'].map((app) => ({ key: `10.0.0.1 → ${app}`, n: 1 })),
    );
    expect(r.map((x) => x.sub)).toEqual(['a、b、c', '']);
  });
  it('掃描研判', () => {
    expect(scanVerdict({ dsts: 1, ports: 50 }).label).toBe('疑似 Port 掃描');
    expect(scanVerdict({ dsts: 100, ports: 2 }).label).toBe('疑似主機掃描');
    expect(scanVerdict({ dsts: 20, ports: 2 }).label).toBe('持續嘗試連線');
  });
});
