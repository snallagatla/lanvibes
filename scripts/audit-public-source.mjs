import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, publicFiles } from './public-files.mjs';

export function audit(base = root) {
  const files = publicFiles(base), issues = [], urls = new Set();
  const binary = /\.(png|ico|icns)$/i;
  const checks = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['cloud access key', /\bAKIA[0-9A-Z]{16}\b/],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
    ['Azure subscription path', /\/subscriptions\/[0-9a-f]{8}-[0-9a-f-]{27,}/i],
    ['personal machine path', /[A-Z]:[\\/]Users[\\/](?!<|example\b|Public\b)[^\s\\/]+/i],
    ['personal email', /\b[A-Z0-9._%+-]+@(?:hotmail|gmail|outlook|live)\.com\b/i]
  ];
  for (const file of files) {
    if (binary.test(file)) continue;
    const text = fs.readFileSync(path.join(base,file),'utf8');
    // Upstream notices must retain their original authors and contact information.
    if (!file.startsWith('licenses/')) {
      for (const [label, pattern] of checks) if (pattern.test(text)) issues.push(`${file}: possible ${label}`);
      for (const match of text.matchAll(/(?:https?|wss):\/\/[^\s<>"'`\)]+/g)) urls.add(`${file}\t${match[0]}`);
    }
  }
  const config = JSON.parse(fs.readFileSync(path.join(base,'agent/diagnostics.json'),'utf8'));
  if (config.targets.length !== 1 || config.targets[0].url !== 'https://example.com/' || config.targets[0].corporate)
    issues.push('Default targets must contain only the neutral public example target');
  if (config.managedDnsServers?.length !== 0 || config.legacyDnsServers?.length !== 0)
    issues.push('Default DNS inventories must be empty');
  const publicHosts = new Set(['example.com','api.ipify.org','api6.ipify.org','ipv4.icanhazip.com','ipv6.icanhazip.com','speed.cloudflare.com','dns.google','cloudflare-dns.com','ws.postman-echo.com','echo.websocket.events']);
  function inspect(value) {
    if (typeof value === 'string' && /^(https?|wss):/.test(value)) {
      const url = new URL(value);
      if (!publicHosts.has(url.hostname) || url.username || url.password) issues.push('Unreviewed default endpoint');
    } else if (value && typeof value === 'object') for (const v of Object.values(value)) inspect(v);
  }
  inspect(config);
  const metadata = JSON.parse(fs.readFileSync(path.join(base,'packaging/signing-metadata.example.json'),'utf8'));
  for (const field of ['Endpoint','CodeSigningAccountName','CertificateProfileName'])
    if (!metadata[field]?.includes('<')) issues.push(`Signing example ${field} must use a placeholder`);
  if (issues.length) throw new Error(issues.join('\n'));
  return { files, urls: [...urls].sort() };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = audit();
  fs.mkdirSync(path.join(root,'dist'),{recursive:true});
  fs.writeFileSync(path.join(root,'dist/public-url-inventory.txt'),result.urls.join('\n')+'\n');
  console.log(`PASS public source audit: ${result.files.length} files; URL inventory saved in dist/public-url-inventory.txt`);
}
