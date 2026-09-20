import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTargets, MAX_TARGET_FILE_BYTES } from '../agent/wwwroot/targets.mjs';
import { supportReport, parseDiagnosticImport, RunCoordinator } from '../agent/wwwroot/core.mjs';
test('imports URL lines and named JSON applications with optional corporate scope', () => {
  assert.equal(parseTargets('https://example.com/\n\nhttps://example.org/app')[1].name, 'example.org');
  assert.equal(parseTargets(JSON.stringify({ targets: [{ name: 'Portal', url: 'https://portal.example/', corporate: true }] }))[0].corporate, true);
  assert.equal(parseTargets('["https://example.com/"]')[0].corporate, false);
});
test('rejects unsafe, malformed, duplicate and oversized application lists', () => {
  for (const value of ['[]', '{}', 'null', '[null]', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/#x',
    'https://example.com\nhttps://example.com/', JSON.stringify([{url:'https://example.com',corporate:'false'}]),
    JSON.stringify(Array(10001).fill('https://example.com')), ' '.repeat(MAX_TARGET_FILE_BYTES + 1)]) assert.throws(() => parseTargets(value));
});
test('mixed Markdown URLs, DNS entries and URL DNS-only mode', () => {
  const values = parseTargets(JSON.stringify([
    { name:'Wiki', url:'[https://wiki.example/](https://wiki.example/)',corporate:false },
    { name:'Portal',url:'https://portal.example/',corporate:true },
    { name:'Portal',url:'https://acl.corp.example/',corporate:true },
    { name:'DNS',dns:'acl.corp.example',corporate:true },
    { url:'https://example.com/path',mode:'dns' }
  ]));
  assert.equal(values[0].url,'https://wiki.example/');
  assert.equal(values[3].mode,'dns');
  assert.equal(values[3].dns,'acl.corp.example');
  assert.equal(values[4].mode,'dns');
  for (const item of [{dns:'https://example.com'}, {dns:'a.example/path'}, {dns:'a.example',mode:'full'}, {url:'https://example.com',dns:'example.com'}, {dns:'a..example'}])
    assert.throws(() => parseTargets(JSON.stringify([item])), /Application 1/);
});
test('10,000 entries and results survive import and report round trip', () => {
  const entries = Array.from({length:10000},(_,i)=>({name:`App ${i}`,dns:`app${i}.example`}));
  assert.equal(parseTargets(JSON.stringify(entries)).length,10000);
  const results = entries.map(e=>({name:e.name,status:'pass',detail:'Resolved',checks:[{name:'OS DNS',status:'pass',detail:'192.0.2.1'}]}));
  assert.equal(parseDiagnosticImport(JSON.parse(JSON.stringify(supportReport(null,results)))).results.length,10000);
});
test('large immediate runs yield to cancellation and retain every result', async () => {
  const runner = new RunCoordinator();
  let executed = 0, cancelled = 0, final = 0;
  const tests = Array.from({length:10000},(_,i)=>({id:String(i),run:()=>{executed++;return {status:'pass'};}}));
  setTimeout(()=>runner.stop(),0);
  await runner.run(tests,(_,result)=>{if(result.status !== 'pending') final++; if(result.status === 'cancelled') cancelled++;});
  assert.ok(executed < 10000);
  assert.ok(cancelled > 0);
  assert.equal(final,10000);
});
