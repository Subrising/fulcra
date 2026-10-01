import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { inScope } from './portable-scope.mjs';
import { scanFiles } from './no-machine-ties.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const entries = ['orca-organization/index.host.js','src/control/server.mjs','src/control/inbox.mjs','src/control/delegated.mjs','src/portable-memory/entry.mjs','src/config.mjs','tools/init-config.mjs'];
// Preserve entry-relative asset paths; dependencies are bundled, only Node builtins stay external.
for (const entry of entries) {
  const outfile = path.join(root, 'dist', entry);
  const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile, bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: false, legalComments: 'none', metafile: true,
    plugins: [{ name: 'source-relative-assets', setup(b) { b.onLoad({ filter: /\.mjs$/ }, args => {
      if (args.path.includes('/node_modules/')) return;
      const relative = path.relative(path.dirname(path.join(root, entry)), args.path).split(path.sep).join('/');
      const base = JSON.stringify(relative.startsWith('.') ? relative : './' + relative);
      return { contents: fs.readFileSync(args.path, 'utf8').replaceAll('import.meta.url', `new URL(${base}, import.meta.url).href`), loader: 'js' };
    }); } }],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  const forbidden = Object.keys(result.metafile.inputs).filter(p => !p.startsWith('node_modules/') && !inScope(p));
  if (forbidden.length) throw Error(`Portable bundle imports excluded input: ${forbidden.join(', ')}`);
  const hits = scanFiles(root, [path.relative(root, outfile)]);
  if (hits.length) throw Error(hits.join('\n'));
}
console.log('Portable controller dependencies bundled and scanned');
