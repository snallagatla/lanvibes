import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { supportReport } from '../agent/wwwroot/core.mjs';
// Lightweight DOM contract test. Real-browser rendering is checked separately.
class Node {
  constructor() { this.children = []; this.listeners = {}; this.className = ''; this.textContent = ''; this.disabled = false; this.checked = false; this.value = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener(event, fn) { this.listeners[event] = fn; }
  remove() {}
}
test('offline startup only fetches local config and DNS; no probes or uploads', async () => {
  const nodes = new Map(); const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  globalThis.document = { getElementById: get, createElement: () => new Node(), createDocumentFragment: () => new Node(), querySelector: get, body: new Node() };
  const calls = [];
  const config = JSON.parse(fs.readFileSync(new URL('../agent/diagnostics.json', import.meta.url)));
  const html = fs.readFileSync(new URL('../agent/wwwroot/index.html', import.meta.url), 'utf8');
  assert.match(html, /<input\b[^>]*id="includeSpeed"[^>]*\bchecked\b/);
  config.desktopSession = true;
  const snapshot = JSON.parse(fs.readFileSync(new URL('../examples/windows-sample.json', import.meta.url)));
  globalThis.fetch = async (url, options) => {
    assert.equal(options.credentials, 'same-origin', 'Local desktop requests must retain the session cookie');
    calls.push([url, options.method || 'GET']);
    assert.ok(url === '/dns' || url === '/config', `Unexpected startup request: ${url}`);
    return new Response(JSON.stringify(url === '/dns' ? snapshot : config), { headers: { 'content-type': 'application/json' } });
  };
  await import('../agent/wwwroot/app.mjs');
  for (let i = 0; i < 20 && !get('testsGrid').children.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(calls.map(c => c[0]).sort(), ['/config', '/dns']);
  assert.equal(get('runBtn').disabled, false);
  assert.equal(get('testsGrid').children.length, config.targets.length + 12);
  const importTargets = async text => get('targetImportFile').listeners.change({ target: { files: [{ size: text.length, text: async () => text }], value: 'apps.txt' } });
  await importTargets('https://example.org/app');
  assert.equal(get('customTargetList').children.length, 1);
  assert.equal(calls.length, 2, 'Import must not trigger network requests');
  await importTargets('http://example.org');
  assert.match(get('targetImportStatus').textContent, /Previous custom list retained/);
  assert.equal(get('customTargetList').children.length, 1);
  get('clearTargetsBtn').listeners.click();
  assert.equal(get('customTargetList').children.length, 0);
  assert.match(get('dnsBanner').textContent, /Configured candidates/);
  globalThis.fetch = async (url, options) => {
    if (url === '/health') return new Response(JSON.stringify({service:'LanVibes DNS Agent',status:'ok'}));
    assert.equal(url, '/system');
    assert.equal(options.credentials, 'same-origin');
    return new Response(JSON.stringify([{ name: 'Local routes', status: 'pass', detail: 'Collected' }]));
  };
  await get('systemBtn').listeners.click();
  assert.equal(get('status-system').textContent, 'Pass');
  assert.equal(get('runBtn').disabled, false);
  const importFile = async value => {
    const text = JSON.stringify(value);
    await get('dnsImportFile').listeners.change({ target: { files: [{ size: Buffer.byteLength(text), text: async () => text }], value: 'file.json' } });
  };
  const saved = [{ name: 'Saved public test', status: 'pass', detail: '<img src=x onerror=alert(1)>', checks: [] }];
  const liveRows = get('testsGrid').children;
  const initialDns = get('dnsSections').children;
  await importFile({ schemaVersion: 1, exportedAt: '2026-09-18T12:00:00Z', redacted: true,
    results: [{ test: 1, status: 'pass', checks: [] }] });
  assert.equal(get('importedReportPanel').hidden, false);
  assert.match(get('importedReportInfo').textContent, /Redacted/);
  assert.match(get('dnsBanner').textContent, /cannot be restored/);
  assert.equal(get('dnsSections').children, initialDns);
  assert.equal(get('testsGrid').children, liveRows);
  await importFile(supportReport(snapshot, saved));
  assert.match(get('dnsBanner').textContent, /DNS snapshot from imported support report/);
  const importedRows = get('importedReportResults').children;
  assert.equal(importedRows[0].children[0].children[1].textContent, '<img src=x onerror=alert(1)>');
  const importedDns = get('dnsSections').children;
  await importFile({ schemaVersion: 1, redacted: false, results: [null] });
  assert.match(get('dnsBanner').textContent, /Import failed/);
  assert.equal(get('importedReportResults').children, importedRows);
  assert.equal(get('dnsSections').children, importedDns);
  assert.deepEqual(calls.map(c => c[0]).sort(), ['/config', '/dns']); // import does not probe or upload
  assert.equal(get('quitBtn').hidden, false);
  const manyTargets = Array.from({length:10000},(_,i)=>({name:`App ${i}`,dns:`app${i}.example`}));
  await importTargets(JSON.stringify(manyTargets));
  assert.equal(get('testsGrid').children.length,config.targets.length + 12, 'Custom applications are not top-level result cards');
  assert.equal(get('customResultsGrid').children.length,100, 'Only one page is rendered inside the group');
  assert.equal(get('customResultsGroup').open,false);
  assert.match(get('customResultsCounts').textContent,/10000 not run/);
  assert.equal(get('customTargetList').children.length,100);
  get('customDnsOnly').checked = true;
  get('customDnsOnly').listeners.change();
  let customCalls = 0;
  globalThis.fetch = async (url,options) => {
    if (url === '/health') return new Response(JSON.stringify({service:'LanVibes DNS Agent',status:'ok'}));
    assert.equal(url,'/diagnostics/custom', 'DNS-only mode skips every other test');
    const body=JSON.parse(options.body);
    assert.equal(body.mode,'dns');
    assert.match(get('progressDetail').textContent,new RegExp(`Running: App ${customCalls} \\(`));
    assert.ok(get('progressDetail').textContent.includes(body.dns));
    customCalls++;
    return new Response(JSON.stringify([{name:'OS DNS',status:'pass',detail:'Resolved'}]));
  };
  await get('runBtn').listeners.click();
  assert.equal(customCalls,10000);
  assert.equal(get('progressBar').value,10000);
  assert.equal(get('testsGrid').children.length,0, 'DNS-only runs have one custom group and no individual top-level cards');
  assert.equal(get('customResultsGrid').children.length,100);
  assert.equal(get('customResultsGroup').open,false, 'Results must not open the group');
  assert.match(get('customResultsCounts').textContent,/10000 succeeded · 0 failed/);
  assert.match(get('customResultsCounts').textContent,/0 running · 0 not run/);
  get('resultsNextBtn').listeners.click();
  assert.match(get('resultsPageInfo').textContent,/Page 2 of 100/);
  assert.equal(get('status-custom-101').textContent,'Pass');
  await importFile(supportReport(null,manyTargets.map(target=>({name:target.name,status:'pass',detail:'Resolved',checks:[]}))));
  assert.equal(get('importedReportResults').children[0].children.length,100);
  get('importedNextBtn').listeners.click();
  assert.match(get('importedPageInfo').textContent,/Page 2 of 100/);
  await importTargets(JSON.stringify([
    {dns:'pass.example'}, {dns:'fail.example'}, {dns:'unknown.example'}, {dns:'private.example',corporate:true}
  ]));
  get('profile').value='home';
  const outcomes=['pass','fail','inconclusive']; let observed=0;
  globalThis.fetch=async url => url === '/health' ? new Response(JSON.stringify({service:'LanVibes DNS Agent',status:'ok'})) : new Response(JSON.stringify([{name:'OS DNS',status:outcomes[observed++],detail:'Fixture'}]));
  await get('runBtn').listeners.click();
  assert.equal(observed,3);
  assert.match(get('customResultsCounts').textContent,/4 applications · 1 succeeded · 1 failed · 1 inconclusive · 1 skipped · 0 cancelled · 0 running · 0 not run/);
  get('resultStatus').value='problem'; get('resultStatus').listeners.change();
  assert.equal(get('customResultsGrid').children.length,2);
  get('resultSearch').value='fail.example'; get('resultSearch').listeners.input();
  assert.equal(get('customResultsGrid').children.length,1);
  const retried=[];
  globalThis.fetch=async (url,options)=>{
    if(url==='/health')return new Response(JSON.stringify({service:'LanVibes DNS Agent',status:'ok'}));
    retried.push(JSON.parse(options.body).dns);
    return new Response(JSON.stringify([{name:'OS DNS',status:'pass',detail:'Recovered'}]));
  };
  await get('retryBtn').listeners.click();
  assert.deepEqual(retried,['fail.example','unknown.example']);
  assert.match(get('customResultsCounts').textContent,/3 succeeded · 0 failed · 0 inconclusive · 1 skipped/);
  assert.equal(get('progressBar').max,2);
  assert.equal(get('retryBtn').disabled,true);
  const earlier=supportReport(null,[{name:'pass.example (pass.example): DNS resolution only',status:'fail',detail:'Prior failure',checks:[]}]);
  const comparisonText=JSON.stringify(earlier);
  await get('compareBeforeFile').listeners.change({target:{files:[{name:'earlier.json',size:comparisonText.length,text:async()=>comparisonText}],value:'earlier.json'}});
  get('compareCurrentBtn').listeners.click(); get('compareBtn').listeners.click();
  assert.match(get('compareInfo').textContent,/changed, added or missing tests/);
  assert.ok(get('compareRows').children.some(row=>row.children[1].textContent.includes('fail → pass')));
  get('customDnsOnly').checked = false;
  get('customDnsOnly').listeners.change();
  let closeAttempts = 0;
  globalThis.window = { close() { closeAttempts++; throw new Error('Browser blocked tab close'); } };
  globalThis.fetch = async () => new Response('', { status: 403 });
  await get('quitBtn').listeners.click();
  assert.equal(closeAttempts, 0, 'Do not close the tab when shutdown fails');
  assert.equal(get('quitBtn').disabled, false);
  assert.equal(get('runBtn').disabled, false);
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/session/quit');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-LanVibes'], 'run');
    return new Response('{}');
  };
  await get('quitBtn').listeners.click();
  assert.equal(closeAttempts, 1, 'Attempt tab close only after successful shutdown');
  assert.equal(get('quitBtn').disabled, true);
  assert.match(get('actionDetail').textContent, /You can close this tab now/);
  assert.equal(get('runBtn').disabled, true);
  assert.equal(get('systemBtn').disabled, true);
  assert.equal(get('dnsRefreshBtn').disabled, true);
  assert.equal(get('exportBtn').disabled, false);
  assert.match(get('dnsBanner').textContent, /LanVibes has stopped/);
});
