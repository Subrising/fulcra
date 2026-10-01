import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const runner = 'dist/cli-runner-dxvZUkQb.js';
export const upstreamHash = '02b3bc271f0775311217b72825227316d8b0526bc4669d7a28f1a9757d599413';
const hash = value => createHash('sha256').update(value).digest('hex');
export const provenanceExpression = `Object.freeze({ version: 1, kind: ["external_user", "inter_session", "internal_system"].includes(params.inputProvenance?.kind) ? params.inputProvenance.kind : "unknown", sourceChannel: params.inputProvenance?.sourceChannel ?? null, sourceTool: params.inputProvenance?.sourceTool ?? null })`;
export function patchRunner(source) {
  if (hash(source) !== upstreamHash) throw Error('Unsupported OpenClaw runner; no patch applied');
  const anchor = '\t\t\t\t\tsenderIsOwner: params.senderIsOwner ?? void 0\n\t\t\t\t}, buildAgentHookContext(hookContext));';
  if (source.split(anchor).length !== 2) throw Error('Ambiguous hook patch location');
  return source.replace(anchor, anchor.replace('\n', `,\n\t\t\t\t\torcaInputProvenance: ${provenanceExpression}\n`));
}
// Copy a released host, never mutate or hard-link its executable bytes. Dependencies
// remain the existing same-user installation; their link is explicit in the manifest.
export function packageHost(source, releases) {
  source = fs.realpathSync(source); releases = fs.realpathSync(releases);
  if (releases === source || releases.startsWith(source + path.sep)) throw Error('Release directory must be outside upstream');
  const upstream = fs.readFileSync(path.join(source, runner), 'utf8');
  const patched = patchRunner(upstream), runnerHash = hash(patched);
  const target = path.join(releases, runnerHash.slice(0, 16));
  if (fs.existsSync(target)) throw Error('Release already exists; verify its manifest instead of overwriting');
  if (JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).version !== '2026.9.2') throw Error('Unsupported OpenClaw version');
  fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true, filter: file => path.relative(source, file) !== 'node_modules' });
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(target, 'node_modules'));
  fs.writeFileSync(path.join(target, runner), patched);
  const files = {}, links = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name), relative = path.relative(target, file);
      if (entry.isSymbolicLink()) links[relative] = fs.readlinkSync(file);
      else if (entry.isDirectory()) walk(file);
      else { files[relative] = hash(fs.readFileSync(file)); if (files[relative] !== (relative === runner ? runnerHash : hash(fs.readFileSync(path.join(source, relative))))) throw Error('Copy differs from upstream: ' + relative); fs.chmodSync(file, fs.statSync(file).mode & 0o555); }
    }
    fs.chmodSync(dir, 0o555);
  };
  walk(target);
  if (hash(fs.readFileSync(path.join(source, runner))) !== upstreamHash) throw Error('Upstream changed during packaging');
  const manifest = { version: 1, target, upstream: source, upstreamHash, runner, runnerHash, files, links };
  fs.writeFileSync(target + '.manifest.json', JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const manifest = packageHost('/opt/homebrew/lib/node_modules/openclaw', process.argv[2]);
  console.log(JSON.stringify({ target: manifest.target, runnerHash: manifest.runnerHash, files: Object.keys(manifest.files).length }));
}
