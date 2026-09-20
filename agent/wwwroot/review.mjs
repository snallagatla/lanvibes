export function matchesResult(test, result, query = '', status = '') {
  return `${test.name} ${test.destination ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()) &&
    (!status || status === 'all' || (status === 'problem' ? ['fail','inconclusive'].includes(result?.status) : (result?.status ?? 'not-run') === status));
}
export function retryCandidates(tests, results) {
  const saved = new Map(results.map(r => [r.id,r]));
  return tests.filter(t => { const r=saved.get(t.id); return r?.name === t.name && ['fail','inconclusive'].includes(r.status); });
}
function dnsAnswers(result) {
  return (result.checks ?? []).filter(c => c.name === 'OS DNS').map(c => {
    const match=c.detail.match(/^[^:]+:\s*(.*?)\. OS policy\/cache/);
    return match ? match[1].split(',').map(x=>x.trim().toLowerCase()).sort().join(', ') : `${c.status}: ${c.detail}`;
  }).sort();
}
function dnsConfig(snapshot) {
  if (!snapshot) return null;
  const ordered=rows=>rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({
    adapters: ordered((snapshot.adapters??[]).map(a=>({name:a.name,servers:a.dnsServers??[],suffix:a.dnsSuffix}))),
    resolvers:ordered((snapshot.resolvers??[]).map(r=>({kind:r.kind,domain:r.domain,interface:r.interface,servers:r.nameServers??[],search:r.searchDomains??[],flags:r.flags,order:r.order}))),
    nrpt:ordered((snapshot.nrpt??[]).map(r=>({namespace:r.namespace,servers:r.nameServers??[]})))
  });
}
export function compareReports(before, after) {
  if (before.redacted || after.redacted) throw new Error('Comparison requires reports with application names and details (not redacted reports).');
  const group=report=>{const map=new Map();for(const r of report.results){const list=map.get(r.name)??[];list.push(r);map.set(r.name,list);}return map;};
  const a=group(before),b=group(after),changes=[];let unchanged=0,ambiguous=0;
  for(const name of new Set([...a.keys(),...b.keys()])) {
    const old=a.get(name), next=b.get(name);
    if(old?.length>1||next?.length>1){ambiguous++;changes.push({name,detail:'Duplicate test name: cannot match this result reliably.'});continue;}
    if(!old||!next){changes.push({name,detail:!old?`Added: ${next[0].status}`:`Missing from later report (previously ${old[0].status})`});continue;}
    const prior=old[0],current=next[0],notes=[];
    if(prior.status!==current.status)notes.push(`Status: ${prior.status} → ${current.status}`);
    const stages=r=>(r.checks??[]).map(c=>`${c.name}: ${c.status}`).sort().join('; ');
    if(stages(prior)!==stages(current))notes.push(`Stage outcomes: ${stages(prior)||'none'} → ${stages(current)||'none'}`);
    const left=dnsAnswers(prior),right=dnsAnswers(current);
    if(JSON.stringify(left)!==JSON.stringify(right))notes.push(`DNS answers: ${left.join('; ')||'not recorded'} → ${right.join('; ')||'not recorded'}`);
    if(notes.length)changes.push({name,detail:notes.join('\n')});else unchanged++;
  }
  const left=dnsConfig(before.snapshot),right=dnsConfig(after.snapshot);
  return {changes,unchanged,ambiguous,dnsBefore:left,dnsAfter:right,dnsConfiguration: left===null||right===null?'DNS configuration comparison unavailable: one or both reports have no snapshot.':left===right?'DNS configuration unchanged.':'DNS configuration changed (servers, suffixes, resolver scope or NRPT).'};
}
