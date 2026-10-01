import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const pins = {
  'file-observer/internal/native-recursive.js':'3850e3db00eba704c1727b69a67a328051938467b5511fae42a0fc9d1f438568',
  'file-explorer/observer.js':'4b2a7d8222b4eb0a60855b48501d2ab01c6ba9f70ba736640f0e8dcafde21169',
  'session/daemon/diagnostics.js':'d91e772730d8a54eacaabb8b6675d997511583d699b98847796124b44d8c9343',
};
function once(source,before,after) {
  if(source.split(before).length !== 2) throw Error('Upstream watcher anchor changed');
  return source.replace(before,after);
}
export function patchWatcher(relative,source,runtime) {
  if(!path.isAbsolute(runtime) || !pins[relative] || createHash('sha256').update(source).digest('hex') !== pins[relative]) throw Error('Unrecognized watcher source or runtime path');
  const module = JSON.stringify(pathToFileURL(runtime).href);
  if(relative === 'file-observer/internal/native-recursive.js') {
    source = once(source,'import { watch } from "node:fs";',`import { isolatedWatch } from ${module};`);
    source = once(source,'watch(root, { recursive: true }, listener)','isolatedWatch(root, { recursive: true }, listener)');
    source = once(source,'        this.watchRoot();','        await this.watchRoot();');
    source = once(source,'    watchRoot() {','    async watchRoot() {');
    source = once(source,'            nativeHandleCount: this.watcher ? 1 : 0,','            nativeHandleCount: this.watcher && this.watcherReady ? 1 : 0,');
    return once(source,'        this.watcher = watcher;','        this.watcher = watcher;\n        await watcher.ready;\n        this.watcherReady = true;');
  }
  if(relative === 'file-explorer/observer.js') {
    source = once(source,'import { watch } from "node:fs";',`import { isolatedWatch } from ${module};`);
    return once(source,'watch(directory, (_event, filename) => {','isolatedWatch(directory, { recursive: false }, (_event, filename) => {');
  }
  source = `import { isolatedWatchDiagnostics } from ${module};\n` + source;
  return once(source,'    sections.push(await safeSection("System", collectSystemEntries, options.logger));','    sections.push(await safeSection("Isolated file watchers", () => Object.entries(isolatedWatchDiagnostics()).map(([label,value]) => ({label,value:String(value)})), options.logger));\n    sections.push(await safeSection("System", collectSystemEntries, options.logger));');
}
