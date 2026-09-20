import fs from 'node:fs';
import path from 'node:path';
import { root } from './public-files.mjs';
import { audit } from './audit-public-source.mjs';
const { files } = audit();
const version = fs.readFileSync(path.join(root,'agent/LanVibes.DnsAgent.csproj'),'utf8').match(/<Version>([^<]+)<\/Version>/)[1];
const output = path.join(root,'dist',`LanVibes-${version}-public-source-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
for (const file of files) {
  const target = path.join(output,file);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(path.join(root,file),target);
}
audit(output);
// Standard uncompressed ZIP; keeps dotfiles and adds no machine paths or timestamps.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let i=0;i<8;i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
const local=[],central=[]; let offset=0;
for (const file of files) {
  const name=Buffer.from(file),data=fs.readFileSync(path.join(output,file)),crc=crc32(data);
  const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(33,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(33,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);
  local.push(h,name,data);central.push(c,name);offset+=h.length+name.length+data.length;
}
const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
const archive=path.join(root,'dist',`LanVibes-${version}-public-source.zip`);
fs.writeFileSync(archive,Buffer.concat([...local,directory,end]));
console.log(`Clean source tree: ${output}\nSource ZIP: ${archive}\nFiles: ${files.length}`);
