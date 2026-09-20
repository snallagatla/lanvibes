import test from 'node:test';
import assert from 'node:assert/strict';
import { upload, websocket, doh, latency, download, browserTests } from '../agent/wwwroot/probes.mjs';
import { RunCoordinator } from '../agent/wwwroot/core.mjs';
test('HTTP upload rejection cannot be counted as successful throughput', async () => {
  const original = globalThis.fetch; let options;
  globalThis.fetch = async (_, init) => { options = init; return new Response('Denied', { status: 405 }); };
  try {
    await assert.rejects(upload({ uploadUrl: 'https://upload.example.test' }, new AbortController().signal), /HTTP 405/);
    assert.equal(options.body.length, 1_000_000);
    assert.equal(options.redirect, 'error');
    assert.notEqual(options.mode, 'no-cors');
    assert.ok(options.signal);
  } finally { globalThis.fetch = original; }
});
test('disabled upload does not fetch', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected request'); };
  try { assert.equal((await upload({}, new AbortController().signal)).status, 'not-applicable'); }
  finally { globalThis.fetch = original; }
});
test('synchronous WebSocket constructor error settles instead of hanging', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor() { throw new Error('Blocked by policy'); } };
  try { await assert.rejects(websocket({ webSockets: ['wss://echo.example.test'] }, new AbortController().signal), /Blocked by policy/); }
  finally { globalThis.WebSocket = original; }
});
test('WebSocket closed without matching echo is not success', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() { queueMicrotask(() => this.onclose()); }
    close() {}
  };
  try { await assert.rejects(websocket({ webSockets: ['wss://echo.example.test'] }, new AbortController().signal), /without a matching echo/); }
  finally { globalThis.WebSocket = original; }
});
test('DNS error response triggers public DoH fallback', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify(++calls === 1 ? { Status: 2 } : { Status: 0, Answer: [{ type: 1, data: '192.0.2.1' }] }));
  try {
    const r = await doh({ directDnsName: 'example.com', doh: ['https://first.test', 'https://second.test'] }, 'A', new AbortController().signal);
    assert.equal(calls, 2); assert.equal(r.status, 'pass');
  } finally { globalThis.fetch = original; }
});
test('normal execution is sequential, including speed tests', async () => {
  const runner = new RunCoordinator(); const order = []; let active = 0;
  await runner.run(['idle', 'download', 'upload'].map(id => ({ id, run: async () => {
    assert.equal(active++, 0); order.push(id);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return { status: 'pass' };
  } })), () => {});
  assert.deepEqual(order, ['idle', 'download', 'upload']);
});
test('latency is independent of IP discovery and selects one working fallback', async () => {
  const original = globalThis.fetch; const hosts = [];
  globalThis.fetch = async url => {
    const host = new URL(url).host; hosts.push(host);
    if (host === 'blocked.test') throw new TypeError('Failed to fetch');
    assert.equal(host, 'working.test'); return new Response('x');
  };
  try {
    const r = await latency({ publicIpv4: ['https://ip-blocked.test'], latencyEndpoints: ['https://blocked.test/ping', 'https://working.test/ping'] }, new AbortController().signal);
    assert.equal(r.status, 'pass'); assert.equal(r.endpoint, 'https://working.test/ping');
    assert.equal(hosts.filter(h => h === 'blocked.test').length, 1);
    assert.equal(hosts.filter(h => h === 'working.test').length, 7); // discarded warm-up plus six samples
    assert.match(r.detail, /6\/6 responses/); assert.match(r.detail, /Other endpoint unavailable/);
  } finally { globalThis.fetch = original; }
});
test('all latency endpoints failing produces a bounded, explicit inconclusive result', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch'); };
  try {
    const r = await latency({ latencyEndpoints: ['https://one.test', 'https://two.test'] }, new AbortController().signal);
    assert.equal(calls, 2); assert.equal(r.endpoint, null); assert.equal(r.status, 'inconclusive');
    assert.match(r.detail, /not proof of an internet outage/);
  } finally { globalThis.fetch = original; }
});
test('loaded latency starts after download headers, uses baseline endpoint and cancels at transfer end', async () => {
  const original = globalThis.fetch; let headersReady = false; let sampleSignal;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).host === 'download.test') {
      await new Promise(resolve => setTimeout(resolve, 10)); headersReady = true;
      return new Response(new Uint8Array([1, 2, 3]));
    }
    assert.equal(new URL(url).host, 'latency.test'); assert.equal(headersReady, true);
    sampleSignal = options.signal;
    return new Promise((resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  try {
    const r = await download({ downloadUrl: 'https://download.test/file', latencyEndpoints: ['https://latency.test/ping'] }, new AbortController().signal, { median: 12, endpoint: 'https://latency.test/ping' });
    assert.equal(r.status, 'pass'); assert.equal(sampleSignal.aborted, true);
    assert.equal(r.checks[0].status, 'not-applicable'); assert.match(r.checks[0].detail, /Short downloads/);
  } finally { globalThis.fetch = original; }
});
test('public address discovery cannot independently degrade overall health', () => {
  const tests = browserTests({});
  assert.equal(tests.find(t => t.id === 'ipv4').informational, true);
  assert.equal(tests.find(t => t.id === 'ipv6').informational, true);
});
