# Cloudtop Server Monitor

Lightweight **multi-server** monitoring dashboard for **cloudtop.biapps.dev**. Shows 12–15 compact cards per screen (CPU, memory, disk, load, uptime) with server name and status. Multiple systems send their stats to the central dashboard via a small agent.

## What it does

- **Dashboard** – Grid of small cards (one per server): server name, CPU %, Mem %, Disk %, load average, uptime. Status dot: green (fresh), yellow (>1 min), red (stale).
- **Central server** – Accepts reports at `POST /api/report` and serves the aggregated view at `GET /api/servers`.
- **Optional local host** – If this machine should appear in the grid, set `LOCAL_SERVER_NAME`; the app will push its own stats periodically.
- **Agent** – Run `agent.js` (Node) or `agent.py` (Python) on each monitored server (with `SERVER_NAME` and `DASHBOARD_URL`) to push stats; use cron or a loop.

## Quick start

**Central dashboard (this repo):**

```bash
cd /var/www/html/cloudtop
npm install
# Optional: include this host in the grid
export LOCAL_SERVER_NAME=cloudtop
npm start
```

Open `http://localhost:3000`. If no servers have reported yet, you’ll see “No servers reporting yet”.

**On each monitored server (run the agent):**

**Node (Linux, etc.):**
```bash
# Copy this repo (or at least agent.js + node_modules from a clone), then:
SERVER_NAME=web-01 DASHBOARD_URL=https://cloudtop.biapps.dev/api/report node agent.js
```

**Python (FreeBSD, Linux):**
```bash
pip install -r requirements-agent.txt   # or: pip install psutil
SERVER_NAME=web-01 DASHBOARD_URL=https://cloudtop.biapps.dev/api/report python3 agent.py
```

- Run once: `node agent.js` or `python3 agent.py` (exits after one report).
- Run every 60s: `INTERVAL_SEC=60 node agent.js` or `INTERVAL_SEC=60 python3 agent.py` (stays running).
- Or cron: `* * * * * cd /path/to/cloudtop && SERVER_NAME=web-01 DASHBOARD_URL=... node agent.js` (or `python3 agent.py`).

If the dashboard uses basic auth, set `DASHBOARD_USER` and `DASHBOARD_PASS` when running the agent.

## Production (cloudtop.biapps.dev)

1. **Reverse proxy** – Proxy `https://cloudtop.biapps.dev` to `http://127.0.0.1:3000` with HTTPS (e.g. Let’s Encrypt).
2. **Optional basic auth** – Set `MONITOR_USER` and `MONITOR_PASS` to protect the UI; use `DASHBOARD_USER` / `DASHBOARD_PASS` on agents.
3. **Process manager** – Run the dashboard under PM2 or systemd. Run the agent on each host via cron or PM2.

### Nginx reverse proxy

1. **Install Nginx** (if needed) and create a server block, e.g. `/etc/nginx/sites-available/cloudtop` or under `conf.d/`:

```nginx
server {
    listen 80;
    server_name cloudtop.biapps.dev;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

2. **Enable the site** and reload Nginx:

```bash
# Debian/Ubuntu
sudo ln -s /etc/nginx/sites-available/cloudtop /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Or copy to conf.d and reload
sudo nginx -t && sudo systemctl reload nginx
```

3. **HTTPS with Let’s Encrypt** (Certbot):

```bash
sudo apt install certbot python3-certbot-nginx   # or: certbot --nginx
sudo certbot --nginx -d cloudtop.biapps.dev
```

Certbot will add a `listen 443 ssl` server block and redirect HTTP→HTTPS. Ensure DNS for `cloudtop.biapps.dev` points to this host before running certbot.

4. **Optional: basic auth at Nginx** (instead of in the Node app):

```bash
sudo apt install apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd-cloudtop admin
```

Add to the `location /` block (inside the `server` that has `listen 443 ssl`):

```nginx
    auth_basic "Cloudtop Monitor";
    auth_basic_user_file /etc/nginx/.htpasswd-cloudtop;
```

Then reload Nginx. Agents must use the same credentials in `DASHBOARD_USER` and `DASHBOARD_PASS`.

## Environment variables

**Dashboard (server.js):**

| Variable             | Description                                      |
|----------------------|--------------------------------------------------|
| `PORT`               | HTTP port (default `3000`)                       |
| `MONITOR_USER`       | Basic auth username (optional)                   |
| `MONITOR_PASS`       | Basic auth password (optional)                   |
| `LOCAL_SERVER_NAME`  | If set, this host’s stats are pushed into the grid |

**Agent (agent.js / agent.py):**

| Variable          | Description                                           |
|-------------------|-------------------------------------------------------|
| `SERVER_NAME`     | Name shown on the dashboard (default: hostname)       |
| `DASHBOARD_URL`   | Full URL to report endpoint (e.g. `https://.../api/report`) |
| `INTERVAL_SEC`    | If > 0, report every N seconds (default: 0 = once)   |
| `DASHBOARD_USER`  | Basic auth user for dashboard (optional)              |
| `DASHBOARD_PASS`  | Basic auth password (optional)                        |

The Python agent (`agent.py`) uses **psutil** and works on FreeBSD and Linux. Install with `pip install psutil` or `pip install -r requirements-agent.txt`.

## API

- **POST /api/report** – Body: `{ name, cpu, memory, disk, load, uptime, network, timestamp }` (same shape as GET /api/stats plus `name`). Stores latest report per name.
- **GET /api/servers** – Returns `{ servers: [ { name, lastSeen, stale, stats }, ... ] }` for the dashboard.
- **GET /api/stats** – Single-host stats (same shape as report body minus `name`); used by the agent or for debugging.
- **GET /api/health** – `{ "ok": true, "time": "..." }` for health checks.

No database required; state is in memory (report per server name).
