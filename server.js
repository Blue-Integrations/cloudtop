#!/usr/bin/env node
/**
 * Cloudtop server monitor – exposes system stats API and serves dashboard.
 * Host at https://cloudtop.biapps.dev (use reverse proxy + HTTPS in production).
 */

const express = require('express');
const path = require('path');
const os = require('os');
const si = require('systeminformation');

const app = express();
const PORT = process.env.PORT || 3000;

// Optional basic auth (set MONITOR_USER and MONITOR_PASS in production)
const AUTH_USER = process.env.MONITOR_USER;
const AUTH_PASS = process.env.MONITOR_PASS;

function authMiddleware(req, res, next) {
  if (!AUTH_USER || !AUTH_PASS) return next();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Cloudtop Monitor"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (user !== AUTH_USER || pass !== AUTH_PASS) {
    return res.status(401).send('Invalid credentials');
  }
  next();
}

app.use(express.json({ limit: '256kb' }));
app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store: server name -> { lastSeen (ms), stats }
const serverStats = new Map();
const STALE_MS = 10 * 60 * 1000; // consider stale after 10 min

function normalizeReport(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : null;
  if (!name) return null;
  return {
    name,
    cpu: body.cpu && typeof body.cpu.usagePercent === 'number' ? body.cpu : null,
    memory: body.memory && typeof body.memory.usedPercent === 'number' ? body.memory : null,
    disk: body.disk && typeof body.disk.usedPercent === 'number' ? body.disk : null,
    load: body.load && typeof body.load.load1 === 'number' ? body.load : null,
    uptime: body.uptime && typeof body.uptime.seconds === 'number' ? body.uptime : null,
    network: body.network && typeof body.network === 'object' ? { rx_sec: Number(body.network.rx_sec) || 0, tx_sec: Number(body.network.tx_sec) || 0, rx_bytes: body.network.rx_bytes, tx_bytes: body.network.tx_bytes } : null,
    timestamp: body.timestamp || new Date().toISOString(),
  };
}

/**
 * POST /api/report – receive stats from a monitored system (body: { name, cpu, memory, disk, load, uptime, network, timestamp }).
 */
app.post('/api/report', (req, res) => {
  const report = normalizeReport(req.body);
  if (!report) {
    return res.status(400).json({ error: 'Invalid report: "name" and stats (cpu.usagePercent, memory.usedPercent, etc.) required' });
  }
  serverStats.set(report.name, { lastSeen: Date.now(), stats: report });
  res.json({ ok: true, name: report.name });
});

/**
 * GET /api/servers – list all servers with latest stats (for dashboard).
 */
app.get('/api/servers', (_req, res) => {
  const now = Date.now();
  const servers = Array.from(serverStats.entries()).map(([name, { lastSeen, stats }]) => ({
    name,
    lastSeen,
    stale: now - lastSeen > STALE_MS,
    stats: {
      cpu: stats.cpu,
      memory: stats.memory,
      disk: stats.disk,
      load: stats.load,
      uptime: stats.uptime,
      network: stats.network,
      timestamp: stats.timestamp,
    },
  }));
  res.json({ servers: servers.sort((a, b) => a.name.localeCompare(b.name)) });
});

async function getLocalStats() {
  const [
    cpu,
    currentLoad,
    mem,
    fsSize,
    time,
    networkStats,
    diskIO,
  ] = await Promise.all([
    si.cpu(),
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.time(),
    si.networkStats(),
    si.disksIO().catch(() => ({ rIO_sec: 0, wIO_sec: 0 })),
  ]);
  const [load1, load5, load15] = os.loadavg();
  const totalDisk = fsSize.reduce((acc, fs) => acc + fs.size, 0);
  const usedDisk = fsSize.reduce((acc, fs) => acc + fs.used, 0);
  const diskUsagePercent = totalDisk > 0 ? (usedDisk / totalDisk) * 100 : 0;
  const net = networkStats[0] || {};
  const diskIo = Array.isArray(diskIO) ? diskIO[0] : diskIO;
  return {
    cpu: {
      cores: cpu.cores,
      physicalCores: cpu.physicalCores,
      brand: cpu.brand,
      speed: cpu.speed,
      usagePercent: Math.round(currentLoad.currentLoad * 100) / 100,
      userPercent: Math.round(currentLoad.currentLoadUser * 100) / 100,
      systemPercent: Math.round(currentLoad.currentLoadSystem * 100) / 100,
    },
    memory: {
      total: mem.total,
      used: mem.used,
      free: mem.free,
      usedPercent: Math.round((mem.used / mem.total) * 10000) / 100,
      swapTotal: mem.swaptotal,
      swapUsed: mem.swapused,
      swapFree: mem.swapfree,
    },
    disk: {
      total: totalDisk,
      used: usedDisk,
      free: totalDisk - usedDisk,
      usedPercent: Math.round(diskUsagePercent * 100) / 100,
      mounts: fsSize.map((f) => ({ fs: f.fs, mount: f.mount, size: f.size, used: f.used, usePercent: f.use })),
      readSec: (diskIo && diskIo.rIO_sec) || 0,
      writeSec: (diskIo && diskIo.wIO_sec) || 0,
    },
    load: { load1, load5, load15 },
    uptime: { seconds: time.uptime, since: new Date(Date.now() - time.uptime * 1000).toISOString() },
    network: { rx_sec: net.rx_sec ?? 0, tx_sec: net.tx_sec ?? 0, rx_bytes: net.rx_bytes ?? 0, tx_bytes: net.tx_bytes ?? 0 },
    timestamp: new Date().toISOString(),
  };
}

/**
 * GET /api/stats – current system statistics (single-host; used by agent to get payload shape).
 */
app.get('/api/stats', async (_req, res) => {
  try {
    const stats = await getLocalStats();
    res.json(stats);
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to collect system stats', message: err.message });
  }
});

/**
 * GET /api/health – minimal health check for load balancers.
 */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

const LOCAL_SERVER_NAME = process.env.LOCAL_SERVER_NAME || '';

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cloudtop monitor listening on 0.0.0.0:${PORT}`);
  if (AUTH_USER) console.log('Basic auth enabled');
  if (LOCAL_SERVER_NAME) {
    const pushLocal = () => {
      getLocalStats()
        .then((stats) => {
          const report = { name: LOCAL_SERVER_NAME, ...stats };
          serverStats.set(LOCAL_SERVER_NAME, { lastSeen: Date.now(), stats: report });
        })
        .catch((err) => console.error('Local report error:', err));
    };
    pushLocal();
    setInterval(pushLocal, 60000); // every 60s
  }
});
