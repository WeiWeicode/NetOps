"""假 PA-560 XML API(只供測試;R1 開發時還沒有 PA-560 的 IP、版本與 Key)。

模擬 PAN-OS XML API:POST/GET /api/?type=op&cmd=<xml>&key=<key>,依 cmd 回傳仿 PAN-OS 10.x 的回應。
真正的 pan-os-python 連到這裡(SdkClient(use_http=True)),所以測試涵蓋 SDK 的呼叫路徑。
同時記錄收到的所有請求,讓測試確認只送出唯讀 op 指令。
"""

from __future__ import annotations

import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SESSION_INFO = """<response status="success"><result>
<tmo-sctpshutdown>60</tmo-sctpshutdown><tcp-nonsyn-rej>True</tcp-nonsyn-rej>
<num-max>{max}</num-max><num-active>{active}</num-active><num-tcp>3100</num-tcp><num-udp>800</num-udp><num-icmp>12</num-icmp>
<num-installed>123456</num-installed><cps>{cps}</cps><kbps>{kbps}</kbps><pps>{pps}</pps>
</result></response>"""

SYSTEM_RESOURCES = """<response status="success"><result><![CDATA[top - 10:00:01 up 30 days,  1:02,  0 users,  load average: 0.50, 0.40, 0.30
Tasks: 150 total,   1 running, 149 sleeping,   0 stopped,   0 zombie
%Cpu(s):  7.5 us,  2.5 sy,  0.0 ni, {idle} id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
MiB Mem :   7948.4 total,    500.2 free,   4000.0 used,   3448.2 buff/cache
MiB Swap:      0.0 total,      0.0 free,      0.0 used.   3000.0 avail Mem
]]></result></response>"""

RESOURCE_MONITOR = """<response status="success"><result><resource-monitor><data-processors><dp0><second>
<cpu-load-average><entry><coreid>0</coreid><value>{c0}</value></entry><entry><coreid>1</coreid><value>{c1},9,9</value></entry></cpu-load-average>
<cpu-load-maximum><entry><coreid>0</coreid><value>99</value></entry></cpu-load-maximum>
</second></dp0></data-processors></resource-monitor></result></response>"""

COUNTERS = """<response status="success"><result><ifnet><ifnet>
<entry><name>ethernet1/1</name><ibytes>{i1}</ibytes><obytes>{o1}</obytes><ipackets>10</ipackets></entry>
<entry><name>ethernet1/2</name><ibytes>{i2}</ibytes><obytes>{o2}</obytes><ipackets>10</ipackets></entry>
</ifnet></ifnet><hw><entry><name>ethernet1/1</name><port><rx-bytes>1</rx-bytes></port></entry></hw></result></response>"""

ERROR_403 = '<response status="error" code="403"><result><msg>Invalid Credential</msg></result></response>'


class FakePa:
    def __init__(self, api_key: str = "test-key") -> None:
        self.api_key = api_key
        self.requests: list[dict[str, str]] = []
        # 每次查詢回傳的數值(測試可改)
        self.values = {"max": 262142, "active": 3912, "cps": 45, "kbps": 85000, "pps": 12000, "idle": 90.0,
                       "c0": 4, "c1": 6, "i1": 1000, "o1": 2000, "i2": 0, "o2": 0}
        # 指定要失敗的指令(cmd XML 子字串 → 回應)
        self.fail: dict[str, str] = {}
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # 測試不印存取紀錄
                pass

            def _params(self) -> dict[str, str]:
                q = urllib.parse.urlsplit(self.path).query
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n).decode() if n else ""
                return {k: v[0] for k, v in urllib.parse.parse_qs(q + "&" + body).items()}

            def _handle(self) -> None:
                p = self._params()
                fake.requests.append(p)
                xml = fake.respond(p)
                data = xml.encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/xml")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def respond(self, p: dict[str, str]) -> str:
        if p.get("key") != self.api_key:
            return ERROR_403
        cmd = p.get("cmd", "")
        for frag, resp in self.fail.items():
            if frag in cmd:
                return resp
        v = self.values
        if "<session><info" in cmd:
            return SESSION_INFO.format(**v)
        if "<system><resources" in cmd:
            return SYSTEM_RESOURCES.format(**v)
        if "<resource-monitor>" in cmd:
            return RESOURCE_MONITOR.format(**v)
        if "<counter><interface" in cmd:
            return COUNTERS.format(**v)
        return '<response status="error" code="17"><msg><line>Invalid syntax.</line></msg></response>'

    def __enter__(self) -> FakePa:
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.server.shutdown()
        self.server.server_close()
