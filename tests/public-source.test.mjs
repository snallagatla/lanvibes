import test from 'node:test';
import assert from 'node:assert/strict';
import { audit } from '../scripts/audit-public-source.mjs';
test('public source has neutral defaults and excludes generated/private artifacts', () => {
  const {files} = audit();
  assert.deepEqual(files.filter(f => f.startsWith('examples/')), ['examples/custom-applications.json','examples/macos-sample.json','examples/windows-sample.json']);
  assert.ok(files.includes('LICENSE'));
  assert.ok(files.includes('.gitignore'));
  assert.ok(files.includes('packaging/signing-metadata.example.json'));
  assert.ok(!files.some(f => /(^|\/)(dist|bin|obj|\.build)\/|signing-metadata\.json$|\.(pfx|pdb|exe|zip)$/.test(f)));
});
