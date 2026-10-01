import {watch} from 'node:fs';
const MAX_FRAME = 16384, MAX_EVENTS = 128;
let watcher, configured = false, blocked = false, closed = false, rootDirty = false, input = '';
const pending = new Map();
function frame(value) { const text = JSON.stringify(value) + '\n'; if (Buffer.byteLength(text) > MAX_FRAME) return frame({type:'error', code:'WATCH_FRAME'}); blocked = !process.stdout.write(text); }
function flush() {
  if (closed || blocked) return;
  if (rootDirty) { rootDirty = false; pending.clear(); frame({type:'event', eventType:'rename', filename:null}); }
  for (const [name, eventType] of pending) { if (blocked) break; pending.delete(name); frame({type:'event', eventType, filename:name}); }
}
function stop() { if (closed) return; closed = true; watcher?.close(); pending.clear(); process.exit(); }
function fail(code) { if (closed) return; watcher?.close(); closed = true; const timer = setTimeout(() => process.exit(1), 500); timer.unref(); process.stdout.write(JSON.stringify({type:'error', code}) + '\n', () => process.exit(1)); }
process.stdout.on('drain', () => { blocked = false; flush(); });
process.stdout.on('error', stop); process.stdin.on('end', stop); process.stdin.on('error', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => {
  if (configured || Buffer.byteLength(input) + Buffer.byteLength(text) > MAX_FRAME) return fail('WATCH_INPUT');
  input += text; const at = input.indexOf('\n'); if (at < 0) return;
  try {
    if (at !== input.length - 1) throw Error('Extra frame');
    const config = JSON.parse(input); input = '';
    if (Object.keys(config).sort().join() !== 'recursive,root' || typeof config.root !== 'string' || !config.root.startsWith('/') || config.root.includes('\0') || typeof config.recursive !== 'boolean') throw Error('Invalid config');
    configured = true;
    watcher = watch(config.root, {recursive: config.recursive}, (eventType, filename) => {
      if (closed) return;
      if (filename === null || pending.size >= MAX_EVENTS) { rootDirty = true; pending.clear(); }
      else if (!rootDirty) pending.set(filename.toString(), eventType);
      flush();
    });
    watcher.on('error', () => fail('WATCH_NATIVE'));
    frame({type:'ready'}); flush();
  } catch { fail('WATCH_START'); }
});
