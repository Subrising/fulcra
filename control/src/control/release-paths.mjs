import fs from 'node:fs';
import path from 'node:path';
// Where this machine's released native modules and daemon home live, for the release tooling
// (deploy-admission.mjs, deploy-readiness.mjs). They are the operator's configured values in
// config/runtime.json (`installation`, `home`), never code defaults, so both tools read one place.
export function releasePaths(config = JSON.parse(fs.readFileSync(new URL('../../config/runtime.json', import.meta.url), 'utf8'))) {
  const { installation, home } = config ?? {};
  for (const [key, value] of [['installation', installation], ['home', home]]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`config/runtime.json needs an absolute "${key}" for the release tooling`);
  }
  return {
    admissionBase: path.join(installation, 'node_modules/@getpaseo/server/dist/server/server/agent') + '/',
    daemonPid: path.join(home, 'paseo.pid'),
    daemonSecret: path.join(home, 'controller.secret'),
  };
}
