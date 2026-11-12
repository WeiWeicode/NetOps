"""設定(環境變數)。規則同 backend/src/config.ts:

- 部署區只有 dev / test / prod;缺少必要設定時啟動失敗,不加預設值繞過(AGENT.md §6)。
- 機密一律讀 <NAME>_FILE(Docker secret);dev / test 可用明文 <NAME>,正式區只接受 _FILE(AGENT.md §7.5)。
- PA 位址、port、版本相關設定只從這裡讀,不寫死(PA-LIVE-PLAN §11 P1 未定)。

兩個開關(2026-11-05 需求方決定:測試區預設關閉,測試時才開):
- PA_POLL_ENABLED:只控制 SDK 輪詢 PA-560(會增加 PA-560 管理平面負擔的部分)。
- PA_RECEIVE_ENABLED:控制 HTTP(51293)與 Syslog(51294)接收端點。關閉時不開 port。
兩個都關時程序仍會執行並寫心跳(標示「未啟用」),畫面據此顯示「收集器未啟用」而不是「停止更新」。
"""

from __future__ import annotations

import ipaddress
import os
from collections.abc import Mapping
from dataclasses import dataclass

GW_ENVS = ("dev", "test", "prod")


class ConfigError(Exception):
    """設定錯誤:訊息不含機密內容。"""


def _str(env: Mapping[str, str], key: str, fallback: str = "") -> str:
    return (env.get(key) or "").strip() or fallback


def _int(env: Mapping[str, str], key: str, fallback: int, lo: int, hi: int) -> int:
    raw = _str(env, key)
    if not raw:
        return fallback
    try:
        n = int(raw)
    except ValueError:
        raise ConfigError(f"{key} 必須是 {lo}–{hi} 的整數:{raw}") from None
    if not lo <= n <= hi:
        raise ConfigError(f"{key} 必須是 {lo}–{hi} 的整數:{raw}")
    return n


def _bool(env: Mapping[str, str], key: str) -> bool:
    """只接受 1 / 0 / true / false,其他值啟動失敗(避免寫錯時悄悄改變行為)。"""
    raw = _str(env, key).lower()
    if raw in ("", "0", "false"):
        return False
    if raw in ("1", "true"):
        return True
    raise ConfigError(f"{key} 只能是 1 / 0 / true / false:{raw}")


def read_secret(env: Mapping[str, str], name: str, gw_env: str) -> str:
    """<NAME>_FILE 優先;正式區不接受明文 <NAME>(會留在容器環境變數,docker inspect 看得到)。"""
    if _str(env, name) and gw_env == "prod":
        raise ConfigError(f"正式區不可用 {name} 明文設定,請改用 {name}_FILE(Docker secret)")
    path = _str(env, f"{name}_FILE")
    if path:
        try:
            with open(path, encoding="utf-8") as f:
                return f.read().strip()
        except OSError as e:
            raise ConfigError(f"無法讀取 {name}_FILE:{type(e).__name__}") from None
    return _str(env, name)


def _file(env: Mapping[str, str], key: str) -> str:
    """檔案路徑設定(憑證等):設定了就必須存在。"""
    p = _str(env, key)
    if p and not os.path.isfile(p):
        raise ConfigError(f"{key} 指向的檔案不存在")
    return p


def _networks(raw: str) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    out = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            raise ConfigError(f"PA_ALLOWED_SOURCES 格式錯誤(要 IP 或 CIDR,逗號分隔):{part}") from None
    return tuple(out)


@dataclass(frozen=True)
class PollConfig:
    host: str
    port: int
    api_key: str
    # PA-560 管理介面憑證:預設驗證(系統 CA 或 PA_CA_FILE);PA_TLS_INSECURE=1 只允許 dev / test
    ca_file: str
    tls_insecure: bool
    interval: int
    timeout: int


@dataclass(frozen=True)
class QueryConfig:
    """PA 精準查詢(C5;PA-LOG-CLICKHOUSE-GUIDE §9、E4 結果):連線設定同輪詢,另加管理平面 CPU 門檻。"""

    host: str
    port: int
    api_key: str
    ca_file: str
    tls_insecure: bool
    # 單一 HTTP 請求逾時(秒);整個工作另有 60 秒上限(pa_query.JOB_TIMEOUT)
    timeout: int
    # 送出前取樣管理平面 CPU,超過就不送(E4:50%)
    max_mgmt_cpu: int


@dataclass(frozen=True)
class ReceiveConfig:
    bind: str
    http_port: int
    syslog_port: int
    # HTTP Server Profile 自訂標頭的 Token(docs/PA-FORWARDING-SPEC.md)
    token: str
    # 只接受這些來源(容器看到的來源位址;經 WSL portproxy 時見 docs/PA-FORWARDING-SPEC.md 主機設定)
    allowed: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]
    # 兩個接收端點共用的憑證;都設定時 HTTP 改 HTTPS、Syslog 改 TLS
    tls_cert: str
    tls_key: str
    # 設定時要求用戶端憑證(PA-560 的憑證須由此 CA 簽發;Syslog 唯一能驗證身分的方式)
    tls_client_ca: str
    max_connections: int
    # HTTP、Syslog 各自每秒最多接受幾筆(超過丟棄並計數)
    max_rate: int
    max_http_body: int
    max_syslog_message: int


@dataclass(frozen=True)
class Config:
    gw_env: str
    redis_url: str
    log_level: str
    poll: PollConfig | None
    receive: ReceiveConfig | None
    # PA 精準查詢執行者(PA_QUERY_ENABLED;測試區預設關閉,需求方手動開,D31)
    query: QueryConfig | None
    # 每分鐘排行每個維度保留前幾名(PA-LIVE-PLAN §4)
    top_n: int
    queue_size: int


def load_config(env: Mapping[str, str] | None = None) -> Config:
    env = os.environ if env is None else env
    gw_env = _str(env, "GW_ENV")
    if gw_env not in GW_ENVS:
        raise ConfigError(f"GW_ENV 必須是 {' / '.join(GW_ENVS)}:{gw_env or '(未設定)'}")
    redis_url = _str(env, "REDIS_URL")
    if not redis_url:
        raise ConfigError("缺少必要設定:REDIS_URL")
    if not redis_url.startswith(("redis://", "rediss://", "unix://")):
        raise ConfigError("REDIS_URL 必須以 redis://、rediss:// 或 unix:// 開頭")

    poll = None
    if _bool(env, "PA_POLL_ENABLED"):
        host = _str(env, "PA_HOST")
        api_key = read_secret(env, "PA_API_KEY", gw_env)
        missing = [k for k, v in (("PA_HOST", host), ("PA_API_KEY_FILE", api_key)) if not v]
        if missing:
            raise ConfigError(f"PA_POLL_ENABLED=1 缺少必要設定:{'、'.join(missing)}")
        insecure = _bool(env, "PA_TLS_INSECURE")
        if insecure and gw_env == "prod":
            raise ConfigError("正式區不可設定 PA_TLS_INSECURE")
        poll = PollConfig(
            host=host,
            port=_int(env, "PA_PORT", 443, 1, 65535),
            api_key=api_key,
            ca_file=_file(env, "PA_CA_FILE"),
            tls_insecure=insecure,
            # 正式區 10–15 秒(PA-LIVE-PLAN §3.1);下限 10 秒避免加重 PA-560 負擔
            interval=_int(env, "PA_POLL_SECONDS", 15, 10, 300),
            timeout=_int(env, "PA_TIMEOUT_SECONDS", 8, 2, 30),
        )

    query = None
    if _bool(env, "PA_QUERY_ENABLED"):
        host = _str(env, "PA_HOST")
        api_key = read_secret(env, "PA_API_KEY", gw_env)
        missing = [k for k, v in (("PA_HOST", host), ("PA_API_KEY_FILE", api_key)) if not v]
        if missing:
            raise ConfigError(f"PA_QUERY_ENABLED=1 缺少必要設定:{'、'.join(missing)}")
        insecure = _bool(env, "PA_TLS_INSECURE")
        if insecure and gw_env == "prod":
            raise ConfigError("正式區不可設定 PA_TLS_INSECURE")
        query = QueryConfig(
            host=host,
            port=_int(env, "PA_PORT", 443, 1, 65535),
            api_key=api_key,
            ca_file=_file(env, "PA_CA_FILE"),
            tls_insecure=insecure,
            timeout=_int(env, "PA_QUERY_HTTP_TIMEOUT_SECONDS", 15, 2, 30),
            # E4(2026-11-10):超過 50% 不送;實測前不放寬(上限 50)
            max_mgmt_cpu=_int(env, "PA_QUERY_MAX_MGMT_CPU", 50, 10, 50),
        )

    receive = None
    if _bool(env, "PA_RECEIVE_ENABLED"):
        token = read_secret(env, "PA_HTTP_TOKEN", gw_env)
        allowed = _networks(_str(env, "PA_ALLOWED_SOURCES"))
        missing = [k for k, v in (("PA_HTTP_TOKEN_FILE", token), ("PA_ALLOWED_SOURCES", allowed)) if not v]
        if missing:
            raise ConfigError(f"PA_RECEIVE_ENABLED=1 缺少必要設定:{'、'.join(missing)}")
        if len(token) < 32:
            raise ConfigError("PA_HTTP_TOKEN 太短(至少 32 字元;用 deploy/host*-set-pa-secrets.sh 產生)")
        if any(n.prefixlen == 0 for n in allowed):
            raise ConfigError("PA_ALLOWED_SOURCES 不可包含 0.0.0.0/0 或 ::/0")
        cert, key = _file(env, "PA_TLS_CERT_FILE"), _file(env, "PA_TLS_KEY_FILE")
        if bool(cert) != bool(key):
            raise ConfigError("PA_TLS_CERT_FILE 與 PA_TLS_KEY_FILE 要一起設定")
        client_ca = _file(env, "PA_TLS_CLIENT_CA_FILE")
        if client_ca and not cert:
            raise ConfigError("PA_TLS_CLIENT_CA_FILE 需要同時設定 PA_TLS_CERT_FILE / PA_TLS_KEY_FILE")
        # 正式區預設要求 TLS(Token 明文會被同網段側錄);PA-560 不信任內部憑證時,需求方決定後明確設 PA_RECEIVE_PLAINTEXT=1
        if gw_env == "prod" and not cert and not _bool(env, "PA_RECEIVE_PLAINTEXT"):
            raise ConfigError("正式區接收端點需要 TLS(PA_TLS_CERT_FILE / PA_TLS_KEY_FILE);確定要明文時設 PA_RECEIVE_PLAINTEXT=1")
        receive = ReceiveConfig(
            # 容器內監聽所有介面;對外只經 Compose 發佈的 port(來源再由 PA_ALLOWED_SOURCES 檢查)
            bind=_str(env, "PA_BIND", "0.0.0.0"),  # noqa: S104
            http_port=_int(env, "PA_HTTP_PORT", 51293, 1024, 65535),
            syslog_port=_int(env, "PA_SYSLOG_PORT", 51294, 1024, 65535),
            token=token,
            allowed=allowed,
            tls_cert=cert,
            tls_key=key,
            tls_client_ca=client_ca,
            max_connections=_int(env, "PA_MAX_CONNECTIONS", 16, 1, 256),
            # HTTP、Syslog 各自的上限(筆 / 秒)。TRAFFIC 平均每秒約 90–130 筆(PA-LIVE-PLAN §5),預設 2000 留尖峰空間;
            # 1 小時 × 2000 筆仍在 Stream 筆數上限(keys.LOG_MAXLEN)內
            max_rate=_int(env, "PA_MAX_RATE", 2000, 10, 20_000),
            max_http_body=_int(env, "PA_MAX_HTTP_BODY", 1024 * 1024, 4096, 16 * 1024 * 1024),
            max_syslog_message=_int(env, "PA_MAX_SYSLOG_MESSAGE", 16 * 1024, 1024, 64 * 1024),
        )

    return Config(
        gw_env=gw_env,
        redis_url=redis_url,
        log_level=_str(env, "LOG_LEVEL", "DEBUG" if gw_env == "dev" else "INFO").upper(),
        poll=poll,
        receive=receive,
        query=query,
        top_n=_int(env, "PA_TOP_N", 200, 10, 1000),
        queue_size=_int(env, "PA_QUEUE_SIZE", 50_000, 1000, 500_000),
    )
