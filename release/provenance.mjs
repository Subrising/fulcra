import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function provenance(root = fileURLToPath(new URL('../', import.meta.url))) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding:'utf8'}).trim();
  const repoCommit = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain')) throw Error('Release requires a clean checkout');
  if (process.env.EXPECTED_REPO_COMMIT && repoCommit !== process.env.EXPECTED_REPO_COMMIT) throw Error('Unexpected repo commit');
  for (const sha of (process.env.REQUIRED_ANCESTORS ?? '').split(/\s+/).filter(Boolean)) git('merge-base','--is-ancestor',sha,'HEAD');
  return {repoCommit, productCommit:repoCommit, controlCommit:repoCommit,
    heads:{product:repoCommit, control:repoCommit}, mode:'devauth', startedAt:new Date().toISOString()};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('Usage: node release/provenance.mjs [--check]; all component fields use one repository SHA');
  else console.log(JSON.stringify(provenance(), null, 2));
}
