#!/usr/bin/env node
/**
 * Cloudtop server monitor – exposes system stats API and serves dashboard.
 * Host at https://cloudtop.biapps.dev (use reverse proxy + HTTPS in production).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const si = require('systeminformation');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

// Load env from config file if not set (so you don't need to put secrets in systemd).
// Check: ./config/env, ./config/snmp.env, /etc/cloudtop-monitor/env
function loadEnvFile() {
  const dir = __dirname;
  const candidates = [
    path.join(dir, 'config', 'env'),
    path.join(dir, 'config', 'snmp.env'),
    '/etc/cloudtop-monitor/env',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p, 'utf8');
        for (const line of buf.split('\n')) {
          const trimmed = line.replace(/#.*/, '').trim();
          const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
          if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
        break;
      }
    } catch (_) {}
  }
}
loadEnvFile();

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

// --- SNMP devices (optional): SNMP_TARGETS="name:host:port:community,name2:host2:port:community" ---
const SNMP_HISTORY_LEN = 60;
const SNMP_POLL_INTERVAL_MS = 60000;

function parseSnmpTargets(envVal) {
  if (!envVal || typeof envVal !== 'string') return [];
  return envVal.split(',').map((s) => {
    const parts = s.trim().split(':');
    // name:host:port:community or name:host:port:community:ifindex (ifindex = interface, default 1 = first)
    if (parts.length >= 5) return { name: parts[0], host: parts[1], port: parts[2], community: parts[3], ifIndex: parseInt(parts[4], 10) || 1 };
    if (parts.length === 4) return { name: parts[0], host: parts[1], port: parts[2], community: parts[3], ifIndex: 1 };
    if (parts.length === 3) return { name: parts[0], host: parts[0], port: parts[1], community: parts[2], ifIndex: 1 };
    return null;
  }).filter(Boolean);
}

function oidWithIndex(base, ifIndex) {
  return base + '.' + ifIndex;
}

const snmpTargets = parseSnmpTargets(process.env.SNMP_TARGETS);
const snmpDeviceData = new Map(); // name -> { lastSeen, up, sysUpTime, historyIn, historyOut, inRate, outRate }

// Traffic OIDs (append .<ifIndex>). We use 64-bit first, fallback to 32-bit.
// In:  1.3.6.1.2.1.31.1.1.1.6.<i>  (ifHCInOctets)  or  1.3.6.1.2.1.2.2.1.10.<i>  (ifInOctets)
// Out: 1.3.6.1.2.1.31.1.1.1.10.<i> (ifHCOutOctets) or  1.3.6.1.2.1.2.2.1.16.<i> (ifOutOctets)
// Interfaces (names): 1.3.6.1.2.1.2.2.1.2 (ifDescr)
const SNMP_OID_BASES = {
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  ifInOctets: '1.3.6.1.2.1.2.2.1.10',
  ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
};

function parseSnmpValue(line) {
  if (!line) return null;
  // snmpget: "OID = Counter64: 123" or "OID = Timeticks: (123) 1 day, 2:30:00"
  let m = line.match(/(?:Counter32|Counter64|INTEGER|Gauge32|Unsigned32):\s*(\d+)/i);
  if (!m) m = line.match(/Timeticks:\s*\((\d+)\)/i);
  return m ? parseInt(m[1], 10) : null;
}

async function snmpGet(host, port, community, oid) {
  try {
    const { stdout } = await execFileP('snmpget', ['-v2c', '-c', community, '-t', '3', '-r', '1', `${host}:${port}`, oid], { timeout: 8000 });
    const line = (stdout && stdout.split('\n')[0]) || '';
    return parseSnmpValue(line);
  } catch {
    return null;
  }
}

async function pollSnmpDevice(target) {
  const { name, host, port, community, ifIndex = 1 } = target;
  const prev = snmpDeviceData.get(name) || { historyIn: [], historyOut: [], inRate: 0, outRate: 0 };
  const sysUpTime = await snmpGet(host, port, community, SNMP_OID_BASES.sysUpTime);
  const oidInH = oidWithIndex(SNMP_OID_BASES.ifHCInOctets, ifIndex);
  const oidOutH = oidWithIndex(SNMP_OID_BASES.ifHCOutOctets, ifIndex);
  const oidIn = oidWithIndex(SNMP_OID_BASES.ifInOctets, ifIndex);
  const oidOut = oidWithIndex(SNMP_OID_BASES.ifOutOctets, ifIndex);
  let inOctets = await snmpGet(host, port, community, oidInH);
  if (inOctets == null) inOctets = await snmpGet(host, port, community, oidIn);
  let outOctets = await snmpGet(host, port, community, oidOutH);
  if (outOctets == null) outOctets = await snmpGet(host, port, community, oidOut);

  const now = Date.now();
  const up = sysUpTime != null;
  const historyIn = [...(prev.historyIn || [])];
  const historyOut = [...(prev.historyOut || [])];
  if (inOctets != null) {
    historyIn.push({ t: now, v: inOctets });
    if (historyIn.length > SNMP_HISTORY_LEN) historyIn.shift();
  }
  if (outOctets != null) {
    historyOut.push({ t: now, v: outOctets });
    if (historyOut.length > SNMP_HISTORY_LEN) historyOut.shift();
  }

  let inRate = 0;
  let outRate = 0;
  const delta = (b, a) => (b >= a ? b - a : b - a + 0x100000000); // 32-bit wrap
  if (historyIn.length >= 2) {
    const a = historyIn[historyIn.length - 2];
    const b = historyIn[historyIn.length - 1];
    const sec = (b.t - a.t) / 1000;
    inRate = sec > 0 ? delta(b.v, a.v) / sec : 0;
  }
  if (historyOut.length >= 2) {
    const a = historyOut[historyOut.length - 2];
    const b = historyOut[historyOut.length - 1];
    const sec = (b.t - a.t) / 1000;
    outRate = sec > 0 ? delta(b.v, a.v) / sec : 0;
  }

  snmpDeviceData.set(name, {
    lastSeen: now,
    up,
    sysUpTime: sysUpTime != null ? sysUpTime / 100 : null,
    historyIn,
    historyOut,
    inRate,
    outRate,
  });
}

async function pollAllSnmp() {
  for (const target of snmpTargets) {
    try {
      await pollSnmpDevice(target);
    } catch (err) {
      console.error('SNMP poll error', target.name, err.message);
    }
  }
}

/**
 * GET /api/snmp-walk – run snmpwalk for a configured target (debug). Query: name=<targetName>&oid=<optional OID>
 */
app.get('/api/snmp-walk', async (req, res) => {
  const name = req.query.name;
  const oid = req.query.oid || '1.3.6.1.2.1.2.2.1';
  const target = snmpTargets.find((t) => t.name === name);
  if (!target) {
    return res.status(400).json({ error: 'Unknown target name. Use one of: ' + snmpTargets.map((t) => t.name).join(', ') });
  }
  try {
    const { stdout, stderr } = await execFileP(
      'snmpwalk',
      ['-v2c', '-c', target.community, '-t', '5', '-r', '1', `${target.host}:${target.port}`, oid],
      { timeout: 15000, maxBuffer: 1024 * 1024 }
    );
    res.type('text/plain').send((stdout || '') + (stderr ? '\n' + stderr : ''));
  } catch (err) {
    const out = err.stdout || '';
    const errout = err.stderr || '';
    res.status(500).type('text/plain').send('Error: ' + (err.message || err) + (out ? '\n\nstdout:\n' + out : '') + (errout ? '\n\nstderr:\n' + errout : ''));
  }
});

/**
 * GET /api/snmp-get – run snmpget for the OIDs we use (debug). Query: name=<targetName>
 */
app.get('/api/snmp-get', async (req, res) => {
  const name = req.query.name;
  const target = snmpTargets.find((t) => t.name === name);
  if (!target) {
    return res.status(400).json({ error: 'Unknown target name. Use one of: ' + snmpTargets.map((t) => t.name).join(', ') });
  }
  const { host, port, community, ifIndex = 1 } = target;
  const oids = [
    [SNMP_OID_BASES.sysUpTime, 'sysUpTime'],
    [oidWithIndex(SNMP_OID_BASES.ifHCInOctets, ifIndex), 'ifHCInOctets.' + ifIndex],
    [oidWithIndex(SNMP_OID_BASES.ifHCOutOctets, ifIndex), 'ifHCOutOctets.' + ifIndex],
    [oidWithIndex(SNMP_OID_BASES.ifInOctets, ifIndex), 'ifInOctets.' + ifIndex],
    [oidWithIndex(SNMP_OID_BASES.ifOutOctets, ifIndex), 'ifOutOctets.' + ifIndex],
  ];
  const lines = [];
  for (const [oid, label] of oids) {
    try {
      const v = await snmpGet(host, port, community, oid);
      lines.push(label + ' (' + oid + '): ' + (v != null ? v : 'FAIL'));
    } catch (e) {
      lines.push(label + ' (' + oid + '): ERROR ' + e.message);
    }
  }
  res.type('text/plain').send(lines.join('\n'));
});

/**
 * GET /api/snmp-devices – list SNMP devices with history for graphs.
 */
app.get('/api/snmp-devices', (_req, res) => {
  const now = Date.now();
  const STALE_MS = 5 * 60 * 1000;
  const devices = snmpTargets.map((t) => {
    const d = snmpDeviceData.get(t.name);
    if (!d) return { ...t, lastSeen: 0, up: false, sysUpTime: null, historyIn: [], historyOut: [], inRate: 0, outRate: 0, stale: true };
    return {
      name: t.name,
      host: t.host,
      port: t.port,
      community: t.community,
      lastSeen: d.lastSeen,
      up: d.up,
      sysUpTime: d.sysUpTime,
      historyIn: d.historyIn || [],
      historyOut: d.historyOut || [],
      inRate: d.inRate,
      outRate: d.outRate,
      stale: now - d.lastSeen > STALE_MS,
    };
  });
  res.json({ devices });
});

/**
 * GET /api/snmp-debug – plain text dump of what we have per device + live snmpget from this host.
 */
app.get('/api/snmp-debug', async (_req, res) => {
  const lines = [];
  for (const t of snmpTargets) {
    const d = snmpDeviceData.get(t.name);
    lines.push('--- ' + t.name + ' (' + t.host + ':' + t.port + ' ifIndex=' + (t.ifIndex || 1) + ') ---');
    if (!d) {
      lines.push('  No data yet (poll may have failed or not run).');
    } else {
      const nin = (d.historyIn && d.historyIn.length) || 0;
      const nout = (d.historyOut && d.historyOut.length) || 0;
      lines.push('  lastSeen: ' + new Date(d.lastSeen).toISOString());
      lines.push('  up: ' + d.up + ', sysUpTime: ' + d.sysUpTime);
      lines.push('  historyIn: ' + nin + ' points, historyOut: ' + nout + ' points');
      lines.push('  inRate: ' + d.inRate + ' B/s, outRate: ' + d.outRate + ' B/s');
      if (nin >= 1) {
        const last = d.historyIn[d.historyIn.length - 1];
        lines.push('  last in value: ' + last.v + ' at ' + new Date(last.t).toISOString());
      }
      if (nout >= 1) {
        const last = d.historyOut[d.historyOut.length - 1];
        lines.push('  last out value: ' + last.v + ' at ' + new Date(last.t).toISOString());
      }
      if (nin >= 2) {
        const a = d.historyIn[d.historyIn.length - 2];
        const b = d.historyIn[d.historyIn.length - 1];
        lines.push('  in delta (last 2): ' + (b.v - a.v) + ' bytes in ' + ((b.t - a.t) / 1000) + ' s');
      }
    }
    lines.push('  Live snmpget from this host (right now):');
    const ifIndex = t.ifIndex || 1;
    const oidIn = oidWithIndex(SNMP_OID_BASES.ifHCInOctets, ifIndex);
    try {
      const { stdout, stderr } = await execFileP('snmpget', ['-v2c', '-c', t.community, '-t', '5', '-r', '1', `${t.host}:${t.port}`, oidIn], { timeout: 8000 });
      const line = (stdout && stdout.split('\n')[0]) || '';
      const parsed = parseSnmpValue(line);
      lines.push('    stdout: ' + (line || '(empty)'));
      lines.push('    parsed: ' + (parsed != null ? parsed : 'NULL'));
    } catch (err) {
      lines.push('    error: ' + (err.message || err));
      if (err.stdout) lines.push('    stdout: ' + String(err.stdout).slice(0, 200));
      if (err.stderr) lines.push('    stderr: ' + String(err.stderr).slice(0, 200));
    }
    lines.push('');
  }
  res.type('text/plain').send(lines.length ? lines.join('\n') : 'No SNMP targets configured.\n');
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
  if (snmpTargets.length > 0) {
    setTimeout(() => pollAllSnmp(), 2000);
    setInterval(pollAllSnmp, SNMP_POLL_INTERVAL_MS);
    console.log(`SNMP targets: ${snmpTargets.length} (poll every ${SNMP_POLL_INTERVAL_MS / 1000}s)`);
  }
});
