/**
 * netops-ad-receiver 設定(AD-1;deploy/docker-compose.yml 的 netops-ad-receiver)。缺少必要設定時啟動失敗,不加預設值繞過(AGENT.md §6)。
 *   GW_ENV                 dev / test / prod
 *   REDIS_URL              redis://netops-redis:6379/0
 *   AD_AGENT_TOKENS_FILE   DC Token 對應表(Docker secret ad_agent_tokens;deploy/host2-set-ad-secrets.sh 產生,只含 Token 雜湊)
 *   RELEASE_SHA            寫進日誌(哪一版在跑)
 * 埠號固定 51295(Gateway BACKEND-GUIDE §3.3 登記,Gateway !34);Compose 只發佈在 127.0.0.1,主機以 portproxy 轉入、
 * Windows 防火牆列 DC IP(審查 H3;不做 AD_ALLOWED_SOURCES:容器看到的來源是 Docker 閘道,不是 DC IP)。
 */
import { readFileSync } from 'node:fs';
import { parseTokenTable, TokenFileError, type TokenTable } from './tokens.js';

export const AD_RECEIVER_PORT = 51295;

export interface AdReceiverConfig {
  gwEnv: 'dev' | 'test' | 'prod';
  redisUrl: string;
  tokens: TokenTable;
  release: string;
}

export class AdReceiverConfigError extends Error {}

const str = (env: NodeJS.ProcessEnv, k: string) => (env[k] ?? '').trim();

export function loadAdReceiverConfig(env: NodeJS.ProcessEnv = process.env): AdReceiverConfig {
  const gwEnv = str(env, 'GW_ENV');
  if (gwEnv !== 'dev' && gwEnv !== 'test' && gwEnv !== 'prod') throw new AdReceiverConfigError(`GW_ENV 只能是 dev / test / prod:${gwEnv || '(未設定)'}`);
  const redisUrl = str(env, 'REDIS_URL');
  if (!/^rediss?:\/\//.test(redisUrl)) throw new AdReceiverConfigError('REDIS_URL 必須設定,且以 redis:// 或 rediss:// 開頭');
  // 對應表只接受檔案(Docker secret),沒有明文環境變數的寫法
  if (str(env, 'AD_AGENT_TOKENS')) throw new AdReceiverConfigError('不可用 AD_AGENT_TOKENS 明文設定,請改用 AD_AGENT_TOKENS_FILE(Docker secret)');
  const file = str(env, 'AD_AGENT_TOKENS_FILE');
  if (!file) throw new AdReceiverConfigError('缺少 AD_AGENT_TOKENS_FILE');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new AdReceiverConfigError(`無法讀取 AD_AGENT_TOKENS_FILE:${(e as NodeJS.ErrnoException).code ?? 'ERROR'}`);
  }
  let tokens: TokenTable;
  try {
    tokens = parseTokenTable(text);
  } catch (e) {
    throw new AdReceiverConfigError(e instanceof TokenFileError ? e.message : 'DC Token 對應表無法解析');
  }
  return { gwEnv, redisUrl, tokens, release: str(env, 'RELEASE_SHA').slice(0, 40) || 'dev' };
}
