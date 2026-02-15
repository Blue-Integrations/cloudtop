#!/usr/bin/env node
/**
 * Cloudtop agent – run on each monitored server to push stats to the central dashboard.
 * Usage:
 *   SERVER_NAME=web-01 DASHBOARD_URL=https://cloudtop.biapps.dev/api/report node agent.js
 *   # Or run once: node agent.js
 *   # With basic auth: DASHBOARD_USER=admin DASHBOARD_PASS=secret node agent.js
 * Run via cron every 1–2 min or as a loop (default: report once and exit).
 */

const os = require('os');
const si = require('systeminformation');
const https = require('https');
const http = require('http');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000/api/report';
const SERVER_NAME = process.env.SERVER_NAME || os.hostname();
const INTERVAL_SEC = process.env.INTERVAL_SEC ? parseInt(process.env.INTERVAL_SEC, 10) : 0; // 0 = run once
const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || '';

async function getStats() {
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
    name: SERVER_NAME,
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
    network: {
      rx_sec: net.rx_sec ?? 0,
      tx_sec: net.tx_sec ?? 0,
      rx_bytes: net.rx_bytes ?? 0,
      tx_bytes: net.tx_bytes ?? 0,
    },
    timestamp: new Date().toISOString(),
  };
}

function postReport(body) {
  return new Promise((resolve, reject) => {
    const u = new URL(DASHBOARD_URL);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    if (DASHBOARD_USER && DASHBOARD_PASS) {
      opts.headers.Authorization = 'Basic ' + Buffer.from(DASHBOARD_USER + ':' + DASHBOARD_PASS).toString('base64');
    }
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (ch) => (data += ch));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  try {
    const stats = await getStats();
    await postReport(stats);
    console.log(new Date().toISOString(), SERVER_NAME, 'reported');
  } catch (err) {
    console.error(new Date().toISOString(), SERVER_NAME, err.message);
    process.exitCode = 1;
  }
}

(async () => {
  if (INTERVAL_SEC > 0) {
    await run();
    setInterval(run, INTERVAL_SEC * 1000);
  } else {
    await run();
  }
})();
