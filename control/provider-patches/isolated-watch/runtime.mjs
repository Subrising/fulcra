import {watch} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWatchService} from './service.mjs';
let service;
export function isolatedWatch(root, options, listener) {
  if (process.platform !== 'darwin') return watch(root, options, listener);
  if (!service) {
    const raw = process.env.PASEO_HOME ?? '~/.paseo';
    const home = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(),raw.slice(2)) : path.resolve(raw);
    service = createWatchService({directory:path.join(home,'orca-watch-registry')});
    process.once('exit',() => service.close());
  }
  return service.watch(root,options,listener);
}
export function isolatedWatchDiagnostics() {
  return service ? service.diagnostics() : {activeRoots:0,trackedChildren:0,subscriptions:0,limit:16,started:false};
}
