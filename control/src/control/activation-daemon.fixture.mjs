// Explicit integration fixture: no provider is enabled and no worker is created.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
const stage = process.argv[2];
if (!stage?.startsWith('/Volumes/test-volume/openclaw/tmp/')) throw Error('Private fixture stage required');
const manifest = JSON.parse(fs.readFileSync(stage + '/native-turn-stage.json', 'utf8'));
const home = manifest.controllerHome + '/native';
process.env.PASEO_HOME = home;
process.env.ORCA_CONTROLLER_HOME = manifest.controllerHome;
const base = stage + '/packages/server/dist/server/server';
const { createPaseoDaemon } = await import(pathToFileURL(base + '/bootstrap.js').href);
const { hashDaemonPassword } = await import(pathToFileURL(base + '/auth.js').href);
const { BUILTIN_PROVIDER_IDS } = await import(pathToFileURL(manifest.sourceRoot + '/packages/protocol/dist/provider-manifest.js').href);
const logger = createRequire(manifest.sourceRoot + '/package.json')('pino')({ level: 'silent' });
const password = randomBytes(32).toString('base64url');
const daemon = await createPaseoDaemon({ listen: '127.0.0.1:0', paseoHome: home,
  corsAllowedOrigins: [], hostnames: true, mcpEnabled: false, mcpInjectIntoAgents: false,
  mcpDebug: false, pluginsEnabled: false, staticDir: home + '/static',
  agentStoragePath: home + '/agents', relayEnabled: false, auth: { password: hashDaemonPassword(password) },
  providerOverrides: Object.fromEntries(BUILTIN_PROVIDER_IDS.map(id => [id, { enabled: false }])),
}, logger);
let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  const timeout = setTimeout(() => process.exit(1), 5000); timeout.unref();
  await daemon.stop(); process.exit(0);
};
process.on('SIGTERM', stop); process.on('disconnect', stop);
process.on('message', message => { if (message === 'stop') void stop(); });
await daemon.start();
process.send({ ready: true, pid: process.pid, target: daemon.getListenTarget(), password, enabledProviders: 0 });
