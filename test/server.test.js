const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Prevent local configuration files from changing the server under test.
process.env.MONITOR_USER = 'test-user';
process.env.MONITOR_PASS = 'test-pass';
process.env.SNMP_TARGETS = '';
process.env.LOCAL_SERVER_NAME = '';
const app = require('../server');
let server;
let base;
const authorization = 'Basic ' + Buffer.from('test-user:test-pass').toString('base64');

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server && server.listening) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

function request(path, options = {}) {
  return fetch(base + path, { ...options, headers: { authorization, ...options.headers } });
}

test('authentication protects the dashboard and API', async () => {
  const response = await fetch(base + '/api/health');
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /^Basic /);
  assert.equal((await request('/api/health', { headers: { authorization: 'Basic bad' } })).status, 401);
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const dashboard = await request('/');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-type'), /text\/html/);
});

test('reports are validated, stored, updated and listed in name order', async () => {
  for (const options of [
    { method: 'POST' },
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"  "}' },
  ]) {
    assert.equal((await request('/api/report', options)).status, 400);
  }
  const post = (body) => request('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ name: ' zeta ', cpu: { usagePercent: 12 } })).status, 200);
  assert.equal((await post({ name: 'alpha' })).status, 200);
  assert.equal((await post({ name: 'zeta', cpu: { usagePercent: 34 } })).status, 200);
  const { servers } = await (await request('/api/servers')).json();
  assert.deepEqual(servers.map((entry) => entry.name), ['alpha', 'zeta']);
  assert.equal(servers[1].stats.cpu.usagePercent, 34);
  assert.equal(servers[1].stale, false);
  assert.equal((await request('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
});

test('stats and unconfigured SNMP endpoints respond', async () => {
  const response = await request('/api/stats');
  assert.equal(response.status, 200);
  const stats = await response.json();
  for (const key of ['cpu', 'memory', 'disk', 'load', 'uptime', 'network', 'timestamp']) assert.ok(stats[key], key);
  assert.deepEqual(await (await request('/api/snmp-devices')).json(), { devices: [] });
  assert.equal((await request('/api/snmp-get?name=missing')).status, 400);
  assert.equal((await request('/api/snmp-walk?name=missing')).status, 400);
});
