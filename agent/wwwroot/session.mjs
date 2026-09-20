import { request } from './core.mjs';

export async function stopSession() {
  try {
    await request('/session/quit', {
      method: 'POST', headers: { 'X-LanVibes': 'run' }, timeoutMs: 5000,
      consume: response => response.status
    });
    return 'stopped';
  } catch (error) {
    // A tab can outlive its agent after idle expiry. Network failure cannot
    // prove shutdown, so distinguish unavailable from acknowledged shutdown.
    if (error instanceof TypeError || error.name === 'TimeoutError') return 'unavailable';
    throw error;
  }
}
