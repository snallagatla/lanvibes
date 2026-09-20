export const statuses = ['pass', 'fail', 'inconclusive', 'not-applicable', 'cancelled', 'pending'];
export const MAX_IMPORT_BYTES = 128 * 1024 * 1024;
export function parseDiagnosticImport(value) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(value)) throw new Error('Expected a DNS snapshot or support report');
  if (!('results' in value) && !('redacted' in value) && !('kind' in value))
    return { kind: 'snapshot', snapshot: validateSnapshot(value) };
  // Accept reports exported before the rename; new exports use the new brand.
  if (value.schemaVersion !== 1 || (value.kind !== undefined && !['lanvibes-support-report', 'signalpath-support-report'].includes(value.kind)) ||
      typeof value.redacted !== 'boolean' || typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt)) ||
      !Array.isArray(value.results) || value.results.length > 20000)
    throw new Error('Invalid schema-v1 support report');
  const text = v => typeof v === 'string' && v.length <= 100000;
  const timing = v => v == null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  let checkCount = 0;
  const results = value.results.map((r, i) => {
    if (!object(r) || !statuses.includes(r.status) || (!value.redacted && (!text(r.name) || !text(r.detail))) ||
        (r.observedAt !== undefined && (typeof r.observedAt !== 'string' || !Number.isFinite(Date.parse(r.observedAt)))) ||
        (value.redacted && (!Number.isInteger(r.test) || r.test < 1)) ||
        (r.checks !== undefined && !Array.isArray(r.checks))) throw new Error('Invalid test result in support report');
    checkCount += r.checks?.length || 0;
    if (checkCount > 300000) throw new Error('Too many checks in support report');
    const checks = (r.checks || []).map((c, index) => {
      if (!object(c) || !statuses.includes(c.status) || !timing(c.milliseconds) ||
          (!value.redacted && (!text(c.name) || !text(c.detail)))) throw new Error('Invalid check in support report');
      return { name: value.redacted ? `Check ${index + 1} (name redacted)` : c.name,
        status: c.status, detail: value.redacted ? 'Details omitted from the redacted export.' : c.detail,
        milliseconds: c.milliseconds ?? null };
    });
    // Never map numbered redacted results onto the current machine's configured test list.
    return { name: value.redacted ? `Test ${r.test} (name redacted)` : r.name,
      status: r.status, detail: value.redacted ? 'Details omitted from the redacted export.' : r.detail, checks,
      ...(r.observedAt ? { observedAt:r.observedAt } : {}) };
  });
  return { kind: 'report', redacted: value.redacted, exportedAt: value.exportedAt, results,
    snapshot: !value.redacted && value.snapshot != null ? validateSnapshot(value.snapshot) : null };
}
export function aggregate(results) {
  const relevant = results.filter(r => !['not-applicable', 'cancelled'].includes(r.status));
  if (relevant.some(r => r.status === 'fail')) return 'fail';
  if (relevant.some(r => r.status === 'inconclusive' || r.status === 'pending')) return 'inconclusive';
  return relevant.length ? 'pass' : 'not-applicable';
}
export function validateSnapshot(s) {
  const strings = a => Array.isArray(a) && a.length <= 2000 && a.every(x => typeof x === 'string' && x.length <= 4096);
  const optionalString = v => v == null || typeof v === 'string';
  if (!s || s.schemaVersion !== 1 || !['Windows', 'macOS', 'Unsupported OS'].includes(s.os) ||
      typeof s.capturedAt !== 'string' || !Number.isFinite(Date.parse(s.capturedAt)) ||
      !['adapters', 'resolvers', 'nrpt'].every(k => Array.isArray(s[k]) && s[k].length <= 2000) || !strings(s.warnings))
    throw new Error('Invalid schema-v1 snapshot.');
  for (const a of s.adapters) if (!a || !['name', 'id', 'status', 'type', 'dnsSuffix'].every(k => typeof a[k] === 'string') ||
      !['addresses', 'gateways', 'dnsServers'].every(k => strings(a[k]))) throw new Error('Invalid adapter in snapshot.');
  for (const r of s.resolvers) if (!r || typeof r.kind !== 'string' || !['domain', 'interface', 'flags'].every(k => optionalString(r[k])) ||
      !strings(r.nameServers) || !strings(r.searchDomains) || !(r.order == null || Number.isInteger(r.order))) throw new Error('Invalid resolver in snapshot.');
  for (const r of s.nrpt) if (!r || typeof r.namespace !== 'string' || !strings(r.nameServers)) throw new Error('Invalid NRPT rule.');
  return s;
}
export function ipFamily(value) {
  if (typeof value !== 'string') return 0;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(n => +n <= 255)) return 4;
  // URL's host parser validates IPv6 groups and compression without DNS requests.
  try { if (value.includes(':') && new URL(`http://[${value}]/`).hostname.startsWith('[')) return 6; } catch {}
  return 0;
}
export function normalizeIp(value) {
  if (ipFamily(value) === 6) return new URL(`http://[${value}]/`).hostname;
  return value.toLowerCase();
}
export function classifyDns(servers, config) {
  const managed = new Set((config?.managedDnsServers || []).map(normalizeIp));
  const legacy = new Set((config?.legacyDnsServers || []).map(normalizeIp));
  if (!managed.size && !legacy.size) return 'Inventory not configured';
  if (servers.some(s => legacy.has(normalizeIp(s)))) return 'Legacy DNS address detected';
  if (servers.length && servers.every(s => managed.has(normalizeIp(s)))) return 'All listed servers match managed DNS inventory';
  if (servers.some(s => managed.has(normalizeIp(s)))) return 'Mixed managed DNS and unclassified addresses';
  return 'Unclassified DNS addresses';
}

// The deadline covers headers AND body consumption. Caller work stays inside consume.
export async function request(url, { signal, timeoutMs = 8000, consume = r => readJson(r), ...options } = {}) {
  const deadline = new AbortController();
  const abort = () => deadline.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => deadline.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  try {
    // Desktop API requests need the HttpOnly session cookie. The browser excludes
    // credentials from cross-origin diagnostic endpoints with same-origin mode.
    const response = await fetch(url, { ...options, signal: deadline.signal, cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await consume(response, deadline.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
export async function readText(response, limit = 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Response exceeds size limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(all);
}
export async function readJson(response) { return JSON.parse(await readText(response)); }
export async function firstValid(endpoints, probe, signal) {
  const errors = [];
  for (const endpoint of endpoints) {
    signal?.throwIfAborted();
    try { return await probe(endpoint); }
    catch (error) { signal?.throwIfAborted(); errors.push(`${new URL(endpoint).host}: ${error.message}`); }
  }
  throw new Error(errors.join('; ') || 'No endpoints configured');
}
export async function publicIp(endpoints, family, signal) {
  try { return await firstValid(endpoints, async url => {
    const value = await request(url, { signal, consume: async r => {
      const text = await readText(r, 4096);
      return (r.headers.get('content-type') || '').includes('json') ? JSON.parse(text).ip : text.trim();
    }});
    if (ipFamily(value) !== family) throw new Error(`No valid IPv${family} address in response`);
    return { name: `Public IPv${family}`, status: 'pass', detail: `${value} via ${new URL(url).host}. Address observed by this service; a proxy/VPN may affect the egress address.` };
  }, signal); }
  catch (error) {
    signal?.throwIfAborted();
    return { name: `Public IPv${family}`, status: 'inconclusive', detail: `Public IPv${family} address could not be observed. This does not prove IPv${family} connectivity is absent. Browser errors cannot distinguish endpoint availability, DNS/TLS, CORS or filtering. ${error.message}` };
  }
}
export class RunCoordinator {
  controller = null;
  async run(tests, onResult) {
    if (this.controller) return false;
    const controller = this.controller = new AbortController();
    try {
      let processed = 0;
      for (const test of tests) {
        if (++processed % 100 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        if (controller.signal.aborted) { onResult(test, { status: 'cancelled', detail: 'Cancelled before execution.' }); continue; }
        onResult(test, { status: 'pending', detail: 'Running…' });
        try {
          const result = await test.run(controller.signal);
          onResult(test, controller.signal.aborted ? { status: 'cancelled', detail: 'Cancelled.' } : result);
        } catch (error) {
          onResult(test, { status: controller.signal.aborted ? 'cancelled' : 'inconclusive', detail: error.message || String(error) });
        }
      }
    } finally { this.controller = null; }
    return true;
  }
  stop() { this.controller?.abort(new DOMException('Stopped by user', 'AbortError')); }
}

// Full diagnostic exports for the support team. Keep the schema flag for older importers.
export function supportReport(snapshot, results) {
  return { kind: 'lanvibes-support-report', schemaVersion: 1, exportedAt: new Date().toISOString(),
    redacted: false, snapshot, results };
}
