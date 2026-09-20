// Uses the self-contained executable. No browser launch or external probes.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
const input = process.argv[2];
if (!input) throw new Error('Usage: node tests/desktop.integration.mjs <publish-directory>');
const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'lanvibes-desktop-'));
await fs.cp(path.resolve(input), copy, { recursive: true });
const executable = path.join(copy, process.platform === 'win32' ? 'LanVibes.DnsAgent.exe' : 'LanVibes.DnsAgent');
if (process.platform === 'win32') {
  const bytes = await fs.readFile(executable);
  assert.equal(bytes.readUInt16LE(bytes.readInt32LE(0x3c) + 24 + 68), 2, 'Packaged executable must use GUI subsystem; windowsHide must not mask a console build');
}
const children = [];
async function start(explicitDesktop = false) {
  const child = spawn(executable, [...(explicitDesktop ? ['--desktop'] : []), '--no-browser'], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  for (let i = 0; i < 600; i++) {
    if (child.exitCode != null) throw new Error('Packaged process exited before readiness.');
    const match = log.match(/Launch: (http:\/\/127\.0\.0\.1:\d+\/launch\?token=[A-F0-9]+)/);
    if (match) return { child, url: match[1], base: new URL(match[1]).origin };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('No desktop launch URL received. ' + log.replace(/token=[A-F0-9]+/g, 'token=REDACTED'));
}
try {
  const first = await start(); const second = await start(true);
  assert.notEqual(first.base, second.base);
  for (const endpoint of ['/', '/config', '/dns', '/session/quit'])
    assert.equal((await fetch(first.base + endpoint)).status, 403);
  assert.equal((await fetch(first.base + '/launch?token=invalid')).status, 403);
  const bootstrap = await fetch(first.url, { redirect: 'manual' });
  assert.equal(bootstrap.status, 302); assert.equal(bootstrap.headers.get('location'), '/');
  const setCookie = bootstrap.headers.get('set-cookie');
  assert.match(setCookie, /httponly/i); assert.match(setCookie, /samesite=strict/i);
  const headers = { Cookie: setCookie.split(';')[0] };
  assert.equal((await fetch(first.base, { headers })).status, 200);
  const config = await (await fetch(first.base + '/config', { headers })).json();
  assert.equal(config.desktopSession, true);
  assert.equal((await fetch(second.base + '/config', { headers })).status, 403);
  assert.equal((await fetch(first.base + '/session/quit', { method: 'POST', headers })).status, 403);
  assert.equal((await fetch(first.base + '/session/quit', { method: 'POST', headers: { ...headers, Origin: 'https://foreign.invalid', 'X-LanVibes': 'run' } })).status, 403);
  const exit = once(first.child, 'exit');
  assert.equal((await fetch(first.base + '/session/quit', { method: 'POST', headers: { ...headers, Origin: first.base, 'X-LanVibes': 'run' } })).status, 200);
  await Promise.race([exit, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Quit did not stop process')), 10000); timer.unref(); })]);
  assert.equal(first.child.exitCode, 0);
  assert.equal(second.child.exitCode, null);
  console.log('PASS self-contained desktop launch, random ports, session isolation, cookies and authenticated Quit');
} finally {
  for (const child of children) if (child.exitCode == null) { child.kill(); await once(child, 'exit'); }
  console.log('Desktop test payload retained at ' + copy);
}
