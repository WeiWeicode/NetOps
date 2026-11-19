"""假 PA-560 XML API(只供測試;R1 開發時還沒有 PA-560 的 IP、版本與 Key)。

模擬 PAN-OS XML API:POST/GET /api/?type=op&cmd=<xml>&key=<key>,依 cmd 回傳仿 PAN-OS 10.x 的回應。
真正的 pan-os-python 連到這裡(SdkClient(use_http=True)),所以測試涵蓋 SDK 的呼叫路徑。
同時記錄收到的所有請求,讓測試確認只送出唯讀 op 指令。
"""

from __future__ import annotations

import re
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
</ifnet></ifnet><hw><entry><name>ethernet1/1</name><state>up</state><ibytes>1</ibytes><obytes>1</obytes><port><rx-bytes>1</rx-bytes></port></entry></hw></result></response>"""
# 依 PAN-OS 文件的格式(ifnet 邏輯介面計數 + hw 實體埠計數);12.1 的實際回應待實機確認

# PAN-OS 12.1.7-h3 實測:interface 底下送元素(<all/>)而不是值時的錯誤
ERROR_NULL_VALUE = """<response status="error"><msg><line><![CDATA[ show -> counter -> interface -> all needs to have non NULL value]]></line>
<line><![CDATA[ show -> counter -> interface is invalid]]></line></msg></response>"""

ERROR_403 = '<response status="error" code="403"><result><msg>Invalid Credential</msg></result></response>'

# ---------- TS-0 實測(2026-11-19)假資料:威脅特徵碼與 vsys1 profile ----------
SYSTEM_INFO_SIG = """<response status="success"><result><system>
<hostname>PA-560</hostname><model>PA-560</model><sw-version>12.1.7-h3</sw-version>
<threat-version>{threat_version}</threat-version>
<threat-release-date>{threat_release_date}</threat-release-date>
<app-version>{app_version}</app-version>
<app-release-date>{app_release_date}</app-release-date>
<av-version>{av_version}</av-version>
<av-release-date>{av_release_date}</av-release-date>
<wildfire-version>{wildfire_version}</wildfire-version>
<wildfire-release-date>{wildfire_release_date}</wildfire-release-date>
<url-filtering-version>20261006.20097</url-filtering-version>
</system></result></response>"""

# 弱點特徵(TS-0 欄位:threatname、severity、category、affected-host、engine-version、default-action、cve、vendor、disable、time-attribute;無發布日)
PREDEFINED_VULNERABILITY = """<response status="success"><result><vulnerability>
<entry name="547000">
  <threatname>HTTP Remote Code Execution Vulnerability</threatname>
  <severity>critical</severity>
  <category>code-execution</category>
  <affected-host><server>yes</server></affected-host>
  <engine-version>8.0</engine-version>
  <default-action><reset-both/></default-action>
  <cve><member>CVE-2026-1001</member><member>CVE-2026-1002</member></cve>
  <vendor><member>MS26-001</member></vendor>
  <time-attribute><threshold>5</threshold><track-by>source</track-by><interval>60</interval></time-attribute>
</entry>
<entry name="30000">
  <threatname>Legacy SMB Info Leak</threatname>
  <severity>high</severity>
  <category>info-leak</category>
  <affected-host>client</affected-host>
  <engine-version>7.1</engine-version>
  <disable>yes</disable>
</entry>
</vulnerability></result></response>"""

# 間諜軟體特徵(TS-0 欄位:無 CVE、無 affected-host、無 vendor)
PREDEFINED_PHONE_HOME = """<response status="success"><result><phone-home>
<entry name="10001">
  <threatname>Generic C2 Beacon Traffic</threatname>
  <severity>critical</severity>
  <category>spyware</category>
  <engine-version>8.0</engine-version>
  <default-action><reset-both/></default-action>
</entry>
<entry name="87187">
  <threatname>DNS Tunneling Probe</threatname>
  <severity>medium</severity>
  <category>dns-c2</category>
  <engine-version>8.0</engine-version>
  <default-action><alert/></default-action>
  <disable/>
</entry>
</phone-home></result></response>"""

PROFILE_GROUP_VSYS = """<response status="success"><result><profile-group>
<entry name="SG">
  <virus><member>AV_POC</member></virus>
  <spyware><member>Spyware_POC</member></spyware>
  <vulnerability><member>Vulnerability_POC</member></vulnerability>
  <url-filtering><member>URL_POC</member></url-filtering>
  <file-blocking><member>FB_POC</member></file-blocking>
  <wildfire-analysis><member>WF_POC</member></wildfire-analysis>
</entry>
<entry name="AV_ONLY">
  <virus><member>AV_POC</member></virus>
</entry>
</profile-group></result></response>"""

# 故意加入巢狀 rules/threat-exception entry(TS-0 實測共 14 / 21 個巢狀 entry),確認解析只取第一層 profile 名稱
VP_PROFILES_VSYS = """<response status="success"><result><vulnerability>
<entry name="Vulnerability_POC">
  <rules><entry name="simple-client-critical"><action><reset-both/></action></entry></rules>
  <threat-exception><entry name="547000"><action><alert/></action></entry></threat-exception>
</entry>
</vulnerability></result></response>"""

AS_PROFILES_VSYS = """<response status="success"><result><spyware>
<entry name="Spyware_POC">
  <rules><entry name="simple-critical"><action><reset-both/></action></entry></rules>
  <botnet-domains><lists><entry name="default-paloalto-dns"/></lists></botnet-domains>
</entry>
</spyware></result></response>"""

SHOW_THREAT_ID_FOUND = """<response status="success"><result>
<entry name="{name}">
  <subtype>{subtype}</subtype>
  <severity>{severity}</severity>
  <description>{description}</description>
</entry>
</result></response>"""

NO_SUCH_NODE = '<response status="error"><msg><line>No such node</line></msg></response>'
_THREAT_ID_CMD = re.compile(r"<show><threat><id>(\d+)</id></threat></show>")


class FakePa:
    def __init__(self, api_key: str = "test-key", *, require_header_key: bool = False) -> None:
        self.api_key = api_key
        self.require_header_key = require_header_key
        self.requests: list[dict[str, str]] = []
        # 每次查詢回傳的數值(測試可改)
        self.values: dict[str, object] = {
            "max": 262142,
            "active": 3912,
            "cps": 45,
            "kbps": 85000,
            "pps": 12000,
            "idle": 90.0,
            "c0": 4,
            "c1": 6,
            "i1": 1000,
            "o1": 2000,
            "i2": 0,
            "o2": 0,
            "threat_version": "9173-10354",
            "threat_release_date": "2026/11/17 05:46:29 CST",
            "app_version": "9173-10354",
            "app_release_date": "2026/11/17 05:46:29 CST",
            "av_version": "5749-6277",
            "av_release_date": "2026/11/18 20:00:27 CST",
            "wildfire_version": "1136765-1141451",
            "wildfire_release_date": "2026/11/19 14:57:18 CST",
        }
        self.vuln_xml = PREDEFINED_VULNERABILITY
        self.phone_home_xml = PREDEFINED_PHONE_HOME
        self.profile_group_xml = PROFILE_GROUP_VSYS
        self.vp_profiles_xml = VP_PROFILES_VSYS
        self.as_profiles_xml = AS_PROFILES_VSYS
        self.threat_ids: dict[str, dict[str, str]] = {
            "547000": {
                "name": "Test App-ID change signature",
                "subtype": "vulnerability",
                "severity": "informational",
                "description": "Test threat description from PA-560.",
            },
        }
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
                p = {k: v[0] for k, v in urllib.parse.parse_qs(q + "&" + body).items()}
                p["_url"] = self.path
                p["_header_key"] = self.headers.get("X-PAN-KEY", "")
                return p

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
        provided_key = p.get("_header_key") if self.require_header_key else (p.get("_header_key") or p.get("key"))
        if provided_key != self.api_key:
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
        if "<system><info" in cmd:
            return SYSTEM_INFO_SIG.format(**v)
        if "<resource-monitor>" in cmd:
            return RESOURCE_MONITOR.format(**v)
        if "<counter><interface>all</interface>" in cmd:
            return COUNTERS.format(**v)
        if "<counter><interface>" in cmd:
            return ERROR_NULL_VALUE
        if "/predefined/threats/vulnerability</xpath>" in cmd:
            return self.vuln_xml
        if "/predefined/threats/phone-home</xpath>" in cmd:
            return self.phone_home_xml
        if "vsys1']/profile-group</xpath>" in cmd:
            return self.profile_group_xml
        if "vsys1']/profiles/vulnerability</xpath>" in cmd:
            return self.vp_profiles_xml
        if "vsys1']/profiles/spyware</xpath>" in cmd:
            return self.as_profiles_xml
        m = _THREAT_ID_CMD.search(cmd)
        if m:
            entry = self.threat_ids.get(m.group(1))
            if entry:
                return SHOW_THREAT_ID_FOUND.format(**entry)
            return '<response status="success"><result/></response>'
        return '<response status="error" code="17"><msg><line>Invalid syntax.</line></msg></response>'

    def __enter__(self) -> FakePa:
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.server.shutdown()
        self.server.server_close()
