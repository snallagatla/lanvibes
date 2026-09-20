import { request, validateSnapshot, classifyDns, aggregate, RunCoordinator, supportReport, parseDiagnosticImport, MAX_IMPORT_BYTES } from './core.mjs';
import { native, browserTests, latency, download, upload } from './probes.mjs';
import { stopSession } from './session.mjs';
import { parseTargets, MAX_TARGET_FILE_BYTES } from './targets.mjs';
import { matchesResult, retryCandidates, compareReports } from './review.mjs';
let customTargets = [];
let importedReport = null, importedPage = 0;
let rowPage = 0, rowTests = [], rowsShowResults = true;
const PAGE_SIZE = 100, resultIndexes = new Map(), visibleRows = new Set();
let customCounts = {};
function renderCustomSummary() {
  $('customResultsCounts').textContent = `${rowTests.length} applications · ${customCounts.pass || 0} succeeded · ${customCounts.fail || 0} failed · ${customCounts.inconclusive || 0} inconclusive · ${customCounts['not-applicable'] || 0} skipped · ${customCounts.cancelled || 0} cancelled · ${customCounts.pending || 0} running · ${customCounts['not-run'] || 0} not run`;
}
const $ = id => document.getElementById(id);
const colors = { pass: 'ok', fail: 'fail', inconclusive: 'warn', pending: 'pending', cancelled: 'pending', 'not-applicable': 'pending' };
const labels = { pass: 'Pass', fail: 'Fail', inconclusive: 'Inconclusive', pending: 'Pending', cancelled: 'Cancelled', 'not-applicable': 'Not applicable' };
const coordinator = new RunCoordinator();
let config, snapshot, source = 'Local agent', showAll = false, tests = [], results = [], idleBaseline = null;
let dnsGeneration = 0, dnsController, systemController;
let progressRun = null;
let sessionEnded = false;
let startingAction = false;
function agentUnavailable() {
  sessionEnded = true;
  coordinator.stop(); dnsController?.abort(); systemController?.abort();
  lock(false); $('dnsRefreshBtn').disabled = true;
  $('actionTitle').textContent = 'Local LanVibes session unavailable';
  const message = 'The local agent is no longer reachable. It may have shut down after 5 minutes of inactivity. Open LanVibes again from Start (Windows) or Applications (macOS) and use the new browser tab. This tab cannot restart the agent.';
  $('actionDetail').textContent = message;
  banner(`${message} Previous snapshots and results remain available for export, but are not current.`, 'warn');
}
async function ensureAgentAvailable(signal) {
  if (sessionEnded || signal?.aborted) return false;
  try {
    const health = await request('/health', { signal, timeoutMs: 5000 });
    if (health.service !== 'LanVibes DNS Agent' || health.status !== 'ok') throw new Error('Unexpected local agent response');
    return !sessionEnded;
  } catch {
    if (!signal?.aborted) agentUnavailable();
    return false;
  }
}
async function prepareAction() {
  if (startingAction || sessionEnded) return false;
  startingAction = true; lock(true); $('stopBtn').disabled = true;
  try { return await ensureAgentAvailable(); }
  finally { startingAction = false; lock(!!coordinator.controller || !!systemController); }
}
async function agentOperation(action, signal) {
  try { return await action(); }
  catch (error) {
    if (!signal?.aborted) await ensureAgentAvailable(signal);
    throw error;
  }
}
function startProgress(scope) {
  progressRun = { ids: new Set(scope.map(t => t.id)), values: new Map(), finished: 0, skipped: 0, current: null, phase: 'running' };
  $('runProgress').hidden = false;
  renderProgress();
}
function renderProgress() {
  if (!progressRun) return;
  const { finished, skipped, current } = progressRun;
  const total = progressRun.ids.size;
  $('progressBar').max = total || 1;
  $('progressBar').value = finished;
  $('progressCount').textContent = `${finished} / ${total} checks finished${skipped ? ` · ${skipped} skipped` : ''}`;
  $('progressPercent').textContent = `${total ? Math.round(finished / total * 100) : 0}%`;
  $('progressDetail').textContent = progressRun.phase === 'stopping' ? 'Stopping current check…' :
    progressRun.phase === 'finished' ? (finished === total ? 'Run complete.' : 'Run stopped — partial results retained.') :
    current ? `Running: ${current.name}` : 'Preparing checks…';
}
function finishProgress() {
  if (progressRun) { progressRun.phase = 'finished'; renderProgress(); }
}
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function banner(message, severity = 'warn') { $('dnsBanner').textContent = message; $('dnsBanner').className = `dns-banner ${severity}`; }
function renderSnapshot() {
  if (!snapshot) return;
  const fragment = document.createDocumentFragment();
  const add = (name, text, servers = []) => {
    const card = el('article', null, 'dns-item'); card.append(el('h3', name), el('p', text));
    if (servers.length) card.append(el('p', `DNS: ${servers.join(', ')}`), el('p', classifyDns(servers, config)));
    fragment.append(card);
  };
  const active = snapshot.adapters.filter(a => a.status === 'Up' && a.type !== 'Loopback' && a.addresses.length && (a.dnsServers.length || a.gateways.length));
  $('dnsShowAllBtn').hidden = active.length === snapshot.adapters.length;
  $('dnsShowAllBtn').textContent = showAll ? 'Show active adapters' : `Show all adapters (${snapshot.adapters.length})`;
  $('dnsShowAllBtn').setAttribute('aria-pressed', String(showAll));
  for (const a of showAll ? snapshot.adapters : active)
    add(`${a.name} — ${a.status}`, `${a.type}\nIP: ${a.addresses.join(', ') || 'None'}\nGateway: ${a.gateways.join(', ') || 'None'}\nSuffix: ${a.dnsSuffix || 'None'}`, a.dnsServers);
  if (!active.length && !showAll) add('No qualifying active adapters', 'Show all adapters to inspect disconnected or virtual interfaces.');
  for (const r of snapshot.resolvers) add(`${r.kind}: ${r.domain || 'Default resolver'}`, `Interface: ${r.interface || 'Not reported'}\nSearch: ${r.searchDomains.join(', ')}\nFlags: ${r.flags || ''}\nOrder: ${r.order ?? ''}`, r.nameServers);
  if (snapshot.os === 'Windows' && !snapshot.nrpt.length) add('Effective NRPT', 'No rules returned. Check collection warnings; VPN-specific mechanisms may still apply.');
  for (const r of snapshot.nrpt) add(`Effective NRPT: ${r.namespace}`, '', r.nameServers);
  for (const warning of snapshot.warnings) add('Collection limitation', warning);
  $('dnsSections').replaceChildren(fragment);
  const age = Date.now() - Date.parse(snapshot.capturedAt);
  banner(`${snapshot.os} · ${source} · Captured ${new Date(snapshot.capturedAt).toLocaleString()}${age > 300000 ? ' · More than 5 minutes old' : ''}\nConfigured candidates do not prove which resolver processed a query.`, snapshot.warnings.length || age > 300000 ? 'warn' : 'ok');
}
async function refreshDns(manual = false) {
  if (sessionEnded || (manual && !await prepareAction())) return;
  const generation = ++dnsGeneration;
  dnsController?.abort(); dnsController = new AbortController();
  banner('Reading local DNS configuration…');
  try {
    const value = validateSnapshot(await request('/dns', { signal: dnsController.signal, timeoutMs: 12000 }));
    if (generation !== dnsGeneration) return;
    if (sessionEnded) return;
    snapshot = value; source = 'Local agent'; renderSnapshot();
  } catch (error) {
    if (generation !== dnsGeneration) return;
    if (sessionEnded || (!dnsController.signal.aborted && !await ensureAgentAvailable(dnsController.signal))) return;
    banner(`Local DNS unavailable: ${error.message}. ${snapshot ? 'Previous snapshot remains visible; it is not current.' : 'Check that the agent is running or import a snapshot.'}`);
  }
}
$('dnsRefreshBtn').addEventListener('click', () => refreshDns(true));
$('dnsShowAllBtn').addEventListener('click', () => { showAll = !showAll; renderSnapshot(); });
$('dnsImportFile').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  const generation = ++dnsGeneration; dnsController?.abort();
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('File exceeds 128 MB');
    const value = parseDiagnosticImport(JSON.parse(await file.text()));
    if (generation !== dnsGeneration) return;
    if (value.kind === 'report') renderImportedReport(value);
    else $('importedReportPanel').hidden = true;
    if (value.snapshot) {
      snapshot = value.snapshot; source = value.kind === 'report' ? 'DNS snapshot from imported support report' : 'Imported snapshot'; renderSnapshot();
    } else {
      banner(`Support report imported. ${value.redacted ? 'DNS configuration was removed by redaction and cannot be restored.' : 'This report contains no DNS snapshot.'} ${snapshot ? 'The previous DNS snapshot remains visible separately.' : 'Use Refresh local DNS to read this workstation.'}`);
    }
  } catch (error) { if (generation === dnsGeneration) banner(`Import failed: ${String(error.message || 'Invalid JSON').replace(/[.]+$/, '')}. Previous valid data retained.`); }
  finally { event.target.value = ''; }
});

function renderImportedReport(report, page = 0) {
  importedReport = report; importedPage = page;
  const fragment = document.createDocumentFragment();
  for (const result of report.results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    const card = el('article', null, 'test');
    const heading = el('div', null, 'test-head');
    heading.append(el('strong', result.name), el('span', labels[result.status], `pill ${colors[result.status]}`));
    card.append(heading, el('p', result.detail, 'details'));
    for (const check of result.checks) {
      const item = el('details');
      item.append(el('summary', `${check.name}: ${labels[check.status]}${check.milliseconds != null ? ` (${check.milliseconds} ms)` : ''}`), el('p', check.detail, 'details'));
      card.append(item);
    }
    fragment.append(card);
  }
  if (!report.results.length) fragment.append(el('p', 'No test results were included in this report.'));
  $('importedReportResults').replaceChildren(fragment);
  $('importedReportInfo').textContent = `Saved report exported ${new Date(report.exportedAt).toLocaleString()} · ${report.results.length} test results. ` +
    (report.redacted ? 'Redacted: test names, details and DNS configuration were omitted and cannot be recovered.' : report.snapshot ? 'Includes a saved DNS snapshot, shown in the DNS panel.' : 'No DNS snapshot was included.') +
    ' These are saved observations, not a current run. Importing does not execute tests or change current run results.';
  $('importedReportPanel').hidden = false;
  $('importedPageInfo').textContent = `Page ${page + 1} of ${Math.max(1, Math.ceil(report.results.length / PAGE_SIZE))}`;
  $('importedPrevBtn').disabled = page === 0;
  $('importedNextBtn').disabled = (page + 1) * PAGE_SIZE >= report.results.length;
}
$('importedPrevBtn').addEventListener('click', () => { if (importedReport && importedPage > 0) renderImportedReport(importedReport, importedPage - 1); });
$('importedNextBtn').addEventListener('click', () => { if (importedReport && (importedPage + 1) * PAGE_SIZE < importedReport.results.length) renderImportedReport(importedReport, importedPage + 1); });
$('closeImportedReportBtn').addEventListener('click', () => { $('importedReportPanel').hidden = true; });
document.querySelector('label[for="dnsImportFile"]').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('dnsImportFile').click(); }
});
function buildRows(showResults = rowsShowResults) {
  rowsShowResults = showResults;
  rowTests = tests.filter(test => test.custom);
  visibleRows.clear();
  $('testsGrid').replaceChildren();
  $('customResultsGrid').replaceChildren();
  $('customResultsGroup').hidden = rowTests.length === 0;
  $('customResultsTitle').textContent = $('customDnsOnly').checked || customTargets.every(t => t.mode === 'dns') ? 'Custom DNS resolution — summary' : 'Custom application accessibility — summary';
  customCounts = {};
  for (const test of rowTests) {
    const status = showResults ? resultFor(test)?.status ?? 'not-run' : 'not-run';
    customCounts[status] = (customCounts[status] || 0) + 1;
  }
  renderCustomSummary();
  const matches = test => matchesResult(test, showResults ? resultFor(test) : undefined, $('resultSearch').value, $('resultStatus').value);
  const filtered = rowTests.filter(matches);
  rowPage = Math.min(rowPage, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  $('resultsPageInfo').textContent = `${filtered.length} matching / ${rowTests.length} tests · Page ${rowPage + 1} of ${Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}`;
  $('resultsPrevBtn').disabled = rowPage === 0;
  $('resultsNextBtn').disabled = (rowPage + 1) * PAGE_SIZE >= filtered.length;
  $('filterInfo').textContent = `${tests.filter(matches).length} of ${tests.length} tests match. Summary counts and exports include all results.`;
  for (const test of [...tests.filter(test => !test.custom && matches(test)), ...filtered.slice(rowPage * PAGE_SIZE, (rowPage + 1) * PAGE_SIZE)]) {
    visibleRows.add(test.id);
    const card = el('article', null, 'test'); card.id = `test-${test.id}`;
    const head = el('div', null, 'test-head'); head.append(el('strong', test.name));
    const status = el('span', 'Not run', 'pill pending'); status.id = `status-${test.id}`; head.append(status);
    const detail = el('div', 'Runs only when requested.', 'details'); detail.id = `detail-${test.id}`;
    card.append(head, detail); $(test.custom ? 'customResultsGrid' : 'testsGrid').append(card);
    const existing = resultFor(test);
    if (showResults && existing) renderResult(test, existing);
  }
}
function resultFor(test) {
  const record=results[resultIndexes.get(test.id)];
  return record?.name===test.name ? record : undefined;
}
$('resultsPrevBtn').addEventListener('click', () => { rowPage = Math.max(0, rowPage - 1); buildRows(); });
$('resultsNextBtn').addEventListener('click', () => { rowPage++; buildRows(); });
$('resultSearch').addEventListener('input', () => { rowPage=0; buildRows(); });
$('resultStatus').addEventListener('change', () => { rowPage=0; buildRows(); });
function display(test, value) {
  if (progressRun?.phase !== 'finished' && progressRun?.ids.has(test.id)) {
    const previous = progressRun.values.get(test.id);
    const done = status => status && !['pending', 'cancelled'].includes(status) ? 1 : 0;
    progressRun.finished += done(value.status) - done(previous);
    progressRun.skipped += Number(value.status === 'not-applicable') - Number(previous === 'not-applicable');
    progressRun.values.set(test.id, value.status);
    if (value.status === 'pending') progressRun.current = { id: test.id, name: test.name };
    else if (progressRun.current?.id === test.id) progressRun.current = null;
    renderProgress();
  }
  const record = { ...value, id: test.id, name: test.name, informational: !!test.informational,
    ...(value.status !== 'pending' ? { observedAt: new Date().toISOString() } : {}) };
  const index = resultIndexes.get(test.id);
  if (test.custom) {
    const previous = index === undefined ? 'not-run' : results[index].status;
    customCounts[previous] = (customCounts[previous] || 0) - 1;
    customCounts[value.status] = (customCounts[value.status] || 0) + 1;
    renderCustomSummary();
  }
  if (index === undefined) { resultIndexes.set(test.id, results.length); results.push(record); } else results[index] = record;
  if (visibleRows.has(test.id)) renderResult(test, record);
}
function renderResult(test, value) {
  const status = $(`status-${test.id}`); status.className = `pill ${colors[value.status] || 'pending'}`;
  status.textContent = labels[value.status] || value.status;
  const detail = $(`detail-${test.id}`); detail.replaceChildren(el('p', value.detail || ''));
  if (value.observedAt) detail.append(el('p', `Result recorded: ${new Date(value.observedAt).toLocaleString()}`));
  if (value.checks) for (const check of value.checks) {
    const item = el('details'); item.append(el('summary', `${check.name}: ${labels[check.status]}${check.milliseconds != null ? ` (${check.milliseconds} ms)` : ''}`), el('p', check.detail));
    detail.append(item);
  }
}
function summary(running = false) {
  if (sessionEnded) return;
  const current=tests.map(resultFor).filter(Boolean);
  const cancelled = current.some(r => r.status === 'cancelled');
  const state = running ? 'pending' : aggregate(current.filter(r => !r.informational));
  $('overallPill').className = `overall ${colors[state]}`;
  $('overallText').textContent = running ? 'Running' : cancelled ? 'Stopped — incomplete' : labels[state];
  $('actionTitle').textContent = running ? 'Checks running in sequence' : cancelled ? 'Run stopped; completed observations retained' : 'Diagnostic observations ready';
  $('actionDetail').textContent = running ? 'Idle latency is measured before transfers. Stop cancels active requests.' :
    'Review the stages below. A failed or inconclusive probe does not identify a unique cause. HTTP responses and TLS success do not establish application login health.';
}
function lock(running) {
  $('retryBtn').disabled = running || !config || sessionEnded || !retryCandidates(tests,results).length;
  $('resultSearch').disabled = $('resultStatus').disabled = running;
  $('customDnsOnly').disabled = running || !config || sessionEnded;
  $('chooseTargetsBtn').disabled = $('targetImportFile').disabled = $('clearTargetsBtn').disabled = running || !config || sessionEnded;
  $('runBtn').disabled = running || !config || sessionEnded; $('stopBtn').disabled = !running || sessionEnded;
  $('profile').disabled = $('includeSpeed').disabled = $('systemBtn').disabled = running || !config || sessionEnded;
  if ($('customDnsOnly').checked) { $('systemBtn').disabled = $('includeSpeed').disabled = true; if (!customTargets.length) $('runBtn').disabled = true; }
}
async function run(retry = false) {
  if (!config || sessionEnded || coordinator.controller || systemController) return;
  if (!await prepareAction()) return;
  configureTests();
  const scope = retry ? retryCandidates(tests,results) : tests;
  if (!scope.length) { lock(false); return; }
  if (!retry) { results = []; resultIndexes.clear(); idleBaseline = null; }
  rowPage = 0;
  $('resultSearch').value = ''; $('resultStatus').value = 'all';
  lock(true); buildRows(true); summary(true); startProgress(scope);
  const profile = $('profile').value, speed = $('includeSpeed').checked;
  const selected = scope.map(test => ({ ...test, run: signal => {
    if (test.corporate && profile === 'home') return { status: 'not-applicable', detail: 'Not tested because Home / off VPN was selected. This says nothing about actual VPN connectivity. Select Office or VPN above and rerun to test this target.' };
    if (test.speed && !speed) return { status: 'not-applicable', detail: 'Speed tests not selected.' };
    return test.agent ? agentOperation(() => test.run(signal), signal) : test.run(signal);
  }}));
  try { await coordinator.run(selected, display); }
  finally { finishProgress(); buildRows(true); lock(false); summary(); }
}
$('runBtn').addEventListener('click', () => run());
$('retryBtn').addEventListener('click', () => run(true));
$('stopBtn').addEventListener('click', () => {
  if (progressRun) { progressRun.phase = 'stopping'; renderProgress(); }
  coordinator.stop(); systemController?.abort();
});
$('systemBtn').addEventListener('click', async () => {
  if (sessionEnded || coordinator.controller || systemController) return;
  if (!await prepareAction()) return;
  systemController = new AbortController(); lock(true);
  const test = tests.find(t => t.id === 'system');
  if (!test) { systemController = null; lock(false); return; }
  startProgress([test]);
  try { display(test, { status: 'pending', detail: 'Reading local settings…' }); display(test, await agentOperation(() => test.run(systemController.signal), systemController.signal)); }
  catch (error) { display(test, { status: systemController.signal.aborted ? 'cancelled' : 'inconclusive', detail: error.message }); }
  finally { systemController = null; finishProgress(); lock(false); summary(); }
});
$('exportBtn').addEventListener('click', () => {
  const report = supportReport(snapshot, results);
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  if (blob.size > MAX_IMPORT_BYTES) { banner('Support report exceeds the supported 128 MB file size and could not be exported.'); return; }
  const url = URL.createObjectURL(blob);
  const link = el('a'); link.href = url; link.download = `lanvibes-${Date.now()}.json`; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function init() {
  lock(false);
  try {
    config = await request('/config');
    if (sessionEnded) return;
    $('quitBtn').hidden = !config.desktopSession;
    $('sessionNote').hidden = !config.desktopSession;
    configureTests();
    buildRows(); lock(false); renderSnapshot();
  } catch (error) {
    config = null; lock(false);
    $('actionTitle').textContent = 'Diagnostic configuration unavailable';
    $('actionDetail').textContent = `${error.message}. Open LanVibes from Start to create a fresh session. If it is already open, reload this page. Saved results can still be exported.`;
  }
}
function configureTests() {
    tests = [
      { id: 'system', agent: true, name: 'Local routes, proxy and link', informational: true, run: async signal => {
        const checks = await request('/system', { signal, timeoutMs: 35000 });
        return { status: aggregate(checks), checks, detail: 'Read-only local configuration. Command success is not a network health verdict.' };
      }},
      { id: 'latency', name: 'Idle HTTP latency', informational: true, run: async signal => { const value = await latency(config, signal); idleBaseline = value; return value; } },
      ...config.targets.map(target => ({ id: `target-${target.id}`, destination: target.url, agent: true, name: `${target.name}: DNS → TCP → TLS → HTTP`, corporate: target.corporate, run: signal => native(target.id, signal) })),
      ...customTargets.map(target => {
        const dnsOnly = $('customDnsOnly').checked || target.mode === 'dns';
        return { id: target.id, agent: true, custom: true, name: `${target.name} (${target.url ?? target.dns}): ${dnsOnly ? 'DNS resolution only' : 'DNS → TCP → TLS → HTTP'}`, corporate: target.corporate,
          run: signal => native('custom', signal, { ...target, mode: dnsOnly ? 'dns' : 'full' }) };
      }),
      { id: 'dns-servers', agent: true, name: 'Configured DNS: UDP and TCP, A and AAAA', informational: true, run: signal => native('dns-servers', signal) },
      { id: 'ping', agent: true, name: 'ICMP latency, jitter and loss', informational: true, run: signal => native('ping', signal) },
      { id: 'portal', agent: true, name: 'Captive-portal observation', informational: true, run: signal => native('portal', signal) },
      ...browserTests(config),
      { id: 'download', name: 'Download and loaded HTTP latency', speed: true, informational: true, run: signal => download(config, signal, idleBaseline) },
      { id: 'upload', name: 'Upload request/response estimate', speed: true, informational: true, run: signal => upload(config, signal) }
    ];
    if ($('customDnsOnly').checked) tests = tests.filter(test => test.custom);
}
function updateCustomTargets(value) {
  $('customResultsGroup').open = false;
  customTargets = value;
  $('customTargetList').replaceChildren(...value.slice(0, PAGE_SIZE).map(t => el('li', `${t.name} — ${t.url ?? t.dns} (${t.mode === 'dns' ? 'DNS only' : 'DNS/TCP/TLS/HTTP'})${t.corporate ? ' (Office/VPN only)' : ''}`)));
  $('targetImportStatus').textContent = `${value.length} custom applications ready${value.length > PAGE_SIZE ? '; preview shows the first 100' : ''}. Click Run network tests to produce results. Corporate entries require Office or VPN. Previous results remain exportable until the next run.`;
  configureTests();
  rowPage = 0; buildRows(false);
  lock(false);
}
$('customDnsOnly').addEventListener('change', () => { configureTests(); rowPage = 0; buildRows(false); lock(false); });
$('chooseTargetsBtn').addEventListener('click', () => $('targetImportFile').click());
$('targetImportFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file || !config || sessionEnded || coordinator.controller || systemController) return;
  try {
    if (file.size > MAX_TARGET_FILE_BYTES) throw new Error('Maximum file size is 32 MB.');
    const value = parseTargets(await file.text());
    if (sessionEnded || coordinator.controller || systemController) throw new Error('Wait for the current operation to finish and import again.');
    updateCustomTargets(value);
    $('targetFileName').textContent = file.name || 'Imported file';
  } catch (error) { $('targetImportStatus').textContent = `Import failed: ${error.message} Previous custom list retained.`; }
  // Reset only the hidden picker so the same file can be imported again after editing.
  // The visible label continues to identify the successfully loaded list.
  finally { event.target.value = ''; }
});
$('clearTargetsBtn').addEventListener('click', () => {
  if (config && !sessionEnded && !coordinator.controller && !systemController) {
    updateCustomTargets([]);
    $('targetFileName').textContent = 'No file chosen';
  }
});
// Startup performs only same-origin reads. No native or browser remote probes are run here.
$('quitBtn').addEventListener('click', async () => {
  $('quitBtn').disabled = true;
  try {
    const outcome = await stopSession();
    sessionEnded = true;
    coordinator.stop(); dnsController?.abort(); systemController?.abort();
    lock(false);
    $('dnsRefreshBtn').disabled = true;
    const message = outcome === 'stopped' ? 'LanVibes has stopped.' : 'This local session is no longer reachable. It may have ended after 5 minutes of inactivity; shutdown could not be confirmed.';
    $('actionTitle').textContent = outcome === 'stopped' ? 'LanVibes has stopped' : 'Local session unavailable';
    $('actionDetail').textContent = `${message} You can close this tab now, or export the results first. Open LanVibes again to begin a new session. If this tab stays open, your browser prevented automatic closing.`;
    banner(`${message} You can close this tab now, or export the results shown here first.`, outcome === 'stopped' ? 'ok' : 'warn');
    // Close only this tab, after shutdown or an unreachable/expired session. Some browsers
    // refuse to close tabs opened by an external application; keep the fallback UI.
    try { window.close(); } catch { /* Browser restrictions do not undo shutdown. */ }
  } catch (error) { banner(`Could not stop LanVibes: ${error.message}`); $('quitBtn').disabled = false; }
});
refreshDns(); init();

const comparisonReports = { Before: null, After: null };
let comparison = null, comparisonPage = 0;
function clearComparison() {
  comparison = null; comparisonPage = 0;
  $('compareRows').replaceChildren(); $('comparePageInfo').textContent='';
  $('compareDnsDifference').hidden=true;
  $('comparePrevBtn').disabled=$('compareNextBtn').disabled=true;
}
function renderComparison() {
  if (!comparison) return;
  $('compareDnsDifference').hidden=!comparison.dnsBefore || !comparison.dnsAfter || comparison.dnsBefore===comparison.dnsAfter;
  const pretty=value=>value ? JSON.stringify(JSON.parse(value),null,2):'';
  $('compareDnsBefore').textContent=`Earlier DNS configuration:\n${pretty(comparison.dnsBefore)}`;
  $('compareDnsAfter').textContent=`Later DNS configuration:\n${pretty(comparison.dnsAfter)}`;
  $('compareRows').replaceChildren(...comparison.changes.slice(comparisonPage*PAGE_SIZE,(comparisonPage+1)*PAGE_SIZE).map(change=>{
    const card=el('article',null,'test'); card.append(el('strong',change.name),el('p',change.detail,'details')); return card;
  }));
  $('comparePageInfo').textContent=`Page ${comparisonPage+1} of ${Math.max(1,Math.ceil(comparison.changes.length/PAGE_SIZE))}`;
  $('comparePrevBtn').disabled=comparisonPage===0;
  $('compareNextBtn').disabled=(comparisonPage+1)*PAGE_SIZE>=comparison.changes.length;
}
for (const side of ['Before','After']) {
  $(`choose${side}Btn`).addEventListener('click',()=> $(`compare${side}File`).click());
  $(`compare${side}File`).addEventListener('change',async event=>{
    const file=event.target.files?.[0]; if(!file)return;
    try {
      if(file.size>MAX_IMPORT_BYTES)throw new Error('Maximum report size is 128 MB.');
      const parsed=parseDiagnosticImport(JSON.parse(await file.text()));
      if(parsed.kind!=='report')throw new Error('Choose a support report containing test results, not a DNS snapshot.');
      if(parsed.redacted)throw new Error('Choose an unredacted report with test names.');
      comparisonReports[side]=parsed;
      $(`compare${side}Name`).textContent=file.name || 'Imported report';
      clearComparison(); $('compareInfo').textContent='Report loaded. Choose Compare reports when both runs are ready.';
    } catch(error){$('compareInfo').textContent=`Import failed: ${error.message} Previous report retained.`;}
    finally {event.target.value='';}
  });
}
$('compareCurrentBtn').addEventListener('click',()=>{
  if(coordinator.controller || systemController || startingAction){$('compareInfo').textContent='Wait for the run to finish or stop it before comparing.';return;}
  if(!results.length){$('compareInfo').textContent='No current results are available.';return;}
  comparisonReports.After=JSON.parse(JSON.stringify(supportReport(snapshot,results)));
  $('compareAfterName').textContent='Current results (captured for comparison)'; clearComparison();
  $('compareInfo').textContent='Current results copied. Choose an earlier report, then Compare reports.';
});
$('compareBtn').addEventListener('click',()=>{
  if(!comparisonReports.Before || !comparisonReports.After){$('compareInfo').textContent='Choose both an earlier and a later run.';return;}
  try {
    comparison=compareReports(comparisonReports.Before,comparisonReports.After); comparisonPage=0;
    $('compareInfo').textContent=`${comparison.changes.length-comparison.ambiguous} changed, added or missing tests · ${comparison.unchanged} unchanged · ${comparison.ambiguous} ambiguous names. ${comparison.dnsConfiguration} Reports exported ${comparisonReports.Before.exportedAt} and ${comparisonReports.After.exportedAt}. Partial runs may contain missing or cancelled results.`;
    renderComparison();
  } catch(error){clearComparison();$('compareInfo').textContent=error.message;}
});
$('comparePrevBtn').addEventListener('click',()=>{if(comparison&&comparisonPage>0){comparisonPage--;renderComparison();}});
$('compareNextBtn').addEventListener('click',()=>{if(comparison&&(comparisonPage+1)*PAGE_SIZE<comparison.changes.length){comparisonPage++;renderComparison();}});
clearComparison();
