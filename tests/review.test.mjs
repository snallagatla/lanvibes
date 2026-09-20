import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesResult,retryCandidates,compareReports } from '../agent/wwwroot/review.mjs';
const result=(name,status,ip='192.0.2.1')=>({name,status,checks:[{name:'OS DNS',status:'pass',detail:`app.example: ${ip}. OS policy/cache applies.`}]});
const report=results=>({redacted:false,results,snapshot:null});
test('filters combine case-insensitive names/hosts and status without mutation',()=>{
  const row={name:'Portal (https://app.example): DNS'};
  assert.ok(matchesResult(row,{status:'fail'},'APP.EXAMPLE','problem'));
  assert.ok(!matchesResult(row,{status:'pass'},'portal','problem'));
  assert.ok(matchesResult(row,undefined,'portal','not-run'));
});
test('retry selection excludes successes, skips, cancelled and changed target identities',()=>{
  const tests=['pass','fail','inconclusive','cancelled','not-applicable'].map((status,i)=>({id:String(i),name:status}));
  const results=tests.map(t=>({...t,status:t.name}));
  assert.deepEqual(retryCandidates(tests,results).map(t=>t.name),['fail','inconclusive']);
  assert.equal(retryCandidates([{id:'1',name:'Different URL'}],results).length,0);
});
test('comparison detects DNS and status changes without positional matching',()=>{
  const a=report([result('A','fail'),result('B','pass'),result('Gone','pass')]);
  const b=report([result('B','pass'),result('A','pass','192.0.2.2'),result('New','pass')]);
  const diff=compareReports(a,b);
  assert.equal(diff.unchanged,1); assert.equal(diff.changes.length,3);
  assert.match(diff.changes.find(c=>c.name==='A').detail,/Status: fail → pass/);
  assert.match(diff.changes.find(c=>c.name==='A').detail,/192.0.2.1 → 192.0.2.2/);
});
test('comparison ignores answer order but detects DNS server priority and ambiguous names',()=>{
  assert.equal(compareReports(report([result('A','pass','192.0.2.1, 192.0.2.2')]),report([result('A','pass','192.0.2.2, 192.0.2.1')])).changes.length,0);
  const a=report([result('A','pass'),result('A','fail')]);
  assert.equal(compareReports(a,report([result('A','pass')])).ambiguous,1);
  assert.throws(()=>compareReports({...a,redacted:true},a));
  const first={...report([]),snapshot:{adapters:[{name:'wifi',dnsServers:['192.0.2.1','192.0.2.2']}],resolvers:[],nrpt:[]}};
  const second=structuredClone(first);second.snapshot.adapters[0].dnsServers.reverse();
  assert.match(compareReports(first,second).dnsConfiguration,/changed/);
});
