import { localJson } from '../src/local-machine.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { inScope, fixture } from './portable-scope.mjs';
import { auditPackagedBundle } from './packaged-audit.mjs';
export { auditPackagedBundle } from './packaged-audit.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
// Encoded fragments avoid making the detector itself a machine tie.
const patterns = [String.raw`\x2fVolumes\x2f`, String.raw`\x2fUsers\x2f`, String.raw`\x2fopt\x2fhomebrew`, String.raw`\.ts\.net`, String.raw`100\.90\.`,
  String.raw`\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b`, String.raw`\bsrv_[a-z0-9]+\b`,
  ...localJson('personal-patterns.json', [])];
export const forbidden = new RegExp(patterns.join('|'), 'i');
export function scanFiles(base, files, { allowFixtures = false, detailed = false, matcher = forbidden } = {}) {
  const hits = [];
  for (const file of files) {
    if (allowFixtures && fixture(file)) continue;
    const fd = fs.openSync(path.join(base, file), 'r');
    const decoder = new StringDecoder('utf8'), buffer = Buffer.alloc(65536), seen = new Set();
    let carry = '', context = '', line = 1, processed = 0;
    const consume = (text, final) => {
      // Retain enough look-ahead for every literal pattern and its word boundary.
      const end = final ? text.length : Math.max(0, text.length - 256);
      const patternMatcher = new RegExp(matcher.source, 'gi');
      for (const found of (context + text).matchAll(patternMatcher)) {
        const offset = found.index - context.length;
        if (offset < 0) continue;
        if (offset >= end) break;
        const at = line + (text.slice(0, offset).match(/\n/g)?.length ?? 0);
        const key = detailed ? processed + offset : at;
        if (!seen.has(key)) { seen.add(key); hits.push(detailed ? { line: at, offset: processed + offset, pattern: found[0], context: (context + text).slice(Math.max(0, found.index - 100), found.index + 140) } : `${file}:${at}: ${found[0]}`); }
      }
      line += text.slice(0, end).match(/\n/g)?.length ?? 0;
      if (end) context = text[end - 1];
      carry = text.slice(end);
      processed += end;
    };
    try {
      for (;;) {
        const count = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!count) break;
        consume(carry + decoder.write(buffer.subarray(0, count)), false);
      }
      consume(carry + decoder.end(), true);
    } finally { fs.closeSync(fd); }
  }
  return hits;
}
export function trackedScope() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(n => n && inScope(n) && fs.existsSync(path.join(root, n)));
}
export function packagedFiles(base) {
  const root = fs.realpathSync(base), visited = new Set(), files = [];
  function visit(candidate) {
    const resolved = fs.realpathSync(candidate);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw Error('Packaged symlink escaped bundle');
    // Every alias is resolved and checked, even when its target was already scanned.
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) for (const name of fs.readdirSync(resolved)) visit(path.join(resolved, name));
    else if (stat.isFile()) files.push(path.relative(root, resolved));
    else throw Error('Unsupported packaged file type');
  }
  visit(root);
  if (!files.length) throw Error('No packaged files scanned');
  return { root, files };
}
export function scanPackagedBundle(base) {
  const { root, files } = packagedFiles(base);
  return { files, hits: scanFiles(root, files) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] ? path.resolve(process.argv[2]) : root;
  if (process.argv[2]) {
    // Reviewed manifest is explicit: no defaults silently approve new output.
    const exemptions = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : [];
    const result = auditPackagedBundle(base, exemptions);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } else {
    const files = trackedScope();
    if (!files.length) throw Error('No portable files scanned');
    const hits = scanFiles(base, files);
    if (hits.length) { console.error(hits.join('\n')); process.exitCode = 1; }
    else console.log(`No machine ties: PASS (${files.length} files)`);
  }
}
