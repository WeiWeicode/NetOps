/**
 * 網段設定 API(SG-1,docs/SEGMENT-SETTINGS-PLAN.md §4):/v1/warroom-segments、/v1/warroom-segment-previews。
 *   讀取、預覽:netops.segment.read;寫入:netops.segment.write(兩個都只給 netops-admin,§6 Q1)
 * 只做驗證、權限宣告與格式轉換;驗證規則與版本比對在 segments.ts / warroom.ts。內容只有網段名稱與 CIDR,不含個資。
 */
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors.js';
import { looseObject } from '../../shared/schemas.js';
import type { SegmentSettingsService } from './segments.js';

/** 請求本體上限:100 個網段 × 50 個 CIDR 約 100 KB */
const BODY_LIMIT = 256 * 1024;

// schema 只檢查型別;內容(長度、格式、數量上限)全由 checkWarroomConfig 回報,欄位錯誤統一為 [{ field, message }]
const CONFIG_PROPS = {
  gauge: { type: 'object' },
  segments: { type: 'array' },
} as const;
const SETTINGS = looseObject('{ version, source, updatedAt, updatedBy, gauge, segments, overlaps, errors? }(SEGMENT-SETTINGS-PLAN §4)');

const segmentRoutes: FastifyPluginAsync<{ svc: SegmentSettingsService }> = async (app, { svc }) => {
  const author = (identity: { emp?: string; name?: string } | null) => {
    const who = [identity?.emp, identity?.name].filter(Boolean).join(' ');
    if (!who) throw new AppError(403, 'NETOPS_SEGMENTS_AUTHOR_UNKNOWN', '無法識別修改人(沒有工號與姓名),不能修改網段設定');
    return who;
  };

  app.get(
    '/v1/warroom-segments',
    {
      schema: {
        operationId: 'netops.warroom-segment.get',
        summary: '查詢網段設定',
        description:
          '戰情室右側內部網段的設定:gauge(儀表滿格值)、segments(id、label、kind vlan / service、icon、cidrs)、version(寫入時帶回)、updatedAt、updatedBy、' +
          'overlaps(不同網段之間重疊的 CIDR;允許重疊,對照時最精確的網段優先)。source:file(已設定)、example(尚未設定,回內建範例,version 0)、' +
          'invalid(設定檔被人工改壞,回範例並附 errors;仍可整份覆寫)。',
        tags: ['網段設定'],
        'x-permission': 'netops.segment.read',
        'x-gherkin': [
          '場景: 查詢網段設定',
          '  假如 使用者擁有 netops.segment.read',
          '  當 呼叫 GET /api/netops/warroom-segments',
          '  那麼 回應 200',
          '  而且 回應含 version、source、gauge、segments、overlaps',
          '',
          '場景: 尚未設定',
          '  假如 資料目錄沒有網段設定',
          '  當 呼叫 GET /api/netops/warroom-segments',
          '  那麼 source 為 "example" 且 version 為 0',
        ].join('\n'),
        response: { 200: SETTINGS },
      },
    },
    async () => svc.get(),
  );

  app.put<{ Body: { version: number } & Record<string, unknown> }>(
    '/v1/warroom-segments',
    {
      bodyLimit: BODY_LIMIT,
      schema: {
        operationId: 'netops.warroom-segment.update',
        summary: '儲存網段設定(整份)',
        description:
          '整份取代網段設定;version 必須等於目前版本(GET 取得),成功後 version + 1。版本不符(別人剛改過)回 409 NETOPS_SEGMENTS_VERSION_CONFLICT(details.currentVersion),請重新載入。' +
          '驗證失敗回 400 VALIDATION_FAILED,details 為欄位錯誤清單 [{ field, message }](CIDR 格式、id 重複或為保留字 unmatched、label 1–40 字、kind、最多 100 個網段 / 每個 50 個 CIDR)。' +
          '其他欄位(匯入檔的 source、updatedAt 等)略過。寫入前舊設定存進歷史(保留 20 份);戰情室下一次更新就套用。',
        tags: ['網段設定'],
        'x-permission': 'netops.segment.write',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 儲存網段設定',
          '  假如 使用者擁有 netops.segment.write 且目前 version 為 3',
          '  當 呼叫 PUT /api/netops/warroom-segments 帶 version 3 與 segments',
          '  那麼 回應 200 且 version 為 4',
          '  而且 戰情室下一次更新使用新網段',
          '',
          '場景: 別人剛改過',
          '  假如 目前 version 為 4',
          '  當 呼叫 PUT /api/netops/warroom-segments 帶 version 3',
          '  那麼 回應 409 NETOPS_SEGMENTS_VERSION_CONFLICT',
          '',
          '場景: CIDR 格式錯誤',
          '  當 呼叫 PUT /api/netops/warroom-segments 帶 cidrs ["10.0.0.0/40"]',
          '  那麼 回應 400 VALIDATION_FAILED',
          '  而且 details 有 field "segments[0].cidrs[0]"',
        ].join('\n'),
        body: { type: 'object', required: ['version', 'segments'], properties: { version: { type: 'integer', minimum: 0 }, ...CONFIG_PROPS } },
        response: { 200: SETTINGS },
      },
    },
    async (req) => svc.save(req.body, author(req.identity)),
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/v1/warroom-segment-previews',
    {
      bodyLimit: BODY_LIMIT,
      schema: {
        operationId: 'netops.warroom-segment.preview',
        summary: '預覽網段設定(不儲存)',
        description:
          '用尚未儲存的設定(格式同 PUT,version 可省略)把近 5 分鐘 TRAFFIC 明細的內部 IP 分到網段:segments(id、label、conn 近 5 分鐘連線數)、' +
          'unmatched(conn 與 top:未分類內部 IP 前 20 名 { ip, count })、overlaps。一次最多讀 20000 筆明細,讀不到 5 分鐘開頭時依涵蓋秒數換算(sample.complete false)。' +
          '不寫入。驗證失敗回 400 VALIDATION_FAILED(同 PUT);Redis 不可用時回 200、partial true、conn 為 null 並附 message,不回假資料。',
        tags: ['網段設定'],
        'x-permission': 'netops.segment.read',
        // 回應含未分類內部 IP 與連線數(流量統計),比照 Log 明細記稽核
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 儲存前預覽',
          '  假如 近 5 分鐘有連到 10.10.130.5 的連線',
          '  當 呼叫 POST /api/netops/warroom-segment-previews 帶含 10.10.130.0/24 的網段',
          '  那麼 回應 200 且該網段 conn 大於 0',
          '  而且 網段設定沒有改變',
          '',
          '場景: Redis 連不上',
          '  假如 netops-redis 停止',
          '  當 呼叫 POST /api/netops/warroom-segment-previews',
          '  那麼 回應 200 且 partial 為 true',
        ].join('\n'),
        body: { type: 'object', required: ['segments'], properties: CONFIG_PROPS },
        response: { 200: looseObject('{ generatedAt, minutes, partial, segments, unmatched, overlaps, sample, message? }') },
      },
    },
    async (req) => svc.preview(req.body),
  );
};

export default segmentRoutes;
