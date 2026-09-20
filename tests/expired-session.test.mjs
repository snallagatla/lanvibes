import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
class Node {
  constructor() { this.children=[]; this.listeners={}; this.disabled=false; this.checked=false; this.value=''; }
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(){}
  addEventListener(event,fn){this.listeners[event]=fn;}
}
async function dashboard(key) {
  const nodes=new Map(); const get=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  globalThis.document={getElementById:get,querySelector:get,createElement:()=>new Node(),createDocumentFragment:()=>new Node(),body:new Node()};
  const config=JSON.parse(fs.readFileSync(new URL('../agent/diagnostics.json',import.meta.url)));
  const snapshot=JSON.parse(fs.readFileSync(new URL('../examples/windows-sample.json',import.meta.url)));
  globalThis.fetch=async url=>new Response(JSON.stringify(url==='/config'?config:snapshot));
  await import(`../agent/wwwroot/app.mjs?expired=${key}`);
  for(let i=0;i<30&&!get('testsGrid').children.length;i++)await new Promise(r=>setTimeout(r,5));
  return get;
}
for(const action of ['dnsRefreshBtn','runBtn','systemBtn']) test(`${action}: expired agent blocks new diagnostics and preserves displayed data`,async()=>{
  const get=await dashboard(action); const oldRows=get('testsGrid').children; const dns=get('dnsSections').children; const calls=[];
  globalThis.fetch=async url=>{calls.push(url);throw new TypeError('Failed to fetch');};
  await get(action).listeners.click();
  assert.deepEqual(calls,['/health']);
  assert.equal(get('testsGrid').children,oldRows); assert.equal(get('dnsSections').children,dns);
  assert.match(get('dnsBanner').textContent,/5 minutes of inactivity/);
  assert.match(get('actionDetail').textContent,/use the new browser tab/);
  for(const id of ['runBtn','systemBtn','dnsRefreshBtn'])assert.equal(get(id).disabled,true);
  assert.equal(get('exportBtn').disabled,false);
});
test('agent loss during a run cancels remaining browser and native checks',async()=>{
  const get=await dashboard('during-run'); const calls=[]; let health=0;
  globalThis.fetch=async url=>{calls.push(url);if(url==='/health'&&health++===0)return new Response(JSON.stringify({service:'LanVibes DNS Agent',status:'ok'}));throw new TypeError('Failed to fetch');};
  await get('runBtn').listeners.click();
  assert.deepEqual(calls,['/health','/system','/health']);
  assert.match(get('actionTitle').textContent,/session unavailable/);
  assert.equal(get('status-system').textContent,'Cancelled');
  assert.equal(get('runBtn').disabled,true);
});
