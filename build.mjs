// Static SEO – build: packs src/ into dist/static-seo-<version>.zip (one package for every Instatic site).
// Usage: node build.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const src = path.join(root, 'src');
const FILES = ['plugin.json', 'server/index.js', 'editor/index.js', 'admin/app.js', 'pack/site.json'];
const FORBIDDEN = ["'node:", '"node:', "'bun:", '"bun:', 'require(', 'process.binding', 'globalThis.process.env'];

// Minimal ZIP writer (deflate), no dependencies
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const n = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(n.length, 26);
    locals.push(head, n, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const entries = FILES.map((f) => [f, fs.readFileSync(path.join(src, f), 'utf8')]);
entries.push(['LICENSE', fs.readFileSync(path.join(root, 'LICENSE'), 'utf8')]);
const manifest = JSON.parse(entries[0][1]);
JSON.parse(entries.find(([f]) => f === 'pack/site.json')[1]);

const server = entries.find(([f]) => f === 'server/index.js')[1];
const hits = FORBIDDEN.filter((v) => server.includes(v));
if (hits.length) throw new Error('Forbidden literals in server bundle: ' + hits.join(', '));
if (/^\s*export\s+var\s/m.test(server)) throw new Error('Use "export const" or "export function" – Instatic’s ESM shim does not rewrite "export var".');
// Strict ESM syntax check (node --check on .js can be lenient with module code)
for (const f of FILES.filter((x) => x.endsWith('.js'))) {
  const tmp = path.join(os.tmpdir(), 'static-seo-check-' + f.replace(/[\\/]/g, '-') + '.mjs');
  fs.writeFileSync(tmp, fs.readFileSync(path.join(src, f)));
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) { throw new Error(`Syntax error in ${f}:\n${e.stderr}`); }
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', `static-seo-${manifest.version}.zip`);
fs.writeFileSync(out, zip(entries));
console.log(`built ${path.relative(root, out)} (${manifest.id} ${manifest.version}, ${fs.statSync(out).size} bytes)`);
