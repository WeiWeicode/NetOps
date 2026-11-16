"""SDK 輪詢 PA-560(PA-LIVE-PLAN §3.1;ARCHITECTURE D22 第一版只讀)。

只執行下列 operational 查詢,本程式沒有任何寫入防火牆的呼叫(設定、commit、封鎖都不做;R2 才規劃):
  show session info                                  Session 數與使用率、整體流量(kbps / pps / cps)
  show system resources                              管理平面 CPU / 記憶體(top 文字輸出)
  show running resource-monitor second last "1"      資料平面 CPU
  show counter interface "all"                       介面位元組計數(兩次輪詢相減算流量)
指令字串經 pan-os-python cmd_xml 轉成 XML:沒加引號的字會變成元素(all → <all/>),加引號才是值。
PAN-OS 的 interface 要的是值(<interface>all</interface>),寫成 all 會回「needs to have non NULL value」
(2026-11-09 PA-560 PAN-OS 12.1.7-h3 實測);second last "1" 同理。
PAN-OS 版本不同時 XML 結構略有差異:解析一律找元素名稱、找不到就略過,不依固定路徑。
單一指令失敗不影響其他指令;該指標的快照 60 秒後過期,畫面顯示該項停止更新。
"""

from __future__ import annotations

import logging
import re
import ssl
import threading
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable
from typing import Any, Protocol

from .config import PollConfig
from .status import Status, iso, mask

log = logging.getLogger("netops_pa.poller")

# 只讀指令白名單:op() 只接受這些字串,避免日後誤加寫入指令
READ_ONLY_COMMANDS = {
    "session": "show session info",
    "system": "show system resources",
    "dataplane": 'show running resource-monitor second last "1"',
    "interfaces": 'show counter interface "all"',
}
# 連線檢查(check.py)另外用的唯讀指令;不在輪詢裡執行
CHECK_COMMANDS = {"info": "show system info"}
MAX_INTERFACES = 64


class PaClient(Protocol):
    def op(self, cmd: str) -> ET.Element: ...


class SdkClient:
    """pan-os-python 的 Firewall,只開放唯讀 op。

    pan-os-python 預設不驗證 PA 的 HTTPS 憑證(pan.xapi 用 _create_unverified_context),這裡一律自己給
    ssl_context:預設驗證(系統 CA 或 PA_CA_FILE);PA_TLS_INSECURE=1 只允許 dev / test(config.py 擋正式區)。
    """

    def __init__(self, cfg: PollConfig, *, use_http: bool = False) -> None:
        from panos.base import PanDevice
        from panos.firewall import Firewall

        self._fw = Firewall(cfg.host, api_key=cfg.api_key, port=cfg.port)
        self._fw.timeout = cfg.timeout
        if cfg.tls_insecure:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        else:
            ctx = ssl.create_default_context(cafile=cfg.ca_file or None)
        fw = self._fw

        def generate_xapi() -> Any:
            # use_http 只給測試用的假 PA(tests/fake_pa.py);正式程式碼路徑一律 HTTPS
            return PanDevice.XapiWrapper(
                api_key=fw.api_key, hostname=fw.hostname, port=fw.port, timeout=fw.timeout,
                pan_device=fw, ssl_context=None if use_http else ctx, use_http=use_http,
            )

        fw.generate_xapi = generate_xapi  # type: ignore[method-assign]

    def op(self, cmd: str) -> ET.Element:
        if cmd not in READ_ONLY_COMMANDS.values() and cmd not in CHECK_COMMANDS.values():
            raise ValueError("不在唯讀指令白名單內")
        return self._fw.op(cmd, xml=False, cmd_xml=True)


# ---------- 解析(純函式) ----------
def _int(el: ET.Element | None, name: str) -> int | None:
    if el is None:
        return None
    found = el.find(f".//{name}")
    if found is None or found.text is None:
        return None
    s = found.text.strip()
    return int(s) if s.isdigit() else None


def parse_session(root: ET.Element) -> dict[str, Any]:
    active, maximum = _int(root, "num-active"), _int(root, "num-max")
    return {
        "active": active,
        "max": maximum,
        "utilization": round(active * 100 / maximum, 1) if active is not None and maximum else None,
        "tcp": _int(root, "num-tcp"),
        "udp": _int(root, "num-udp"),
        "icmp": _int(root, "num-icmp"),
    }


def parse_throughput(root: ET.Element) -> dict[str, Any]:
    kbps = _int(root, "kbps")
    return {"bps": kbps * 1000 if kbps is not None else None, "pps": _int(root, "pps"), "cps": _int(root, "cps")}


_CPU_IDLE = re.compile(r"%?Cpu\(s\):.*?([\d.]+)\s*id", re.I)
_MEM = re.compile(r"(KiB|MiB|GiB)\s+Mem\s*:\s*([\d.]+)\s*total.*?([\d.]+)\s*free.*?([\d.]+)\s*used", re.I)
_UNIT = {"kib": 1024, "mib": 1024**2, "gib": 1024**3}


def parse_system(root: ET.Element) -> dict[str, Any]:
    """show system resources 回傳 top 的文字輸出(在 <result> 內)。"""
    text = "".join(root.itertext())
    out: dict[str, Any] = {"mgmt": None, "memUsed": None, "memTotal": None}
    m = _CPU_IDLE.search(text)
    if m:
        out["mgmt"] = round(max(0.0, 100.0 - float(m.group(1))), 1)
    m = _MEM.search(text)
    if m:
        unit = _UNIT[m.group(1).lower()]
        out["memTotal"] = int(float(m.group(2)) * unit)
        out["memUsed"] = int(float(m.group(4)) * unit)
    return out


def parse_dataplane(root: ET.Element) -> float | None:
    """所有 dp 的 cpu-load-average 各核心平均(%);value 可能是逗號分隔,取第一個(最新一秒)。"""
    vals = []
    for avg in root.iter("cpu-load-average"):
        for entry in avg.iter("entry"):
            v = entry.findtext("value")
            if v:
                first = v.split(",")[0].strip()
                if first.isdigit():
                    vals.append(int(first))
    return round(sum(vals) / len(vals), 1) if vals else None


def parse_counters(root: ET.Element) -> dict[str, tuple[int, int]]:
    """介面名稱 → (ibytes, obytes)。只取有名稱與位元組計數的 entry(hw 區段等其他 entry 略過)。"""
    out: dict[str, tuple[int, int]] = {}
    for entry in root.iter("entry"):
        name = (entry.findtext("name") or "").strip()
        ib, ob = entry.findtext("ibytes"), entry.findtext("obytes")
        if not name or ib is None or ob is None or name in out:
            continue
        ib, ob = ib.strip(), ob.strip()
        if ib.isdigit() and ob.isdigit():
            out[name[:64]] = (int(ib), int(ob))
        if len(out) >= MAX_INTERFACES:
            break
    return out


def interface_rates(prev: dict[str, tuple[int, int]] | None, cur: dict[str, tuple[int, int]], seconds: float) -> list[dict[str, Any]]:
    """兩次計數相減 → 每個介面 bps;第一次輪詢、計數歸零(重開機)時該介面為 None。"""
    rows = []
    for name, (ib, ob) in sorted(cur.items()):
        rx = tx = None
        if prev and name in prev and seconds > 0:
            pib, pob = prev[name]
            if ib >= pib and ob >= pob:
                rx, tx = int((ib - pib) * 8 / seconds), int((ob - pob) * 8 / seconds)
        rows.append({"name": name, "rxBps": rx, "txBps": tx})
    return rows


# ---------- 輪詢 ----------
class Poller:
    def __init__(
        self,
        client: PaClient,
        write: Callable[[str, dict[str, Any], float], None],
        status: Status,
        interval: int,
        paused: Callable[[], bool] | None = None,
    ) -> None:
        self.client = client
        # 測試區手動開關(control.py):每次輪詢前呼叫,True 時這一輪不查 PA-560
        self.paused = paused
        self.write = write
        self.status = status
        self.interval = interval
        self._prev: tuple[float, dict[str, tuple[int, int]]] | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="pa-poller", daemon=True)

    def alive(self) -> bool:
        return self._thread.is_alive()

    def poll_once(self) -> list[str]:
        """執行一輪;回傳失敗的項目名稱(空 = 全部成功)。"""
        now = time.time()
        stamp = iso(now)
        failed: list[str] = []
        errors: list[str] = []

        def run(name: str) -> ET.Element | None:
            try:
                return self.client.op(READ_ONLY_COMMANDS[name])
            except Exception as e:  # noqa: BLE001 — 連不到、Key 失效、版本不支援都只影響這一項
                failed.append(name)
                errors.append(f"{name}: {mask(str(e) or type(e).__name__)}")
                return None

        def save(metric: str, data: dict[str, Any]) -> None:
            try:
                self.write(metric, {"time": stamp, **data}, now)
                self.status.ok("redis")
            except Exception as e:  # noqa: BLE001
                failed.append(metric)
                errors.append(f"redis: {type(e).__name__}")
                self.status.fail("redis", e)

        sess = run("session")
        if sess is not None:
            save("session", parse_session(sess))
            save("throughput", parse_throughput(sess))
        sysr, dp = run("system"), run("dataplane")
        if sysr is not None or dp is not None:
            cpu = parse_system(sysr) if sysr is not None else {"mgmt": None, "memUsed": None, "memTotal": None}
            cpu["dataplane"] = parse_dataplane(dp) if dp is not None else None
            save("cpu", cpu)
        ifs = run("interfaces")
        if ifs is not None:
            cur = parse_counters(ifs)
            prev_ts, prev = self._prev if self._prev else (now, None)
            save("interfaces", {"items": interface_rates(prev, cur, now - prev_ts)})
            self._prev = (now, cur)

        if failed:
            self.status.fail("poll", "; ".join(errors))
            log.warning("PA-560 輪詢部分失敗:%s", "; ".join(errors))
        else:
            self.status.ok("poll")
        return failed

    def cycle(self) -> None:
        """輪詢執行緒的一輪:先讀測試區手動開關,暫停就不查 PA-560。"""
        if self.paused and self.paused():
            self.pause()
        else:
            self.status.set(pollPaused="0")
            self.poll_once()

    def pause(self) -> None:
        """暫停中:標示心跳、清掉前一次介面計數(繼續時第一輪介面流量為 null,不拿暫停前的計數相減)與舊的輪詢錯誤。"""
        self.status.set(pollPaused="1")
        self.status.clear("pollError", "pollErrorAt")
        self._prev = None

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(5)

    def _run(self) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self.cycle()
            except Exception as e:  # noqa: BLE001 — 輪詢執行緒不可因非預期錯誤結束
                self.status.fail("poll", e)
                # 不印堆疊:SDK 例外可能帶請求網址(含 key=),一律遮罩後只記類型與訊息
                log.error("輪詢發生非預期錯誤:%s", mask(f"{type(e).__name__}: {e}"))
            self._stop.wait(max(1.0, self.interval - (time.monotonic() - started)))
