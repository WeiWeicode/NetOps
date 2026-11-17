/**
 * 離線 GeoIP(戰情室 WR-1,WARROOM-PLAN §6 Q2):DB-IP「IP to Country Lite」(.mmdb,CC BY 4.0),建置映像時下載放進映像,執行時不連外。
 * 授權標示:畫面須顯示「IP Geolocation by DB-IP」並連到 https://db-ip.com(回應帶 attribution 給畫面用)。
 * 檔案不存在或讀取失敗 → available false、查詢一律 null(戰情室標示國家不可用,不影響其他資料)。
 */
import fs from 'node:fs';
import { Reader, type CountryResponse } from 'mmdb-lib';

export interface GeoCountry {
  /** ISO 3166-1 alpha-2,例 "US" */
  code: string;
  /** 英文名稱 */
  name: string;
}

export interface GeoIp {
  available: boolean;
  /** 資料庫版本(建置日期,例 "2026-11-01");無資料庫為 null */
  version: string | null;
  lookup(ip: string): GeoCountry | null;
}

export const GEOIP_ATTRIBUTION = { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' } as const;

/** 查詢快取上限(同一批外部 IP 會一直重複出現) */
const CACHE_MAX = 50_000;

export function createGeoIpFromBuffer(buf: Buffer): GeoIp {
  const reader = new Reader<CountryResponse>(buf);
  const cache = new Map<string, GeoCountry | null>();
  const built = new Date(reader.metadata.buildEpoch as unknown as string | number | Date).getTime();
  return {
    available: true,
    version: Number.isFinite(built) ? new Date(built).toISOString().slice(0, 10) : null,
    lookup(ip) {
      const hit = cache.get(ip);
      if (hit !== undefined) return hit;
      let out: GeoCountry | null = null;
      try {
        const c = reader.get(ip)?.country;
        if (c?.iso_code) out = { code: c.iso_code, name: c.names?.en ?? c.iso_code };
      } catch {
        // 不是合法 IP:視為查無
      }
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(ip, out);
      return out;
    },
  };
}

export const NO_GEOIP: GeoIp = { available: false, version: null, lookup: () => null };

/** 載入資料庫;path 為 null 或讀取失敗回 NO_GEOIP(失敗原因寫 warn,不含檔案內容) */
export function loadGeoIp(path: string | null, log?: { warn: (obj: object, msg: string) => void }): GeoIp {
  if (!path) return NO_GEOIP;
  try {
    return createGeoIpFromBuffer(fs.readFileSync(path));
  } catch (err) {
    log?.warn({ code: (err as NodeJS.ErrnoException).code ?? (err as Error).name }, 'GeoIP 資料庫無法載入,戰情室國家欄位停用');
    return NO_GEOIP;
  }
}
