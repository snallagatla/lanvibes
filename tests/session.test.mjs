import test from 'node:test';
import assert from 'node:assert/strict';
import { stopSession } from '../agent/wwwroot/session.mjs';

test('Quit acknowledges a successful authenticated shutdown', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/session/quit');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['X-LanVibes'], 'run');
    return new Response(null, { status: 200 });
  };
  assert.equal(await stopSession(), 'stopped');
});
test('Quit handles a tab left behind by idle exit without claiming confirmed shutdown', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await stopSession(), 'unavailable');
});
test('Quit handles a network timeout as unavailable', async () => {
  globalThis.fetch = async () => { throw new DOMException('Request timed out', 'TimeoutError'); };
  assert.equal(await stopSession(), 'unavailable');
});
test('Quit preserves genuine HTTP errors for retry', async () => {
  for (const status of [403,500]) {
    globalThis.fetch = async () => new Response(null, { status });
    await assert.rejects(stopSession(), new RegExp(`HTTP ${status}`));
  }
});
