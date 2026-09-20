import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { aggregate, validateSnapshot, classifyDns, request, readText, publicIp, RunCoordinator, supportReport, parseDiagnosticImport } from '../agent/wwwroot/core.mjs';
const fixture = () => JSON.parse(fs.readFileSync(new URL('../examples/windows-sample.json', import.meta.url)));
test('reports from the previous application name remain importable', () => {
  const report = supportReport(fixture(), []);
  assert.equal(report.kind, 'lanvibes-support-report');
  report.kind = 'signalpath-support-report';
  assert.equal(parseDiagnosticImport(report).kind, 'report');
});
test('imports validate nested shapes without mutating the valid snapshot', () => {
  assert.equal(validateSnapshot(fixture()).os, 'Windows');
  const invalid = fixture(); invalid.adapters[0].addresses = 'not-an-array';
  assert.throws(() => validateSnapshot(invalid));
  invalid.adapters = [null]; assert.throws(() => validateSnapshot(invalid));
  const mac = JSON.parse(fs.readFileSync(new URL('../examples/macos-sample.json', import.meta.url)));
  assert.equal(validateSnapshot(mac).os, 'macOS');
  mac.resolvers[0].searchDomains = [4]; assert.throws(() => validateSnapshot(mac));
  const unknown = fixture(); unknown.schemaVersion = 2; assert.throws(() => validateSnapshot(unknown));
});
test('DNS inventory normalizes IPv6 and preserves unknown classification', () => {
  assert.equal(classifyDns(['2001:db8::1'], { managedDnsServers: ['2001:0db8:0:0:0:0:0:1'] }), 'All listed servers match managed DNS inventory');
  assert.equal(classifyDns(['192.0.2.1'], {}), 'Inventory not configured');
});
test('overall never converts incomplete observations into pass', () => {
  assert.equal(aggregate([{ status: 'pass' }, { status: 'inconclusive' }]), 'inconclusive');
  assert.equal(aggregate([{ status: 'not-applicable' }]), 'not-applicable');
  assert.equal(aggregate([{ status: 'pass' }, { status: 'fail' }]), 'fail');
});
test('deadline remains active while response body is stalled', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_, { signal }) => ({ ok: true, body: new ReadableStream({ start(controller) {
    signal.addEventListener('abort', () => controller.error(signal.reason));
  } }) });
  try { await assert.rejects(request('https://example.test', { timeoutMs: 15, consume: readText }), /timed out/); }
  finally { globalThis.fetch = original; }
});
test('IPv6 retries after an HTTP-success response containing IPv4', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async url => { calls.push(url); return new Response(JSON.stringify({ ip: calls.length === 1 ? '192.0.2.1' : '2001:db8::1' }), { headers: { 'content-type': 'application/json' } }); };
  try {
    const value = await publicIp(['https://dual.test/', 'https://v6.test/'], 6, new AbortController().signal);
    assert.equal(calls.length, 2); assert.equal(value.status, 'pass');
  } finally { globalThis.fetch = original; }
});
test('runner prevents overlapping runs, cancels current and skips remaining probes', async () => {
  const runner = new RunCoordinator(); let release; let secondStarted = false; const observed = [];
  const work = runner.run([
    { id: 'one', run: () => new Promise(resolve => { release = resolve; }) },
    { id: 'two', run: () => { secondStarted = true; return { status: 'pass' }; } }
  ], (test, result) => observed.push([test.id, result.status]));
  assert.equal(await runner.run([], () => {}), false);
  runner.stop(); release({ status: 'pass' }); await work;
  assert.equal(secondStarted, false);
  assert.deepEqual(observed.slice(-2), [['one', 'cancelled'], ['two', 'cancelled']]);
  assert.equal(await runner.run([], () => {}), true);
});
test('support exports retain the full DNS snapshot and troubleshooting details by default', () => {
  const secret = 'sensitive.corp.example 192.0.2.44 SSID-private';
  const report = supportReport(fixture(), [{ name: secret, detail: secret, status: 'pass', checks: [{ name: secret, status: 'pass', detail: secret, milliseconds: 12 }] }]);
  const serialized = JSON.stringify(report);
  assert.ok(serialized.includes('sensitive') && serialized.includes('192.0.2') && serialized.includes('SSID'));
  assert.equal(report.redacted, false);
  assert.deepEqual(report.snapshot, fixture());
  assert.equal(report.results[0].checks[0].milliseconds, 12);
  assert.ok(supportReport(fixture(), []).snapshot);
});
test('oversized response bodies are rejected', async () => {
  await assert.rejects(readText(new Response('123456'), 3), /size limit/);
});
test('failed IPv6 discovery does not claim IPv6 is absent', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    const r = await publicIp(['https://v6.test'], 6, new AbortController().signal);
    assert.equal(r.status, 'inconclusive'); assert.match(r.detail, /does not prove IPv6 connectivity is absent/);
  } finally { globalThis.fetch = original; }
});

const savedResults = () => [{ id: 'target-public', name: 'Public target', status: 'pass', detail: 'Saved observation',
  checks: [{ name: 'OS DNS', status: 'pass', detail: '192.0.2.1', milliseconds: 12 }] }];
const legacyRedactedReport = () => ({ schemaVersion: 1, exportedAt: '2026-09-18T12:00:00Z', redacted: true,
  results: [{ test: 1, status: 'pass', checks: [{ status: 'pass', milliseconds: 12 }] }] });
test('unredacted export/import round trip restores snapshot and saved observations', () => {
  const exported = supportReport(fixture(), savedResults());
  const imported = parseDiagnosticImport(JSON.parse(JSON.stringify(exported)));
  assert.equal(imported.kind, 'report'); assert.equal(imported.redacted, false);
  assert.deepEqual(imported.snapshot, fixture());
  assert.equal(imported.results[0].name, 'Public target');
  assert.equal(imported.results[0].checks[0].detail, '192.0.2.1');
});
test('legacy redacted export imports without inventing DNS data or assigning current test names', () => {
  const exported = legacyRedactedReport();
  const imported = parseDiagnosticImport(JSON.parse(JSON.stringify(exported)));
  assert.equal(imported.kind, 'report'); assert.equal(imported.snapshot, null);
  assert.equal(imported.results[0].name, 'Test 1 (name redacted)');
  assert.equal(imported.results[0].checks[0].milliseconds, 12);
  assert.ok(!JSON.stringify(imported).includes('192.0.2.1'));
});
test('previous exports without a kind marker and raw snapshots are accepted', () => {
  for (const exported of [legacyRedactedReport(), supportReport(fixture(), savedResults())]) {
    delete exported.kind;
    assert.equal(parseDiagnosticImport(exported).kind, 'report');
  }
  assert.deepEqual(parseDiagnosticImport(fixture()), { kind: 'snapshot', snapshot: fixture() });
});
test('reports exported before DNS or tests finish can be imported', () => {
  const imported = parseDiagnosticImport(supportReport(null, []));
  assert.equal(imported.snapshot, null); assert.deepEqual(imported.results, []);
  const pending = parseDiagnosticImport(supportReport(null, [{ name: 'DNS', status: 'pending', detail: 'Running…' }]));
  assert.equal(pending.results[0].status, 'pending');
});
test('malformed reports and nested snapshots fail validation before display', () => {
  for (const modify of [
    r => { r.schemaVersion = 2; }, r => { r.kind = 'another-format'; },
    r => { r.exportedAt = 'invalid'; }, r => { r.redacted = 'false'; },
    r => { r.results[0] = null; }, r => { r.results[0].status = 'invalid'; },
    r => { r.results[0].checks = {}; }, r => { r.results[0].checks[0].milliseconds = -1; },
    r => { r.snapshot.adapters[0].addresses = 'invalid'; }
  ]) {
    const report = supportReport(fixture(), savedResults()); modify(report);
    assert.throws(() => parseDiagnosticImport(report));
  }
});
