/**
 * 向量庫與 embedding 用戶端(由舊版 server/lib/vector.js 搬移,IMPL-PLAN A1、PA-LIVE-PLAN §6)
 *   Qdrant(QDRANT_URL、QDRANT_COLLECTION,沿用舊版 10.10.130.46:6333 的 NetOpsKb;API Key 用 QDRANT_API_KEY_FILE)
 *   embedding(EMBED_URL,AI 主機 :8081 Qwen3-Embedding-8B,4096 維,與舊版相同)
 * 主機位址只從設定讀(AGENT.md §7.4)。請求格式、逾時與截斷長度同舊版;錯誤原文放 cause(只寫日誌)。
 */
export interface VectorConfig {
  /** 空字串 = 不使用向量庫(語意搜尋回空、問答改用關鍵字 / IP 比對,同舊版) */
  url: string;
  apiKey: string;
  collection: string;
  embedUrl: string;
}

export class VectorError extends Error {}

export type Qdrant = ReturnType<typeof createQdrant>;
export type Embedder = ReturnType<typeof createEmbedder>;

export function createQdrant(cfg: VectorConfig, fetchImpl: typeof fetch = fetch) {
  /** collection 底下的 API;回傳 result */
  async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.url}/collections/${encodeURIComponent(cfg.collection)}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { 'api-key': cfg.apiKey } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new VectorError('無法連線向量庫', { cause: err });
    }
    if (!res.ok) throw new VectorError(`向量庫回應 ${res.status}`, { cause: new Error((await res.text().catch(() => '')).slice(0, 200)) });
    return ((await res.json()) as { result: T }).result;
  }
  return { enabled: Boolean(cfg.url), collection: cfg.collection, request };
}

export function createEmbedder(cfg: Pick<VectorConfig, 'embedUrl'>, fetchImpl: typeof fetch = fetch) {
  /** 文字 → 向量(Qwen3-Embedding 的 context 2048 token,太長的截斷;同舊版) */
  async function embed(text: string): Promise<number[]> {
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.embedUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: String(text).slice(0, 1500) }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new VectorError('無法連線 embedding 服務', { cause: err });
    }
    if (!res.ok) throw new VectorError(`Embedding 服務回應 ${res.status}`, { cause: new Error((await res.text().catch(() => '')).slice(0, 200)) });
    const v = ((await res.json()) as { data?: { embedding?: unknown }[] }).data?.[0]?.embedding;
    if (!Array.isArray(v)) throw new VectorError('Embedding 服務沒有回傳向量');
    return v as number[];
  }
  return { embed };
}
