export const MAX_TARGET_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_TARGETS = 10000;
export function parseTargets(text) {
  if (new TextEncoder().encode(text).length > MAX_TARGET_FILE_BYTES) throw new Error('Maximum file size is 32 MB.');
  const trimmed = text.trim();
  const rows = trimmed.startsWith('[') || trimmed.startsWith('{') ? JSON.parse(trimmed) : trimmed.split(/\r?\n/).filter(line => line.trim());
  const items = Array.isArray(rows) ? rows : rows?.targets;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_TARGETS) throw new Error('Import between 1 and 10,000 applications.');
  const seen = new Set();
  return items.map((item, index) => {
    try {
      const value = typeof item === 'string' ? { url: item.trim() } : item;
      if (!value || typeof value !== 'object') throw new Error('Expected an application object.');
      if (value.url !== undefined && value.dns !== undefined) throw new Error('Specify url or dns, not both.');
      let url, dns, host;
      if (value.dns !== undefined) {
        if (typeof value.dns !== 'string') throw new Error('Invalid DNS hostname.');
        dns = value.dns.trim().replace(/\.$/, '').toLowerCase();
        if (!dns || dns.length > 253 || dns.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error('Use a DNS hostname without a scheme, path or port.');
        host = dns;
      } else {
        if (typeof value.url !== 'string') throw new Error('Provide url or dns.');
        let raw = value.url.trim();
        const markdown = raw.match(/^\[[^\]]*\]\((https:\/\/[^\s]+)\)$/i);
        if (markdown) raw = markdown[1];
        if (raw.length > 2048) throw new Error('URL exceeds 2048 characters.');
        const parsed = new URL(raw);
        if (parsed.href.length > 2048) throw new Error('Normalized URL exceeds 2048 characters.');
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('Use HTTPS URLs without credentials or fragments.');
        url = parsed.href; host = parsed.hostname;
      }
      const mode = value.mode ?? (dns ? 'dns' : 'full');
      if (!['dns','full'].includes(mode) || (dns && mode !== 'dns')) throw new Error('mode must be dns or full; dns entries require dns mode.');
      const name = value.name ?? host;
      if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Application names must contain 1–100 characters.');
      if (value.corporate !== undefined && typeof value.corporate !== 'boolean') throw new Error('corporate must be true or false.');
      const key = `${mode}:${url ?? dns}:${value.corporate ?? false}`;
      if (seen.has(key)) throw new Error('Duplicate application destination and test mode.');
      seen.add(key);
      return { id: `custom-${index + 1}`, name: name.trim(), ...(url ? { url } : { dns }), mode, corporate: value.corporate ?? false };
    } catch (error) { throw new Error(`Application ${index + 1}: ${error.message}`); }
  });
}
