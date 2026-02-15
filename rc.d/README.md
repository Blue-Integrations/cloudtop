# FreeBSD / OPNsense rc.d service (Cloudtop agent)

Use this when cron is not reliable (e.g. OPNsense overwrites crontab). The agent runs as a service, starts at boot, and reports every 60 seconds.

## 1. Install the script

Copy the script into the local rc.d directory and make it executable:

```bash
cp /var/www/html/cloudtop/rc.d/cloudtop_agent /usr/local/etc/rc.d/cloudtop_agent
chmod 755 /usr/local/etc/rc.d/cloudtop_agent
```

If the agent and Python live elsewhere (e.g. on another partition), copy `agent.py` and the `psutil` dependency there and set `cloudtop_agent_dir` and `cloudtop_agent_python` in step 2.

## 2. Configure in rc.conf

Create or edit `/etc/rc.conf.local` (OPNsense may use a different override file; use the one that is not overwritten by the system) and add:

```sh
cloudtop_agent_enable="YES"
cloudtop_agent_server_name="opnsense"
cloudtop_agent_dashboard_url="https://cloudtop.biapps.dev/api/report"
cloudtop_agent_interval_sec="60"
```

Optional:

- `cloudtop_agent_dir="/path/to/cloudtop"` – directory containing `agent.py` (default: `/var/www/html/cloudtop`)
- `cloudtop_agent_python="/usr/local/bin/python3.9"` – Python interpreter (default: `/usr/local/bin/python3`)
- `cloudtop_agent_user="admin"` and `cloudtop_agent_pass="secret"` – if the dashboard uses basic auth

Or set everything in one go with a custom env string (overrides the vars above):

```sh
cloudtop_agent_enable="YES"
cloudtop_agent_env="SERVER_NAME=opnsense DASHBOARD_URL=https://cloudtop.biapps.dev/api/report INTERVAL_SEC=60"
```

## 3. Install Python dependency

On the box where the agent runs (e.g. OPNsense), ensure Python 3 and psutil are installed:

```bash
pkg install python3 py39-psutil
# or: pip install psutil
```

If `agent.py` is not in `/var/www/html/cloudtop`, set `cloudtop_agent_dir` to the directory that contains `agent.py`.

## 4. Start and enable at boot

```bash
service cloudtop_agent start
service cloudtop_agent enable
```

Enable writes to `rc.conf` (or the appropriate OPNsense config) so the service starts on boot.

## Commands

| Action  | Command |
|---------|---------|
| Start   | `service cloudtop_agent start` |
| Stop    | `service cloudtop_agent stop` |
| Restart | `service cloudtop_agent restart` |
| Status  | `service cloudtop_agent status` |

## OPNsense notes

- Use the config file that OPNsense does **not** overwrite (e.g. a custom rc.conf snippet or the GUI if it supports custom services). If everything is in `rc.conf` and OPNsense rewrites it, put only your `cloudtop_agent_*` lines in a file that is included from `rc.conf` (e.g. `rc.conf.local`) and that the system does not overwrite.
- If Python/psutil are not available as packages, install them via pip or a custom package, and set `cloudtop_agent_python` to the full path to that interpreter.
- The script uses `REQUIRE: NETWORK` so the agent starts after the network is up, which is suitable for a firewall/router.
