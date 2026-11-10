"""netops-pa 進入點:python -m netops_pa

單一程序(PA-LIVE-PLAN §2):寫入執行緒(Redis)、輪詢執行緒(PA_POLL_ENABLED)、HTTP 與 Syslog 接收(PA_RECEIVE_ENABLED)。
`python -m netops_pa health`:容器健康檢查(主迴圈 30 秒內有更新存活檔)。
`python -m netops_pa check`:第一次接 PA-560 時的連線檢查(check.py)。
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import threading
import time

from . import __version__
from .config import ConfigError, load_config
from .control import Control
from .pipeline import Pipeline
from .poller import Poller, SdkClient
from .receiver_http import HttpReceiver
from .receiver_syslog import SyslogReceiver
from .servers import tls_context
from .status import Status, register_secret
from .store import RedisStore, connect

# 容器內 /tmp 是 tmpfs、只有本服務使用者(Dockerfile)
ALIVE_FILE = os.environ.get("PA_ALIVE_FILE", "/tmp/netops-pa-alive")  # noqa: S108
ALIVE_MAX_AGE = 30

log = logging.getLogger("netops_pa")


def quiet_sdk_logs() -> None:
    """SDK 與 HTTP 函式庫的除錯日誌可能含請求內容(key=),一律只留 WARNING 以上(main 與 check 都呼叫)。"""
    for noisy in ("panos", "pan", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def health() -> int:
    try:
        return 0 if time.time() - os.path.getmtime(ALIVE_FILE) < ALIVE_MAX_AGE else 1
    except OSError:
        return 1


def main() -> int:
    logging.basicConfig(format="%(asctime)s %(levelname)s %(name)s %(message)s", level=logging.INFO, stream=sys.stdout)
    try:
        cfg = load_config()
    except ConfigError as e:
        log.error("設定錯誤:%s", e)
        return 2
    logging.getLogger().setLevel(cfg.log_level)
    quiet_sdk_logs()

    # 機密值登記到遮罩清單:不論以什麼格式出現在錯誤訊息都會被取代
    if cfg.poll:
        register_secret(cfg.poll.api_key)
    if cfg.receive:
        register_secret(cfg.receive.token)
    tls_on = bool(cfg.receive and cfg.receive.tls_cert)
    status = Status(__version__, cfg.gw_env, cfg.poll is not None, cfg.receive is not None, receiveTls="1" if tls_on else "0")
    store = RedisStore(connect(cfg.redis_url), cfg.top_n)
    # 測試區手動開關:只有 test(與本機 dev)讀,正式區不讀(control.py;allowlist)
    control = Control(store.read_control, enabled=cfg.gw_env in ("dev", "test"))
    # 啟動時先讀一次:接收端點開 port 前就套用暫停狀態
    control.refresh()
    pipeline = Pipeline(store, status, cfg.queue_size, cfg.receive.max_rate if cfg.receive else 1000, control)
    pipeline.start()

    poller = None
    if cfg.poll:
        poller = Poller(SdkClient(cfg.poll), store.write_snapshot, status, cfg.poll.interval, control.poll_paused)
        poller.start()
        log.info("SDK 輪詢已啟用:每 %d 秒(PA %s:%d)", cfg.poll.interval, cfg.poll.host, cfg.poll.port)
    else:
        log.info("SDK 輪詢未啟用(PA_POLL_ENABLED)")

    servers = []
    if cfg.receive:
        rc = cfg.receive
        tls = tls_context(rc.tls_cert, rc.tls_key, rc.tls_client_ca)
        common = {"allowed": rc.allowed, "max_connections": rc.max_connections, "tls": tls, "status": status}
        servers.append(HttpReceiver((rc.bind, rc.http_port), token=rc.token, pipeline=pipeline, max_body=rc.max_http_body, **common))
        servers.append(SyslogReceiver((rc.bind, rc.syslog_port), pipeline=pipeline, max_message=rc.max_syslog_message, **common))
        for s in servers:
            s.start()
        log.info("接收端點已啟用:HTTP%s :%d、Syslog%s :%d;允許來源 %s", "S" if tls else "", rc.http_port,
                 " TLS" if tls else "", rc.syslog_port, ",".join(map(str, rc.allowed)))
    else:
        log.info("接收端點未啟用(PA_RECEIVE_ENABLED)")

    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    exit_code = 0
    workers = [pipeline.alive, *(x.alive for x in servers), *([poller.alive] if poller else [])]
    while not stop.is_set():
        # 任一工作執行緒結束就結束程序(結束碼 1),由 Compose restart: unless-stopped 重啟
        # (Docker Engine 不會自動重啟 unhealthy 的容器,所以不能只靠健康檢查)
        if not all(alive() for alive in workers):
            log.error("工作執行緒已結束,程序結束等待重啟")
            exit_code = 1
            break
        try:
            with open(ALIVE_FILE, "w") as f:
                f.write(str(int(time.time())))
        except OSError:
            pass
        stop.wait(5)

    log.info("結束中:停止接收、寫完佇列")
    for s in servers:
        s.shutdown()
        s.server_close()
    # 已建立的連線還在處理最後一批:稍等再停寫入執行緒
    time.sleep(1)
    if poller:
        poller.stop()
    pipeline.stop()
    return exit_code


if __name__ == "__main__":
    if sys.argv[1:] == ["health"]:
        sys.exit(health())
    if sys.argv[1:] == ["check"]:
        # 連線檢查(check.py):只跑一次唯讀查詢,不寫 Redis
        from .check import run

        quiet_sdk_logs()
        sys.exit(run())
    sys.exit(main())
