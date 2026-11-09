"""連線檢查(第一次接真的 PA-560 用):python -m netops_pa check

在容器內執行一次唯讀查詢並印出結果,不寫 Redis、不需要打開 PA_POLL_ENABLED:
  docker compose ... exec netops-pa python -m netops_pa check
讀同一份設定(PA_HOST、PA_PORT、PA_API_KEY_FILE、PA_CA_FILE、PA_TLS_INSECURE);API Key 不印出,錯誤訊息經遮罩。
印出 PAN-OS 版本(show system info)與 4 個輪詢指令各自的結果,失敗時給可能原因(憑證、權限、網路、版本)。
結束碼:0 全部成功、1 有失敗、2 設定錯誤。
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable

from .config import ConfigError, PollConfig, _bool, _file, _int, _str, read_secret
from .poller import READ_ONLY_COMMANDS, SdkClient, parse_counters, parse_dataplane, parse_session, parse_system, parse_throughput
from .status import mask, register_secret

# 只用在檢查:唯讀
SYSTEM_INFO = "show system info"

HINTS: list[tuple[tuple[str, ...], str]] = [
    (("certificate verify failed", "hostname", "ip address mismatch", "doesn't match"),
     "憑證驗證失敗:PA_HOST 要和憑證的 SAN 相同(IP 要在 SAN 的 IP 欄位),或設 PA_CA_FILE 指向簽發的 CA;測試區可暫設 PA_TLS_INSECURE=1"),
    (("403", "invalid credential", "unauthorized"), "API Key 無效、過期或角色沒有 XML API Operational Requests 權限"),
    (("timed out", "timeout"), "連線逾時:網路未放行,或管理介面 Permitted IP Addresses 沒有加入本主機"),
    (("refused", "unreachable", "no route", "name or service", "getaddrinfo", "errno"), "連不到 PA-560:確認 PA_HOST、PA_PORT 與網路放行"),
    (("invalid syntax", "not supported", "unknown command"), "設備不支援此查詢(PAN-OS 版本差異),請回報版本"),
]


def hint(msg: str) -> str:
    low = msg.lower()
    for keys, text in HINTS:
        if any(k in low for k in keys):
            return text
    return "請把上面的訊息(已遮罩)回報給系統負責人"


def load_poll(env: dict[str, str]) -> PollConfig:
    """同 config.load_config 的輪詢設定,但不要求 PA_POLL_ENABLED=1。"""
    gw_env = _str(env, "GW_ENV")
    host = _str(env, "PA_HOST")
    key = read_secret(env, "PA_API_KEY", gw_env)
    missing = [k for k, v in (("PA_HOST", host), ("PA_API_KEY_FILE", key)) if not v]
    if missing:
        raise ConfigError(f"缺少必要設定:{'、'.join(missing)}")
    insecure = _bool(env, "PA_TLS_INSECURE")
    if insecure and gw_env == "prod":
        raise ConfigError("正式區不可設定 PA_TLS_INSECURE")
    return PollConfig(host=host, port=_int(env, "PA_PORT", 443, 1, 65535), api_key=key, ca_file=_file(env, "PA_CA_FILE"),
                      tls_insecure=insecure, interval=15, timeout=_int(env, "PA_TIMEOUT_SECONDS", 8, 2, 30))


def run(env: dict[str, str] | None = None, out: Callable[[str], None] = print, client: SdkClient | None = None) -> int:
    env = dict(os.environ) if env is None else env
    try:
        cfg = load_poll(env)
    except ConfigError as e:
        out(f"設定錯誤:{e}")
        return 2
    register_secret(cfg.api_key)
    tls = "不驗證憑證(PA_TLS_INSECURE=1,只限測試區)" if cfg.tls_insecure else f"驗證憑證({'PA_CA_FILE' if cfg.ca_file else '系統 CA'})"
    out(f"PA-560 {cfg.host}:{cfg.port},{tls},逾時 {cfg.timeout} 秒")
    c = client or SdkClient(cfg)
    failed = 0
    parsers = {
        "session": lambda r: {**parse_session(r), **parse_throughput(r)},
        "system": parse_system,
        "dataplane": lambda r: {"dataplane": parse_dataplane(r)},
        "interfaces": lambda r: {"interfaces": len(parse_counters(r))},
    }
    for name, cmd in [("info", SYSTEM_INFO), *READ_ONLY_COMMANDS.items()]:
        try:
            # system info 不在輪詢白名單,直接用 SDK(同樣是 show 指令)
            root = c._fw.op(cmd, xml=False, cmd_xml=True) if name == "info" else c.op(cmd)
        except Exception as e:  # noqa: BLE001 — 每一項分開回報
            failed += 1
            msg = mask(f"{type(e).__name__}: {e}")
            out(f"✗ {cmd}\n    {msg}\n    可能原因:{hint(msg)}")
            continue
        if name == "info":
            fields = {k: (root.findtext(f".//{k}") or "") for k in ("model", "sw-version", "hostname", "serial")}
            # 序號只印後 4 碼
            fields["serial"] = ("…" + fields["serial"][-4:]) if fields["serial"] else ""
            out(f"✓ {cmd}:" + "、".join(f"{k}={v}" for k, v in fields.items() if v))
        else:
            out(f"✓ {cmd}:{parsers[name](root)}")
    out("結果:全部成功" if not failed else f"結果:{failed} 項失敗")
    return 1 if failed else 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(run())

