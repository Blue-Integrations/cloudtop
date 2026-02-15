# Start Cloudtop at boot (systemd)

## Dashboard (central server)

1. Copy the service file and enable it:

   ```bash
   sudo cp /var/www/html/cloudtop/systemd/cloudtop-dashboard.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable cloudtop-dashboard.service
   sudo systemctl start cloudtop-dashboard.service
   ```

2. Optional: edit the unit to set env vars (e.g. `LOCAL_SERVER_NAME`, `MONITOR_USER`, `MONITOR_PASS`):

   ```bash
   sudo systemctl edit --full cloudtop-dashboard.service
   # Add or uncomment Environment= lines, then:
   sudo systemctl daemon-reload
   sudo systemctl restart cloudtop-dashboard.service
   ```

3. Check status:

   ```bash
   sudo systemctl status cloudtop-dashboard.service
   ```

## Agent (on each monitored server)

Run the agent on any host that should appear as a card on the dashboard (including the same machine as the dashboard).

1. Copy the service file:

   ```bash
   sudo cp /var/www/html/cloudtop/systemd/cloudtop-agent.service /etc/systemd/system/
   ```

2. **Edit the unit** to set your dashboard URL and optional server name:

   ```bash
   sudo systemctl edit --full cloudtop-agent.service
   ```

   Set at least:

   - `Environment=SERVER_NAME=web-01`   (or whatever name you want on the dashboard)
   - `Environment=DASHBOARD_URL=https://cloudtop.biapps.dev/api/report`   (your real dashboard URL)

   If the dashboard uses basic auth, add:

   - `Environment=DASHBOARD_USER=admin`
   - `Environment=DASHBOARD_PASS=your-password`

   `INTERVAL_SEC=60` makes it report every 60 seconds (already set in the unit).

3. Enable and start:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable cloudtop-agent.service
   sudo systemctl start cloudtop-agent.service
   ```

4. Check status:

   ```bash
   sudo systemctl status cloudtop-agent.service
   ```

## Useful commands

| Action | Dashboard | Agent |
|--------|-----------|--------|
| Start | `sudo systemctl start cloudtop-dashboard` | `sudo systemctl start cloudtop-agent` |
| Stop | `sudo systemctl stop cloudtop-dashboard` | `sudo systemctl stop cloudtop-agent` |
| Restart | `sudo systemctl restart cloudtop-dashboard` | `sudo systemctl restart cloudtop-agent` |
| Status | `sudo systemctl status cloudtop-dashboard` | `sudo systemctl status cloudtop-agent` |
| Logs | `journalctl -u cloudtop-dashboard -f` | `journalctl -u cloudtop-agent -f` |

After `enable`, both will start automatically at boot.
