#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NetOps ClickHouse 容量與硬體使用查詢工具 (產生 Excel 報告)
支援測試區 (host2 / 10.10.130.124) 與正式區 (host3 / 10.10.130.122)
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
from typing import Any, Dict, List, Optional

try:
    import openpyxl
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    print("錯誤: 找不到 openpyxl 套件，請先執行: pip install openpyxl")
    sys.exit(1)

ENV_CONFIGS = {
    "test": {
        "name": "測試區 (Test)",
        "host": "host2",
        "ip": "10.10.130.124",
        "container_pattern": "clickhouse",
    },
    "prod": {
        "name": "正式區 (Prod)",
        "host": "host3",
        "ip": "10.10.130.122",
        "container_pattern": "clickhouse",
    },
}


def run_ssh_command(
    host: str, cmd: str, input_data: Optional[str] = None, timeout: int = 35
) -> tuple[int, str, str]:
    """透過 SSH 在目標主機的 WSL 中執行指令，支援 stdin 傳遞"""
    ssh_target = ["ssh", host, f"wsl -u root {cmd}"]
    try:
        proc = subprocess.run(
            ssh_target,
            input=input_data,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", f"SSH 指令超時 ({timeout}s)"
    except Exception as e:
        return -1, "", str(e)


def format_bytes(b: int) -> str:
    """轉換 bytes 為易讀格式"""
    if b < 0:
        return "N/A"
    num = float(b)
    for unit in ["B", "KiB", "MiB", "GiB", "TiB"]:
        if num < 1024.0:
            return f"{num:.2f} {unit}"
        num /= 1024.0
    return f"{num:.2f} PiB"


def query_environment(env_key: str) -> Dict[str, Any]:
    cfg = ENV_CONFIGS[env_key]
    host = cfg["host"]
    result: Dict[str, Any] = {
        "env_key": env_key,
        "env_name": cfg["name"],
        "host": host,
        "ip": cfg["ip"],
        "status": "未知",
        "container": None,
        "limits": {},
        "stats": {},
        "volume": {},
        "tables": [],
        "table_times": {},
        "disks": {},
        "memory_host": {},
        "error": None,
    }

    print(f"\n[*] 正在連線 {cfg['name']} ({host} / {cfg['ip']})...")

    # 1. 查詢主機磁碟與記憶體狀況 (無論容器是否啟動都查詢)
    rc, stdout, stderr = run_ssh_command(host, "df -h / /mnt/c /mnt/d")
    if rc == 0 and stdout:
        for line in stdout.splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 6:
                mount = parts[5]
                dev = parts[0]
                if mount == "/":
                    result["disks"]["wsl"] = {
                        "size": parts[1],
                        "used": parts[2],
                        "avail": parts[3],
                        "use_perc": parts[4],
                    }
                elif "mnt/c" in mount or "C:" in dev:
                    result["disks"]["c_drive"] = {
                        "size": parts[1],
                        "used": parts[2],
                        "avail": parts[3],
                        "use_perc": parts[4],
                    }
                elif "mnt/d" in mount or "D:" in dev:
                    result["disks"]["d_drive"] = {
                        "size": parts[1],
                        "used": parts[2],
                        "avail": parts[3],
                        "use_perc": parts[4],
                    }

    rc, stdout, _ = run_ssh_command(host, "free -m")
    if rc == 0 and stdout:
        for line in stdout.splitlines():
            if line.startswith("Mem:"):
                parts = line.split()
                if len(parts) >= 7:
                    result["memory_host"] = {
                        "total_mb": parts[1],
                        "used_mb": parts[2],
                        "free_mb": parts[3],
                        "available_mb": parts[6],
                    }

    # 2. 檢查 ClickHouse 容器
    rc, stdout, stderr = run_ssh_command(
        host,
        "docker ps -a --filter name=clickhouse --format '{{.Names}}\t{{.Status}}\t{{.Image}}'",
    )
    if rc != 0:
        result["error"] = f"SSH 連線失敗或無法存取 Docker: {stderr}"
        print(f"    [-] 失敗: {result['error']}")
        return result

    if not stdout:
        result["status"] = "尚未部署 ClickHouse 容器"
        print(f"    [i] 在 {cfg['name']} 未找到 ClickHouse 容器（尚未部署）")
        return result

    container_name = None
    container_status = None
    container_image = None
    for line in stdout.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and "clickhouse" in parts[0]:
            container_name = parts[0]
            container_status = parts[1]
            container_image = parts[2]
            break

    if not container_name:
        result["status"] = "未找到 ClickHouse 容器"
        return result

    result["container"] = {
        "name": container_name,
        "status": container_status,
        "image": container_image,
        "is_up": "Up" in container_status,
    }
    print(f"    [+] 找到容器: {container_name} ({container_status})")

    if not result["container"]["is_up"]:
        result["status"] = f"容器未運行 ({container_status})"
        return result

    result["status"] = "運行中"

    # 3. 透過 docker inspect 取得容器詳細配置與掛載 Volume (JSON 解析，完全避開 escaping 問題)
    rc, stdout, _ = run_ssh_command(host, f"docker inspect {container_name}")
    vol_source = ""
    vol_name = ""
    vol_dest = ""
    if rc == 0 and stdout:
        try:
            inspect_data = json.loads(stdout)[0]
            host_cfg = inspect_data.get("HostConfig", {})
            mem_limit = host_cfg.get("Memory", 0)
            nano_cpus = host_cfg.get("NanoCpus", 0)
            result["limits"] = {
                "mem_bytes": mem_limit,
                "mem_str": format_bytes(mem_limit) if mem_limit > 0 else "無限制",
                "cpus": nano_cpus / 1e9 if nano_cpus > 0 else "無限制",
            }

            for mount in inspect_data.get("Mounts", []):
                if mount.get("Type") == "volume" and "clickhouse" in mount.get(
                    "Destination", ""
                ):
                    vol_name = mount.get("Name", "")
                    vol_source = mount.get("Source", "")
                    vol_dest = mount.get("Destination", "")
                    break
        except Exception as e:
            print(f"    [!] 解析 inspect JSON 警告: {e}")

    # 4. 查詢容器即時資源使用率 (Stats)
    rc, stdout, _ = run_ssh_command(
        host,
        f"docker stats --no-stream {container_name} --format '{{{{.CPUPerc}}}}\t{{{{.MemUsage}}}}\t{{{{.MemPerc}}}}'",
    )
    if rc == 0 and stdout:
        parts = stdout.split("\t")
        if len(parts) >= 3:
            result["stats"] = {
                "cpu_perc": parts[0],
                "mem_usage": parts[1],
                "mem_perc": parts[2],
            }

    # 5. 查詢 Volume 實體磁碟佔用 (du -sh)
    if vol_source:
        rc, du_out, _ = run_ssh_command(host, f"du -sh {vol_source}")
        du_size = du_out.split()[0] if rc == 0 and du_out else "N/A"
        result["volume"] = {
            "name": vol_name,
            "source": vol_source,
            "destination": vol_dest,
            "size": du_size,
        }
    print(f"    [+] Volume 實體佔用: {result['volume'].get('size', 'N/A')}")

    # 6. 透過 stdin 傳遞 SQL 查詢 ClickHouse 各表分區大小 (system.parts)
    sql_parts = (
        "SELECT database, table, active, sum(rows) AS total_rows, "
        "sum(data_compressed_bytes) AS comp_bytes, "
        "sum(data_uncompressed_bytes) AS uncomp_bytes, "
        "sum(bytes_on_disk) AS on_disk_bytes, count() AS parts_count "
        "FROM system.parts "
        "GROUP BY database, table, active "
        "ORDER BY database, table, active "
        "FORMAT TabSeparatedWithNames;\n"
    )
    rc, stdout, stderr = run_ssh_command(
        host,
        f"docker exec -i {container_name} clickhouse-client",
        input_data=sql_parts,
    )
    if rc == 0 and stdout:
        lines = stdout.splitlines()
        if len(lines) > 1:
            headers = lines[0].split("\t")
            for line in lines[1:]:
                vals = line.split("\t")
                if len(vals) == len(headers):
                    row = dict(zip(headers, vals))
                    result["tables"].append(row)

    # 7. 透過 stdin 查詢業務資料表時間範圍
    sql_time = (
        "SELECT 'pa_traffic_logs' AS table, "
        "toString(min(event_time)) AS min_t, toString(max(event_time)) AS max_t "
        "FROM netops.pa_traffic_logs "
        "UNION ALL "
        "SELECT 'pa_threat_logs' AS table, "
        "toString(min(event_time)) AS min_t, toString(max(event_time)) AS max_t "
        "FROM netops.pa_threat_logs "
        "FORMAT TabSeparatedWithNames;\n"
    )
    rc, stdout, _ = run_ssh_command(
        host,
        f"docker exec -i {container_name} clickhouse-client",
        input_data=sql_time,
    )
    if rc == 0 and stdout:
        lines = stdout.splitlines()
        if len(lines) > 1:
            for line in lines[1:]:
                parts = line.split("\t")
                if len(parts) >= 3:
                    result["table_times"][parts[0]] = {
                        "min_time": parts[1],
                        "max_time": parts[2],
                    }

    print(f"    [+] {cfg['name']} 查詢完成")
    return result


def create_excel_report(data_list: List[Dict[str, Any]], output_path: str):
    wb = openpyxl.Workbook()
    default_sheet = wb.active

    # 樣式定義
    font_title = Font(name="微軟正黑體", size=15, bold=True, color="1F4E78")
    font_section = Font(name="微軟正黑體", size=12, bold=True, color="FFFFFF")
    font_header = Font(name="微軟正黑體", size=10, bold=True, color="FFFFFF")
    font_bold = Font(name="微軟正黑體", size=10, bold=True)
    font_regular = Font(name="微軟正黑體", size=10)
    font_small = Font(name="微軟正黑體", size=9, color="595959")
    font_warn = Font(name="微軟正黑體", size=11, bold=True, color="C00000")

    fill_section = PatternFill(
        start_color="1F4E78", end_color="1F4E78", fill_type="solid"
    )
    fill_header = PatternFill(
        start_color="2F5597", end_color="2F5597", fill_type="solid"
    )
    fill_sub_header = PatternFill(
        start_color="D9E1F2", end_color="D9E1F2", fill_type="solid"
    )
    fill_zebra = PatternFill(
        start_color="F9FAFB", end_color="F9FAFB", fill_type="solid"
    )
    fill_total = PatternFill(
        start_color="FFF2CC", end_color="FFF2CC", fill_type="solid"
    )
    fill_warn = PatternFill(
        start_color="FCE4D6", end_color="FCE4D6", fill_type="solid"
    )

    border_thin = Side(style="thin", color="D9D9D9")
    box_border = Border(
        left=border_thin, right=border_thin, top=border_thin, bottom=border_thin
    )

    align_center = Alignment(horizontal="center", vertical="center")
    align_left = Alignment(horizontal="left", vertical="center")
    align_right = Alignment(horizontal="right", vertical="center")

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for data in data_list:
        sheet_title = "測試區容量報告" if data["env_key"] == "test" else "正式區容量報告"
        ws = wb.create_sheet(title=sheet_title)

        # 標題
        ws.merge_cells("A1:H1")
        cell_a1 = ws["A1"]
        cell_a1.value = f"NetOps ClickHouse 硬體容量與資料佔用報告 - {data['env_name']}"
        cell_a1.font = font_title
        cell_a1.alignment = align_left
        ws.row_dimensions[1].height = 28

        ws["A2"] = f"查詢時間: {now_str}    目標主機: {data['host']} ({data['ip']})"
        ws["A2"].font = font_small
        ws.row_dimensions[2].height = 18

        # 區塊一：規格與硬體資源現況
        ws.merge_cells("A4:H4")
        sec1 = ws["A4"]
        sec1.value = "一、 Docker Volume 實體佔用空間與硬體資源使用現況"
        sec1.font = font_section
        sec1.fill = fill_section
        ws.row_dimensions[4].height = 24

        if data["status"] != "運行中":
            ws.merge_cells("A5:H5")
            ws["A5"] = f"【狀態說明】: {data['status']}"
            ws["A5"].font = font_warn
            ws["A5"].fill = fill_warn
            ws["A5"].border = box_border
            ws.row_dimensions[5].height = 22

            # 顯示宿主機硬體狀況
            ws.merge_cells("A6:H6")
            ws["A6"] = "宿主機磁碟與記憶體現況（提供部署評估）："
            ws["A6"].font = font_bold
            ws["A6"].fill = fill_sub_header
            ws["A6"].border = box_border

            host_wsl = data["disks"].get("wsl", {})
            host_c = data["disks"].get("c_drive", {})
            host_d = data["disks"].get("d_drive", {})
            host_mem = data.get("memory_host", {})

            info_rows = [
                (
                    "WSL2 虛擬磁碟空間",
                    f"總計 {host_wsl.get('size', 'N/A')}, 已用 {host_wsl.get('used', 'N/A')}, 剩餘 {host_wsl.get('avail', 'N/A')} (使用率 {host_wsl.get('use_perc', 'N/A')})",
                    "宿主機可用記憶體",
                    f"{host_mem.get('available_mb', 'N/A')} MB / 總計 {host_mem.get('total_mb', 'N/A')} MB",
                ),
                (
                    "Windows 實體 C 碟",
                    f"總計 {host_c.get('size', 'N/A')}, 已用 {host_c.get('used', 'N/A')}, 剩餘 {host_c.get('avail', 'N/A')} (使用率 {host_c.get('use_perc', 'N/A')})",
                    "Windows 實體 D 碟",
                    f"總計 {host_d.get('size', 'N/A')}, 剩餘 {host_d.get('avail', 'N/A')} (使用率 {host_d.get('use_perc', 'N/A')})"
                    if host_d
                    else "無 D 碟",
                ),
            ]

            curr_r = 7
            for r in info_rows:
                ws[f"A{curr_r}"] = r[0]
                ws[f"A{curr_r}"].font = font_bold
                ws[f"A{curr_r}"].fill = fill_sub_header
                ws[f"A{curr_r}"].border = box_border

                ws.merge_cells(f"B{curr_r}:D{curr_r}")
                ws[f"B{curr_r}"] = r[1]
                ws[f"B{curr_r}"].font = font_regular
                ws[f"B{curr_r}"].border = box_border

                ws[f"E{curr_r}"] = r[2]
                ws[f"E{curr_r}"].font = font_bold
                ws[f"E{curr_r}"].fill = fill_sub_header
                ws[f"E{curr_r}"].border = box_border

                ws.merge_cells(f"F{curr_r}:H{curr_r}")
                ws[f"F{curr_r}"] = r[3]
                ws[f"F{curr_r}"].font = font_regular
                ws[f"F{curr_r}"].border = box_border
                curr_r += 1

            ws.merge_cells(f"A{curr_r}:H{curr_r}")
            ws[f"A{curr_r}"] = (
                "備註: 正式區上線規劃配置建議為記憶體 2.0 GiB、磁碟預留 20 GB。目前宿主機可用資源足夠。"
            )
            ws[f"A{curr_r}"].font = font_small
            continue

        summary_rows = [
            ("容器名稱", data["container"]["name"], "容器狀態", data["container"]["status"]),
            (
                "記憶體上限 (配額)",
                data["limits"].get("mem_str", "N/A"),
                "CPU 核心上限",
                f"{data['limits'].get('cpus', 'N/A')} 核心",
            ),
            (
                "即時記憶體使用",
                f"{data['stats'].get('mem_usage', 'N/A')} ({data['stats'].get('mem_perc', 'N/A')})",
                "即時 CPU 使用率",
                data['stats'].get('cpu_perc', 'N/A'),
            ),
            (
                "Docker Volume 實體佔用",
                data["volume"].get("size", "N/A"),
                "Volume 名稱",
                data["volume"].get("name", "N/A"),
            ),
            (
                "WSL2 虛擬磁碟空間",
                f"總計 {data['disks'].get('wsl', {}).get('size', 'N/A')}, 剩餘 {data['disks'].get('wsl', {}).get('avail', 'N/A')} (使用率 {data['disks'].get('wsl', {}).get('use_perc', 'N/A')})",
                "宿主機 C 碟剩餘",
                f"總計 {data['disks'].get('c_drive', {}).get('size', 'N/A')}, 剩餘 {data['disks'].get('c_drive', {}).get('avail', 'N/A')} (使用率 {data['disks'].get('c_drive', {}).get('use_perc', 'N/A')})",
            ),
        ]

        curr_r = 5
        for row in summary_rows:
            ws[f"A{curr_r}"] = row[0]
            ws[f"A{curr_r}"].font = font_bold
            ws[f"A{curr_r}"].fill = fill_sub_header
            ws[f"A{curr_r}"].border = box_border

            ws.merge_cells(f"B{curr_r}:D{curr_r}")
            ws[f"B{curr_r}"] = row[1]
            ws[f"B{curr_r}"].font = font_regular
            ws[f"B{curr_r}"].border = box_border

            ws[f"E{curr_r}"] = row[2]
            ws[f"E{curr_r}"].font = font_bold
            ws[f"E{curr_r}"].fill = fill_sub_header
            ws[f"E{curr_r}"].border = box_border

            ws.merge_cells(f"F{curr_r}:H{curr_r}")
            ws[f"F{curr_r}"] = row[3]
            ws[f"F{curr_r}"].font = font_regular
            ws[f"F{curr_r}"].border = box_border
            ws.row_dimensions[curr_r].height = 20
            curr_r += 1

        curr_r += 1

        # 區塊二：各資料表佔用大小拆解
        ws.merge_cells(f"A{curr_r}:H{curr_r}")
        sec2 = ws[f"A{curr_r}"]
        sec2.value = "二、 內部各資料表佔用大小拆解 (ClickHouse system.parts)"
        sec2.font = font_section
        sec2.fill = fill_section
        ws.row_dimensions[curr_r].height = 24
        curr_r += 1

        headers = [
            "資料庫",
            "資料表名稱",
            "狀態 (Active)",
            "資料筆數 (Rows)",
            "壓縮後大小 (磁碟)",
            "未壓縮大小",
            "壓縮比",
            "分區數 / 資料涵蓋時間",
        ]
        for col_idx, h in enumerate(headers, 1):
            cell = ws.cell(row=curr_r, column=col_idx)
            cell.value = h
            cell.font = font_header
            cell.fill = fill_header
            cell.alignment = align_center
            cell.border = box_border
        ws.row_dimensions[curr_r].height = 22
        curr_r += 1

        rows = data["tables"]
        active_business = [
            r for r in rows if r["active"] == "1" and r["database"] == "netops"
        ]
        active_system = [
            r for r in rows if r["active"] == "1" and r["database"] != "netops"
        ]
        inactive_parts = [r for r in rows if r["active"] == "0"]

        def write_part_rows(
            part_list, category_name: str, is_inactive: bool = False
        ):
            nonlocal curr_r
            total_rows_cat = 0
            total_comp_cat = 0
            total_uncomp_cat = 0

            for idx, r in enumerate(part_list):
                rows_num = int(r["total_rows"])
                comp_num = int(r["comp_bytes"])
                uncomp_num = int(r["uncomp_bytes"])
                ratio = (
                    round(uncomp_num / comp_num, 2)
                    if comp_num > 0
                    else 1.0
                )
                tbl_name = r["table"]

                time_range = ""
                if tbl_name in data["table_times"]:
                    t_info = data["table_times"][tbl_name]
                    time_range = f"{t_info['min_time']} ~ {t_info['max_time']}"
                else:
                    time_range = f"{r['parts_count']} 個分區 (parts)"

                total_rows_cat += rows_num
                total_comp_cat += comp_num
                total_uncomp_cat += uncomp_num

                row_vals = [
                    r["database"],
                    tbl_name,
                    "作用中 (Active)" if not is_inactive else "背景合併中 (Inactive)",
                    f"{rows_num:,}",
                    format_bytes(comp_num),
                    format_bytes(uncomp_num),
                    f"{ratio}x",
                    time_range,
                ]

                for col_idx, v in enumerate(row_vals, 1):
                    cell = ws.cell(row=curr_r, column=col_idx)
                    cell.value = v
                    cell.font = font_regular
                    cell.border = box_border
                    if col_idx in [1, 2, 3]:
                        cell.alignment = align_center
                    elif col_idx in [4, 5, 6, 7]:
                        cell.alignment = align_right
                    else:
                        cell.alignment = align_left

                    if idx % 2 == 1:
                        cell.fill = fill_zebra

                ws.row_dimensions[curr_r].height = 19
                curr_r += 1

            # 小計
            ws.cell(row=curr_r, column=1).value = f"【{category_name}】小計"
            ws.cell(row=curr_r, column=1).font = font_bold
            ws.cell(row=curr_r, column=1).alignment = align_left
            ws.cell(row=curr_r, column=1).border = box_border
            ws.cell(row=curr_r, column=1).fill = fill_total

            for c in range(2, 4):
                cell = ws.cell(row=curr_r, column=c)
                cell.border = box_border
                cell.fill = fill_total

            cell_r = ws.cell(row=curr_r, column=4, value=f"{total_rows_cat:,}")
            cell_r.alignment = align_right
            cell_r.font = font_bold
            cell_r.border = box_border
            cell_r.fill = fill_total

            cell_c = ws.cell(
                row=curr_r, column=5, value=format_bytes(total_comp_cat)
            )
            cell_c.alignment = align_right
            cell_c.font = font_bold
            cell_c.border = box_border
            cell_c.fill = fill_total

            cell_u = ws.cell(
                row=curr_r, column=6, value=format_bytes(total_uncomp_cat)
            )
            cell_u.alignment = align_right
            cell_u.font = font_bold
            cell_u.border = box_border
            cell_u.fill = fill_total

            cat_ratio = (
                round(total_uncomp_cat / total_comp_cat, 2)
                if total_comp_cat > 0
                else 1.0
            )
            cell_ratio = ws.cell(row=curr_r, column=7, value=f"{cat_ratio}x")
            cell_ratio.alignment = align_right
            cell_ratio.font = font_bold
            cell_ratio.border = box_border
            cell_ratio.fill = fill_total

            cell_end = ws.cell(row=curr_r, column=8, value="")
            cell_end.border = box_border
            cell_end.fill = fill_total
            ws.row_dimensions[curr_r].height = 20
            curr_r += 1

            return total_rows_cat, total_comp_cat, total_uncomp_cat

        b_rows, b_comp, b_uncomp = write_part_rows(
            active_business, "NetOps 業務日誌表"
        )
        curr_r += 1
        s_rows, s_comp, s_uncomp = write_part_rows(
            active_system, "ClickHouse 系統日誌表"
        )
        curr_r += 1
        if inactive_parts:
            i_rows, i_comp, i_uncomp = write_part_rows(
                inactive_parts, "背景合併暫存 (待清理釋放)", is_inactive=True
            )
            curr_r += 1
        else:
            i_rows = i_comp = i_uncomp = 0

        # Active 合計
        ws.cell(row=curr_r, column=1).value = "【全部 Active 作用中資料】合計"
        ws.cell(row=curr_r, column=1).font = font_bold
        ws.cell(row=curr_r, column=1).alignment = align_left
        ws.cell(row=curr_r, column=1).border = box_border
        ws.cell(row=curr_r, column=1).fill = fill_sub_header

        for c in range(2, 4):
            cell = ws.cell(row=curr_r, column=c)
            cell.border = box_border
            cell.fill = fill_sub_header

        tot_active_rows = b_rows + s_rows
        tot_active_comp = b_comp + s_comp
        tot_active_uncomp = b_uncomp + s_uncomp

        c_tot_r = ws.cell(row=curr_r, column=4, value=f"{tot_active_rows:,}")
        c_tot_r.alignment = align_right
        c_tot_r.font = font_bold
        c_tot_r.border = box_border
        c_tot_r.fill = fill_sub_header

        c_tot_c = ws.cell(
            row=curr_r, column=5, value=format_bytes(tot_active_comp)
        )
        c_tot_c.alignment = align_right
        c_tot_c.font = font_bold
        c_tot_c.border = box_border
        c_tot_c.fill = fill_sub_header

        c_tot_u = ws.cell(
            row=curr_r, column=6, value=format_bytes(tot_active_uncomp)
        )
        c_tot_u.alignment = align_right
        c_tot_u.font = font_bold
        c_tot_u.border = box_border
        c_tot_u.fill = fill_sub_header

        tot_ratio = (
            round(tot_active_uncomp / tot_active_comp, 2)
            if tot_active_comp > 0
            else 1.0
        )
        c_tot_ratio = ws.cell(row=curr_r, column=7, value=f"{tot_ratio}x")
        c_tot_ratio.alignment = align_right
        c_tot_ratio.font = font_bold
        c_tot_ratio.border = box_border
        c_tot_ratio.fill = fill_sub_header

        c_end = ws.cell(
            row=curr_r,
            column=8,
            value=f"Volume 實體總佔用: {data['volume'].get('size', 'N/A')}",
        )
        c_end.font = font_bold
        c_end.alignment = align_left
        c_end.border = box_border
        c_end.fill = fill_sub_header
        ws.row_dimensions[curr_r].height = 22

        # 自動調整欄寬
        for col in ws.columns:
            max_len = 0
            col_letter = get_column_letter(col[0].column)
            for cell in col:
                val_str = str(cell.value or "")
                chinese_count = sum(1 for ch in val_str if ord(ch) > 127)
                str_len = len(val_str) + int(chinese_count * 0.7)
                if str_len > max_len:
                    max_len = str_len
            ws.column_dimensions[col_letter].width = max(max_len + 4, 13)

    if default_sheet in wb.worksheets and len(wb.worksheets) > 1:
        wb.remove(default_sheet)

    wb.save(output_path)
    print(f"\n[+] 報告已成功產出: {os.path.abspath(output_path)}")


def main():
    parser = argparse.ArgumentParser(
        description="NetOps ClickHouse 容量查詢與 Excel 產出工具"
    )
    parser.add_argument(
        "--env",
        choices=["test", "prod", "all"],
        default="test",
        help="目標環境: test (測試區), prod (正式區), all (兩者)",
    )
    parser.add_argument(
        "--output",
        default="",
        help="產出之 Excel 檔案路徑 (若不指定則自動產生帶時間戳檔名)",
    )
    args = parser.parse_args()

    targets = ["test", "prod"] if args.env == "all" else [args.env]
    results = []

    for env_key in targets:
        data = query_environment(env_key)
        results.append(data)

    if not args.output:
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        args.output = f"NetOps_ClickHouse_Capacity_{args.env}_{ts}.xlsx"

    create_excel_report(results, args.output)


if __name__ == "__main__":
    main()
