// Run against a published directory. Starts an isolated copy on a free loopback port.
// Never executes external probes or changes the user's running agent.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const input = process.argv[2];
if (!input) throw new Error('Usage: node tests/integration.mjs <published-directory>');
const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'lanvibes-integration-'));
await fs.cp(path.resolve(input), destination, { recursive: true });
const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const configPath = path.join(destination, 'diagnostics.json');
const config = JSON.parse(await fs.readFile(configPath)); config.port = port; config.portalUrl = null;
config.targets.push({ id: 'custom', name: 'Configured local fixture', url: 'https://127.0.0.1:1/', corporate: false });
await fs.writeFile(configPath, JSON.stringify(config));
const processHandle = spawn('dotnet', [path.join(destination, 'LanVibes.DnsAgent.dll'), '--headless'], { cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; processHandle.stdout.on('data', b => { log += b; }); processHandle.stderr.on('data', b => { log += b; });
const base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  // Fresh self-contained payloads can take longer during first-run endpoint scanning.
  for (let i = 0; i < 600; i++) {
    if (processHandle.exitCode != null) throw new Error(log);
    try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, log);
  const root = await fetch(base); assert.equal(root.status, 200);
  const html = await root.text(); assert.ok(html.includes('src="/app.mjs"'));
  assert.ok(!/<script>/.test(html));
  assert.equal(root.headers.get('access-control-allow-origin'), null);
  assert.equal(root.headers.get('cache-control'), 'no-store');
  assert.ok(root.headers.get('content-security-policy').includes("script-src 'self';"));
  for (const asset of ['/app.mjs', '/core.mjs', '/probes.mjs', '/session.mjs', '/targets.mjs', '/review.mjs']) {
    const response = await fetch(base + asset); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
  }
  for (const route of ['/dns', '/system', '/config', '/diagnostics/portal']) {
    assert.equal((await fetch(base + route, { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
    assert.equal((await fetch(base + route, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const wrongHostStatus = await new Promise((resolve, reject) => {
      const req = http.get(base + route, { headers: { Host: 'foreign.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(wrongHostStatus, 403);
  }
  assert.equal((await fetch(base + '/dns', { method: 'OPTIONS' })).status, 405);
  assert.equal((await fetch(base + '/diagnostics/portal', { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + '/diagnostics/portal')).status, 405);
  const headers = { Origin: base, 'X-LanVibes': 'run' };
  const customHeaders = { ...headers, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/diagnostics/custom', { method: 'POST', headers })).status, 200,
    'Existing configured target named custom must still run without an import body');
  assert.equal((await fetch(base + '/diagnostics/custom', { method: 'POST', body: '{}' })).status, 403);
  for (const body of ['{', '{}', JSON.stringify({ id: 'custom', name: 'Invalid', url: 'http://example.com' }),
    JSON.stringify({ id: 'custom', name: 'Invalid', url: 'https://user:pass@example.com' }), ' '.repeat(8193)]) {
    assert.equal((await fetch(base + '/diagnostics/custom', { method: 'POST', headers: customHeaders, body })).status, 400);
  }
  // Probe an explicitly local closed port; this exercises custom dispatch without external traffic.
  const custom = await fetch(base + '/diagnostics/custom', { method: 'POST', headers: customHeaders,
    body: JSON.stringify({ id: 'custom-1', name: 'Local test', url: 'https://127.0.0.1:1/', corporate: false }) });
  assert.equal(custom.status, 200);
  assert.ok((await custom.json()).some(check => check.name === 'OS DNS'));
  for (const target of [{ name:'DNS fixture', dns:'localhost' }, { name:'URL DNS fixture', url:'https://localhost:1/',mode:'dns' }]) {
    const response = await fetch(base + '/diagnostics/custom',{method:'POST',headers:customHeaders,body:JSON.stringify(target)});
    assert.equal(response.status,200);
    const checks=await response.json();
    assert.equal(checks.length,1);
    assert.equal(checks[0].name,'OS DNS');
    assert.equal(checks[0].status,'pass');
  }
  for (const target of [{ name:'Invalid',dns:'localhost/path' },{name:'Invalid',dns:'localhost',mode:'full'}, {name:'Invalid',url:'https://localhost/',dns:'localhost'}])
    assert.equal((await fetch(base+'/diagnostics/custom',{method:'POST',headers:customHeaders,body:JSON.stringify(target)})).status,400);
  assert.deepEqual((await (await fetch(base + '/config')).json()).targets, config.targets, 'Custom tests must not mutate configured targets');
  assert.equal((await fetch(base + '/diagnostics/not-allowlisted', { method: 'POST', headers })).status, 404);
  const portal = await fetch(base + '/diagnostics/portal', { method: 'POST', headers });
  assert.equal(portal.status, 200); assert.equal((await portal.json())[0].status, 'not-applicable');
  assert.equal((await (await fetch(base + '/config')).json()).port, port);
  console.log('PASS published assets, independent working directory, CSP, no CORS, Host/Origin/fetch-site restrictions, method restrictions, probe allowlist, disabled portal');
} finally {
  if (processHandle.exitCode == null) { processHandle.kill(); await once(processHandle, 'exit'); }
  // Retain isolated output for inspection; never delete a computed directory recursively.
  console.log('Isolated test package: ' + destination);
}
