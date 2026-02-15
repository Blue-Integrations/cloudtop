#!/usr/bin/env python3
"""
Cloudtop agent for FreeBSD (and Linux) – reports system stats to the central dashboard.
Uses psutil for cross-platform metrics.

Usage:
  SERVER_NAME=web-01 DASHBOARD_URL=https://cloudtop.biapps.dev/api/report python3 agent.py
  # Or run once (default):
  python3 agent.py
  # With basic auth:
  DASHBOARD_USER=admin DASHBOARD_PASS=secret python3 agent.py
  # Report every 60 seconds (loop):
  INTERVAL_SEC=60 python3 agent.py

Run via cron on FreeBSD: add to crontab or use /usr/local/etc/rc.d/
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

try:
    import psutil
except ImportError:
    print("psutil required. Install with: pip install psutil", file=sys.stderr)
    sys.exit(1)

IS_FREEBSD = sys.platform.startswith("freebsd")


def _cpu_percent_freebsd():
    """CPU usage on FreeBSD via kern.cp_time (avoids psutil bugs). Two samples, delta, then (total-idle)/total*100."""
    try:
        out1 = subprocess.run(
            ["sysctl", "-n", "kern.cp_time"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if out1.returncode != 0 or not out1.stdout:
            return None
        time.sleep(0.25)
        out2 = subprocess.run(
            ["sysctl", "-n", "kern.cp_time"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if out2.returncode != 0 or not out2.stdout:
            return None
        # Format: "user nice sys interrupt idle" (clock ticks)
        nums1 = [int(x) for x in out1.stdout.strip().split()]
        nums2 = [int(x) for x in out2.stdout.strip().split()]
        if len(nums1) != 5 or len(nums2) != 5:
            return None
        total = sum(nums2[i] - nums1[i] for i in range(5))
        if total <= 0:
            return 0.0
        idle_delta = nums2[4] - nums1[4]  # idle is 5th (index 4)
        used = total - idle_delta
        return min(100.0, max(0.0, 100.0 * used / total))
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError, OSError):
        return None


DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "http://127.0.0.1:3000/api/report")
SERVER_NAME = os.environ.get("SERVER_NAME", "")
if not SERVER_NAME:
    SERVER_NAME = os.uname().nodename
INTERVAL_SEC = int(os.environ.get("INTERVAL_SEC", "0") or "0")
DASHBOARD_USER = os.environ.get("DASHBOARD_USER", "")
DASHBOARD_PASS = os.environ.get("DASHBOARD_PASS", "")


def get_stats():
    cpu_count = psutil.cpu_count()
    cpu_count_phys = psutil.cpu_count(logical=False) or cpu_count

    # Memory
    mem = psutil.virtual_memory()
    mem_used_pct = (mem.used / mem.total * 100) if mem.total else 0
    swap = psutil.swap_memory()

    # Disk (aggregate all mounted partitions)
    total_disk = 0
    used_disk = 0
    mounts = []
    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
            total_disk += usage.total
            used_disk += usage.used
            mounts.append({
                "fs": part.fstype or "",
                "mount": part.mountpoint,
                "size": usage.total,
                "used": usage.used,
                "usePercent": round(usage.percent, 2),
            })
        except (PermissionError, OSError):
            continue
    disk_used_pct = (used_disk / total_disk * 100) if total_disk else 0

    # Load average (FreeBSD and Linux)
    try:
        load1, load5, load15 = os.getloadavg()
    except OSError:
        load1 = load5 = load15 = 0.0

    # Uptime
    boot_time = psutil.boot_time()
    uptime_seconds = time.time() - boot_time
    uptime_since = datetime.fromtimestamp(boot_time, tz=timezone.utc).isoformat()

    # Network bytes per second (sample over 1 second)
    net_before = psutil.net_io_counters()
    time.sleep(1)
    net_after = psutil.net_io_counters()
    rx_sec = max(0, net_after.bytes_recv - net_before.bytes_recv)
    tx_sec = max(0, net_after.bytes_sent - net_before.bytes_sent)

    # CPU: on FreeBSD use kern.cp_time (psutil often reports 100% or hangs). On Linux use psutil.
    if IS_FREEBSD:
        cpu_percent = _cpu_percent_freebsd()
        if cpu_percent is None:
            cpu_percent = 0.0
    else:
        try:
            per_cpu = psutil.cpu_percent(interval=0.3, percpu=True)
            cpu_percent = min(100.0, sum(per_cpu) / len(per_cpu)) if per_cpu else 0.0
        except Exception:
            cpu_percent = 0.0

    return {
        "name": SERVER_NAME,
        "cpu": {
            "cores": cpu_count,
            "physicalCores": cpu_count_phys,
            "brand": "",
            "speed": 0,
            "usagePercent": round(cpu_percent, 2),
            "userPercent": round(cpu_percent, 2),
            "systemPercent": 0,
        },
        "memory": {
            "total": mem.total,
            "used": mem.used,
            "free": mem.free,
            "usedPercent": round(mem_used_pct, 2),
            "swapTotal": swap.total,
            "swapUsed": swap.used,
            "swapFree": swap.free,
        },
        "disk": {
            "total": total_disk,
            "used": used_disk,
            "free": total_disk - used_disk,
            "usedPercent": round(disk_used_pct, 2),
            "mounts": mounts,
            "readSec": 0,
            "writeSec": 0,
        },
        "load": {"load1": load1, "load5": load5, "load15": load15},
        "uptime": {"seconds": uptime_seconds, "since": uptime_since},
        "network": {
            "rx_sec": rx_sec,
            "tx_sec": tx_sec,
            "rx_bytes": net_after.bytes_recv,
            "tx_bytes": net_after.bytes_sent,
        },
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def post_report(payload):
    data = json.dumps(payload).encode("utf-8")
    req = Request(
        DASHBOARD_URL,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    if DASHBOARD_USER and DASHBOARD_PASS:
        import base64
        creds = base64.b64encode(f"{DASHBOARD_USER}:{DASHBOARD_PASS}".encode()).decode()
        req.add_header("Authorization", f"Basic {creds}")
    try:
        with urlopen(req, timeout=30) as resp:
            if 200 <= resp.status < 300:
                return True
            raise RuntimeError(f"HTTP {resp.status}")
    except (URLError, HTTPError) as e:
        code = getattr(e, "code", None)
        raise RuntimeError(f"HTTP {code or e}")


def main():
    try:
        payload = get_stats()
        post_report(payload)
        print(f"{datetime.now().isoformat()} {SERVER_NAME} reported")
    except Exception as e:
        print(f"{datetime.now().isoformat()} {SERVER_NAME} error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
    if INTERVAL_SEC > 0:
        while True:
            time.sleep(INTERVAL_SEC)
            main()
