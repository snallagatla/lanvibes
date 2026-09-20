import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('..', import.meta.url));
export const topFiles = ['.gitignore','.gitattributes','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','PUBLIC-RELEASE.md','README.md','RFC_Offline_First_Amendment.md','NuGet.Config'];
const directories = ['agent','tests','examples','packaging','scripts','licenses','website'];
const extensions = new Set(['.cs','.csproj','.mjs','.html','.css','.json','.ps1','.sh','.md','.wxs','.plist','.svg','.png','.ico','.icns','.txt']);
export function publicFiles(base) {
  const files = topFiles.filter(f => fs.existsSync(path.join(base,f)));
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(base,relative),{withFileTypes:true})) {
      if (entry.name.startsWith('.') || ['bin','obj','node_modules','payloads','output'].includes(entry.name)) continue;
      const name = `${relative}/${entry.name}`;
      if (relative === 'examples' && !['custom-applications.json','windows-sample.json','macos-sample.json'].includes(entry.name)) continue;
      if (entry.isDirectory()) { walk(name); continue; }
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link: ${name}`);
      if (name === 'packaging/signing-metadata.json' || /\.local\./i.test(name)) continue;
      if (!extensions.has(path.extname(name).toLowerCase())) throw new Error(`Unreviewed source file type: ${name}`);
      files.push(name);
    }
  }
  for (const dir of directories) if (fs.existsSync(path.join(base,dir))) walk(dir);
  return files.sort();
}
