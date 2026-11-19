"""TS-0 唯讀實測:PA-560 本機特徵庫能不能用 op 指令讀(docs/THREAT-SIGNATURE-PLAN.md §2)。

在測試區(主機 2)netops-pa 容器執行(需求方同意後);容器 rootfs 唯讀,不能 docker cp,用標準輸入送進容器。
在開發機 NetOps 目錄的 PowerShell 執行(PowerShell 不支援 <,交給 cmd /c;部署 pipeline 執行中 WSL 會逾時,等部署完再跑;
完整說明見 docs/THREAT-SIGNATURE-PLAN.md §2.2):
    cmd /c "ssh host2 ""wsl -u root -e docker exec -i giganexus-netops-test-netops-pa-1 python -"" < scripts\\ts0_probe.py > ts0-result.json"
    App 清單:把 python - 改成 python - --only application,輸出改 ts0-app.json
步驟名稱:system-info、vulnerability、phone-home、profile-group-vsys、profile-group-shared、vp-profiles-vsys、
as-profiles-vsys、vp-profiles-shared、as-profiles-shared、application、single(單筆查詢,需同時列 vulnerability)

只送下列唯讀 op 指令(白名單完全比對;單筆查詢用固定格式 + 純數字 ID):
    show system resources                                     管理平面 CPU(每一步前後各取一次)
    show system info                                          內容版本(threat / app / av / wildfire)與發布日
    show predefined xpath /predefined/threats/vulnerability   弱點特徵清單
    show predefined xpath /predefined/threats/phone-home      間諜軟體特徵清單
    show predefined xpath /predefined/threats/vulnerability/entry[@name='<ID>']  單筆(ID 取自上一步第一筆)
    show threat id <ID>                                       單筆說明(CLI 指令,是否支援待實測)
    show config running xpath <vsys1 | shared>/profile-group、profiles/vulnerability、profiles/spyware
    show predefined xpath /predefined/application             App 清單(--only application 才送)
不送 type=config、不 Commit、不寫檔到 PA;不輸出 API Key、不輸出特徵碼內容(只輸出筆數、欄位名稱與分布)。
管理平面 CPU 讀不到或超過 50% 時整個停止。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from typing import Any

MAX_CPU = 50.0
CHUNK = 1024 * 1024

CPU_CMD = "<show><system><resources></resources></system></show>"
INFO_CMD = "<show><system><info></info></system></show>"
VSYS = "devices/entry[@name='localhost.localdomain']/vsys/entry[@name='vsys1']"


def predefined(xpath: str) -> str:
    return f"<show><predefined><xpath>{xpath}</xpath></predefined></show>"


def running(xpath: str) -> str:
    return f"<show><config><running><xpath>{xpath}</xpath></running></config></show>"


# (步驟名稱, 指令, 是否預設執行)
STEPS: list[tuple[str, str, bool]] = [
    ("system-info", INFO_CMD, True),
    ("vulnerability", predefined("/predefined/threats/vulnerability"), True),
    ("phone-home", predefined("/predefined/threats/phone-home"), True),
    ("profile-group-vsys", running(f"{VSYS}/profile-group"), True),
    ("profile-group-shared", running("shared/profile-group"), True),
    ("vp-profiles-vsys", running(f"{VSYS}/profiles/vulnerability"), True),
    ("as-profiles-vsys", running(f"{VSYS}/profiles/spyware"), True),
    ("vp-profiles-shared", running("shared/profiles/vulnerability"), True),
    ("as-profiles-shared", running("shared/profiles/spyware"), True),
    ("application", predefined("/predefined/application"), False),
]
ALLOWED = frozenset({CPU_CMD, *(c for _, c, _ in STEPS)})
# 單筆查詢:ID 只能是數字(上限 10 位)
SINGLE_ENTRY = re.compile(r"^<show><predefined><xpath>/predefined/threats/vulnerability/entry\[@name='\d{1,10}'\]</xpath></predefined></show>$")
SHOW_THREAT = re.compile(r"^<show><threat><id>\d{1,10}</id></threat></show>$")

_CPU_IDLE = re.compile(r"%Cpu\(s\):.*?([\d.]+)\s*id")
INFO_FIELDS = (
    "sw-version", "model", "threat-version", "threat-release-date", "app-version", "app-release-date",
    "av-version", "av-release-date", "wildfire-version", "wildfire-release-date", "url-filtering-version",
)


class Probe:
    def __init__(self, cap_mb: int, timeout: float) -> None:
        host = os.environ.get("PA_HOST", "").strip()
        if not host:
            sys.exit("缺少 PA_HOST(請在 netops-pa 容器內執行)")
        port = os.environ.get("PA_PORT", "443").strip() or "443"
        self.url = f"https://{host}:{port}/api/"
        self.key = self._key()
        self.cap = cap_mb * 1024 * 1024
        self.timeout = timeout
        if os.environ.get("PA_TLS_INSECURE", "").strip().lower() in ("1", "true", "yes"):
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        else:
            ctx = ssl.create_default_context(cafile=os.environ.get("PA_CA_FILE") or None)

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a: Any, **k: Any) -> None:  # noqa: ARG002 — 不跟隨轉址(避免把 Key 帶走)
                return None

        self._open = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ctx)).open

    @staticmethod
    def _key() -> str:
        # 同收集器:PA_POLICY_API_KEY_FILE → PA_API_KEY_FILE → PA_API_KEY(dev / test)
        for name in ("PA_POLICY_API_KEY_FILE", "PA_API_KEY_FILE"):
            path = os.environ.get(name, "").strip()
            if path:
                try:
                    with open(path, encoding="utf-8") as f:
                        v = f.read().strip()
                except OSError as e:
                    sys.exit(f"無法讀取 {name}:{type(e).__name__}")
                if v:
                    return v
        v = os.environ.get("PA_API_KEY", "").strip()
        if not v:
            sys.exit("找不到 API Key(PA_POLICY_API_KEY_FILE / PA_API_KEY_FILE)")
        return v

    def op(self, cmd: str) -> tuple[ET.Element | None, dict[str, Any]]:
        """送唯讀 op;回傳 (XML 根節點或 None, 量測)。不回傳原文。"""
        if cmd not in ALLOWED and not SINGLE_ENTRY.match(cmd) and not SHOW_THREAT.match(cmd):
            raise ValueError("不在唯讀指令白名單內")
        body = urllib.parse.urlencode({"type": "op", "cmd": cmd}).encode()
        req = urllib.request.Request(self.url, data=body, method="POST",  # noqa: S310 — 位址只從環境變數讀
                                     headers={"X-PAN-KEY": self.key, "Content-Type": "application/x-www-form-urlencoded"})
        m: dict[str, Any] = {"ok": False}
        t0 = time.monotonic()
        buf = bytearray()
        try:
            with self._open(req, timeout=self.timeout) as res:
                while True:
                    chunk = res.read(CHUNK)
                    if not chunk:
                        break
                    buf += chunk
                    if len(buf) > self.cap:
                        m.update(error=f"回應超過 {self.cap // CHUNK} MB,已中止", bytes=len(buf))
                        return None, m
        except urllib.error.HTTPError as e:
            m["error"] = f"HTTP {e.code}"
            return None, m
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            m["error"] = f"連線失敗:{type(getattr(e, 'reason', e)).__name__}"
            m["seconds"] = round(time.monotonic() - t0, 2)
            return None, m
        m["seconds"] = round(time.monotonic() - t0, 2)
        m["bytes"] = len(buf)
        t1 = time.monotonic()
        try:
            root = ET.fromstring(bytes(buf))  # noqa: S314 — PA-560 管理介面的回應
        except ET.ParseError:
            m["error"] = "回應不是 XML"
            return None, m
        m["parseSeconds"] = round(time.monotonic() - t1, 2)
        if root.get("status") != "success":
            # 只記 PA 錯誤代碼與前 120 字(錯誤訊息不含設定內容)
            detail = " ".join(t.strip() for t in root.itertext() if t.strip())[:120]
            m.update(error=f"PA 回應錯誤 code={root.get('code', '-')}", detail=detail)
            return None, m
        m["ok"] = True
        return root, m

    def cpu(self) -> float | None:
        root, _ = self.op(CPU_CMD)
        if root is None:
            return None
        found = _CPU_IDLE.search("".join(root.itertext()))
        return round(max(0.0, 100.0 - float(found.group(1))), 1) if found else None


def summarize_entries(root: ET.Element) -> dict[str, Any]:
    """特徵 / 設定清單:筆數、子欄位出現次數、severity / default-action 分布(不輸出內容)。"""
    result = root.find("./result")
    if result is None:
        return {"entries": 0, "note": "沒有 <result>"}
    entries = result.findall(".//entry")
    top = [e for e in result.iter("entry") if e.get("name") is not None]
    # 第一層 entry(避免把巢狀 entry 也算進去):取 result 下第一個有 entry 子節點的容器
    first_level: list[ET.Element] = []
    for el in result.iter():
        kids = el.findall("entry")
        if kids:
            first_level = kids
            break
    fields: Counter[str] = Counter()
    severity: Counter[str] = Counter()
    action: Counter[str] = Counter()
    with_cve = 0
    for e in first_level:
        tags = {c.tag for c in e}
        fields.update(tags)
        sev = e.findtext("severity")
        if sev:
            severity[sev.strip()] += 1
        da = e.find("default-action")
        if da is not None:
            action[next((c.tag for c in da), (da.text or "").strip() or "?")] += 1
        cve = e.find("cve")
        if cve is not None and (list(cve) or (cve.text or "").strip()):
            with_cve += 1
    ids = [e.get("name", "") for e in first_level]
    return {
        "entries": len(first_level),
        "allNestedEntries": len(entries),
        "namedEntries": len(top),
        "numericIds": sum(1 for i in ids if i.isdigit()),
        "idRange": [min(ids, key=_num), max(ids, key=_num)] if ids else None,
        "fields": dict(fields.most_common(40)),
        "severity": dict(severity),
        "defaultAction": dict(action),
        "withCve": with_cve,
        "firstId": next((i for i in ids if i.isdigit()), None),
    }


def _num(s: str) -> int:
    return int(s) if s.isdigit() else -1


def summarize_info(root: ET.Element) -> dict[str, Any]:
    sysel = root.find("./result/system")
    if sysel is None:
        return {"note": "沒有 <system>"}
    return {k: (sysel.findtext(k) or "").strip() or None for k in INFO_FIELDS}


def main() -> int:
    ap = argparse.ArgumentParser(description="TS-0 唯讀實測(PA 本機特徵庫)")
    ap.add_argument("--only", help="只跑指定步驟(逗號分隔),例如 system-info,vulnerability;App 清單用 --only application")
    ap.add_argument("--cap-mb", type=int, default=64, help="單一回應大小上限(MB,預設 64;超過就中止該步)")
    ap.add_argument("--timeout", type=float, default=120.0, help="單一請求逾時秒數(預設 120)")
    ap.add_argument("--pause", type=float, default=3.0, help="步驟之間等待秒數(預設 3)")
    args = ap.parse_args()

    only = {s.strip() for s in args.only.split(",")} if args.only else None
    if only and not only <= {n for n, _, _ in STEPS} | {"single"}:
        sys.exit(f"未知的步驟:{'、'.join(sorted(only - {n for n, _, _ in STEPS} - {'single'}))}")
    steps = [(n, c) for n, c, d in STEPS if (n in only if only else d)]
    probe = Probe(args.cap_mb, args.timeout)
    report: dict[str, Any] = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "maxCpu": MAX_CPU, "steps": []}

    def run(name: str, cmd: str, kind: str) -> ET.Element | None:
        before = probe.cpu()
        if before is None or before > MAX_CPU:
            report["stopped"] = f"{name}:管理平面 CPU {'讀不到' if before is None else f'{before}%'},超過門檻,停止"
            return None
        root, m = probe.op(cmd)
        after = probe.cpu()
        row: dict[str, Any] = {"step": name, "cpuBefore": before, "cpuAfter": after, **m}
        if root is not None:
            row["summary"] = summarize_info(root) if kind == "info" else summarize_entries(root)
        report["steps"].append(row)
        print(f"[{name}] ok={m.get('ok')} bytes={m.get('bytes')} seconds={m.get('seconds')} "
              f"cpu={before}->{after} {m.get('error', '')}", file=sys.stderr)
        time.sleep(args.pause)
        return root

    first_id: str | None = None
    for name, cmd in steps:
        root = run(name, cmd, "info" if name == "system-info" else "list")
        if "stopped" in report:
            break
        if name == "vulnerability" and root is not None:
            first_id = report["steps"][-1]["summary"].get("firstId")
            del root  # 釋放記憶體

    # 單筆查詢(抽屜按需查詢用):ID 取自弱點清單第一筆;沒有清單時略過
    if "stopped" not in report and first_id and (not only or "single" in only):
        run("single-entry", predefined(f"/predefined/threats/vulnerability/entry[@name='{first_id}']"), "list")
        if "stopped" not in report:
            run("show-threat-id", f"<show><threat><id>{first_id}</id></threat></show>", "list")

    report["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if "stopped" in report else 0


if __name__ == "__main__":
    sys.exit(main())
