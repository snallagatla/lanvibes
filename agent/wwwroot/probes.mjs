import { request, readJson, readText, firstValid, publicIp, aggregate } from './core.mjs';
const result = (name, status, detail) => ({ name, status, detail });
export async function native(id, signal, target) {
  const checks = await request(`/diagnostics/${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'X-LanVibes': 'run', ...(target ? { 'Content-Type': 'application/json' } : {}) },
    ...(target ? { body: JSON.stringify(target) } : {}), signal, timeoutMs: 47000
  });
  return { status: aggregate(checks), checks, detail: 'Agent observations; inspect each stage below.' };
}
export async function doh(config, type, signal) {
  return firstValid(config.doh, async base => {
    const url = new URL(base); url.searchParams.set('name', config.directDnsName); url.searchParams.set('type', type);
    const data = await request(url, { signal, headers: { accept: 'application/dns-json' } });
    if (data.Status !== 0) throw new Error(`DNS RCODE ${data.Status}`);
    const answers = (data.Answer || []).filter(a => a.type === (type === 'A' ? 1 : 28));
    return result(`Public DoH ${type}`, answers.length ? 'pass' : 'not-applicable',
      `${config.directDnsName}: ${answers.map(a => a.data).join(', ') || 'No address records'} via ${url.host}. Public DoH does not test the OS resolver or IPv6 transport.`);
  }, signal);
}
async function latencySample(endpoint, signal) {
  const url = new URL(endpoint); url.searchParams.set('_sp', Date.now());
  const start = performance.now();
  await request(url, { signal, timeoutMs: 4000, consume: r => readText(r, 4096) });
  return performance.now() - start;
}
export async function latency(config, signal, count = 6) {
  const endpoints = config.latencyEndpoints || [];
  if (!endpoints.length) return { ...result('Idle HTTP latency', 'not-applicable', 'No latency endpoints configured.'), median: null, endpoint: null };
  const unavailable = [];
  let endpoint;
  try {
    endpoint = await firstValid(endpoints, async url => {
      try { await latencySample(url, signal); return url; }
      catch (error) { unavailable.push(new URL(url).host + ': ' + error.message); throw error; }
    }, signal);
  } catch (error) {
    signal.throwIfAborted();
    return { ...result('Idle HTTP latency', 'inconclusive', 'No latency endpoint returned a browser-readable response. This is not proof of an internet outage. ' + error.message), median: null, endpoint: null };
  }
  // Select once with a discarded warm-up; never mix endpoint timings in one median.
  const samples = []; const errors = [];
  for (let i = 0; i < count; i++) {
    signal.throwIfAborted();
    try { samples.push(await latencySample(endpoint, signal)); }
    catch (error) { signal.throwIfAborted(); errors.push(error.message); }
  }
  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  const median = samples.length ? (samples.length % 2 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2) : null;
  const fallback = unavailable.length ? ' Other endpoint unavailable: ' + unavailable.join('; ') + '.' : '';
  return { ...result('Idle HTTP latency', samples.length === count ? 'pass' : 'inconclusive',
    samples.length + '/' + count + ' responses via ' + new URL(endpoint).host + '; median ' + (median?.toFixed(1) ?? 'N/A') + ' ms. Warm-up excluded. Includes HTTP, TLS, proxy and server time; not ICMP RTT.' + fallback + (errors.length ? ' Sample errors: ' + [...new Set(errors)].join('; ') : '')), median, endpoint };
}
export async function websocket(config, signal) {
  return firstValid(config.webSockets, url => new Promise((resolve, reject) => {
    let ws; let timer; let finished = false;
    const finish = error => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (ws) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws.close(); }
      error ? reject(error) : resolve(result('WebSocket echo', 'pass', `Matching echo received from ${new URL(url).host}.`));
    };
    const abort = () => finish(signal.reason || new Error('Cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    timer = setTimeout(() => finish(new Error('WebSocket timed out; endpoint, policy or network may be responsible')), 8000);
    try {
      ws = new WebSocket(url);
      const message = `lanvibes-${crypto.randomUUID()}`;
      ws.onopen = () => ws.send(message);
      ws.onmessage = event => { if (event.data === message) finish(); };
      ws.onerror = () => finish(new Error('WebSocket error; cause not established'));
      ws.onclose = () => finish(new Error('Closed without a matching echo'));
    } catch (error) { finish(error); }
  }), signal);
}

export async function download(config, signal, baseline) {
  if (!config.downloadUrl) return result('Download', 'not-applicable', 'No download endpoint configured.');
  const url = new URL(config.downloadUrl); url.searchParams.set('_sp', Date.now());
  const latencyEndpoint = baseline?.median != null && (config.latencyEndpoints || []).includes(baseline.endpoint) ? baseline.endpoint : null;
  let bytes = 0; let started = 0; let ended = 0; let active = false;
  const loaded = [], loadedErrors = [];
  const samplingController = new AbortController();
  const sampleSignal = AbortSignal.any([signal, samplingController.signal]);
  let sampling = Promise.resolve();
  const sampleLoaded = async () => {
    for (let i = 0; i < 3 && active; i++) {
      const begin = performance.now();
      try {
        await latencySample(latencyEndpoint, sampleSignal);
        const end = performance.now();
        if (begin >= started && (active || end <= ended)) loaded.push(end - begin);
      } catch (error) { if (sampleSignal.aborted) break; loadedErrors.push(error.message); }
    }
  };
  try {
    await request(url, { signal, timeoutMs: 15000, redirect: 'error', consume: async response => {
      if (!response.body) throw new Error('Streaming response unavailable');
      const reader = response.body.getReader(); started = performance.now(); active = true;
      // Start sampling only once the response body transfer begins, using the idle endpoint.
      if (latencyEndpoint) sampling = sampleLoaded();
      try {
        while (bytes < 20_000_000) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += Math.min(value.byteLength, 20_000_000 - bytes);
        }
      } finally { ended = performance.now(); active = false; samplingController.abort(); await reader.cancel().catch(() => {}); }
    }});
  } finally { active = false; samplingController.abort(); await sampling; }
  if (!bytes) throw new Error('No download bytes received');
  const seconds = Math.max((ended - started) / 1000, .001);
  const detail = loaded.length
    ? loaded.length + ' fully overlapping samples via ' + new URL(latencyEndpoint).host + '; mean ' + (loaded.reduce((a, b) => a + b) / loaded.length).toFixed(1) + ' ms; idle median ' + baseline.median.toFixed(1) + ' ms. Small sample; not a bufferbloat diagnosis.'
    : !latencyEndpoint ? 'No usable idle baseline endpoint; loaded latency not measured.'
    : loadedErrors.length ? 'Loaded latency requests failed: ' + [...new Set(loadedErrors)].join('; ') + '. This does not invalidate the completed download.'
    : 'Transfer ended before a complete overlapping latency sample was collected. Short downloads can legitimately have no loaded sample.';
  return { status: 'pass', detail: (bytes * 8 / seconds / 1e6).toFixed(2) + ' Mbps; ' + bytes + ' verified response bytes in ' + seconds.toFixed(2) + ' s from ' + url.host + '. Short samples are approximate.',
    checks: [result('Loaded HTTP latency', loaded.length ? 'pass' : loadedErrors.length ? 'inconclusive' : 'not-applicable', detail)] };
}
export async function upload(config, signal) {
  if (!config.uploadUrl) return result('Upload', 'not-applicable', 'No upload endpoint configured.');
  const payload = new Uint8Array(1_000_000);
  for (let i = 0; i < payload.length; i += 65536) crypto.getRandomValues(payload.subarray(i, Math.min(i + 65536, payload.length)));
  const start = performance.now();
  await request(config.uploadUrl, { signal, method: 'POST', body: payload, redirect: 'error', timeoutMs: 15000, consume: r => readText(r, 65536) });
  const seconds = (performance.now() - start) / 1000;
  return result('Upload', 'pass', `${(payload.length * 8 / seconds / 1e6).toFixed(2)} Mbps request/response estimate; ${payload.length} synthetic bytes submitted with HTTP success from ${new URL(config.uploadUrl).host}. Includes response latency; server byte count is not independently verified.`);
}
export function browserTests(config) {
  return [
    { id: 'ipv4', name: 'Browser public IPv4', informational: true, run: s => publicIp(config.publicIpv4, 4, s) },
    { id: 'ipv6', name: 'Browser public IPv6', informational: true, run: s => publicIp(config.publicIpv6, 6, s) },
    { id: 'dohA', name: 'Public DoH A', informational: true, run: s => doh(config, 'A', s) },
    { id: 'dohAAAA', name: 'Public DoH AAAA', informational: true, run: s => doh(config, 'AAAA', s) },
    { id: 'websocket', name: 'Browser WebSocket echo', informational: true, run: s => websocket(config, s) }
  ];
}
