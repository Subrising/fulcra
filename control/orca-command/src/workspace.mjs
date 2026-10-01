import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateJson } from '../../src/config.mjs';
import { controlHome } from '../../src/control/home.mjs';
import { OPERATOR_INVOKE_METHODS } from '../../orca-organization/shared/operator-invoke-methods.mjs';
import { createHash } from 'node:crypto';
const bindingName = value => createHash('sha256').update(JSON.stringify(value)).digest('hex') + '.json';
const home = controlHome();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function secret(file) {
  if (fs.realpathSync(file) !== file) throw Error('Private operator path changed');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size !== 43) throw Error('Invalid operator credential');
    const value = fs.readFileSync(fd, 'utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw Error('Invalid operator credential');
    return value;
  } finally { fs.closeSync(fd); }
}
function save(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(dir);
  if (fs.realpathSync(dir) !== dir || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('Invalid private workspace directory');
  const temporary = path.join(dir, `.orca-${randomUUID()}`);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(dir, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function createWorkspace({ config, baseOrigin, request, runtimeHome = home, write = null }) {
  const selectionFile = path.join(config.bindingsDir, bindingName(baseOrigin) + '.selection');
  const currentOrigin = () => {
    let value;
    try { value = privateJson(selectionFile, 8192); } catch (error) { if (error.code === 'ENOENT') return baseOrigin; throw error; }
    if (!value || Object.keys(value).sort().join() !== 'origin,sessionId,version' || value.version !== 1 || JSON.stringify(value.origin) !== JSON.stringify(baseOrigin) || !uuid(value.sessionId)) throw Error('Invalid saved selection');
    return { ...baseOrigin, sessionId: value.sessionId };
  };
  // Cutover A2: when the conversation supplies its management-route writer, its writes (handback) go only through it.
  const operator = (method, input) => write && OPERATOR_INVOKE_METHODS.includes(method) ? write(method, input) : request({ method, input, operator: secret(path.join(runtimeHome, 'operator.secret')) });
  const bind = async (result, fresh) => {
    if (!uuid(result?.id) || result.mode !== 'delegated' || !Number.isSafeInteger(result.generation) || result.generation < 1 || !/^[A-Za-z0-9_-]{43}$/.test(result.capability)) throw Error('Invalid binding grant');
    const observed = await request({ method: 'inspect', input: result.id, capability: result.capability }); fresh();
    if (observed.id !== result.id || !uuid(observed.task) || observed.mode !== 'delegated' || observed.generation !== result.generation) throw Error('Delegation changed before binding');
    const origin = { ...baseOrigin, sessionId: result.id };
    save(path.join(runtimeHome, 'grants', `${result.id}-${result.generation}.json`), { sessionId: result.id, generation: result.generation, capability: result.capability });
    save(path.join(config.bindingsDir, bindingName(origin)), { version: 1, origin, sessionId: result.id, taskId: observed.task, generation: result.generation });
    save(selectionFile, { version: 1, origin: baseOrigin, sessionId: result.id });
    return { text: `Selected and delegated session ${result.id} · task ${observed.task} · generation ${result.generation}.\nUse /orca ask <instruction>. Human takeover in Fulcra revokes this grant. No instruction has been sent.` };
  };
  return {
    currentOrigin, bind,
    async run(command, fresh) {
      fresh();
      if (command.action === 'sessions') {
        const rows = await operator('list'); fresh();
        if (!Array.isArray(rows) || rows.some(row => !uuid(row.id) || !uuid(row.task) || !Number.isSafeInteger(row.generation))) throw Error('Invalid session catalogue');
        const page = command.page, selected = currentOrigin().sessionId;
        const lines = rows.slice((page - 1) * 8, page * 8).map(row => `${row.id}${row.id === selected ? ' [selected]' : ''}\nTask ${row.task} · ${row.mode} · generation ${row.generation}`);
        return { text: `Saved sessions — page ${page}/${Math.max(1, Math.ceil(rows.length / 8))}. Journal ownership; native activity may differ.\n${lines.join('\n\n') || 'No sessions on this page.'}\nUse /orca delegate <session UUID> <generation> to explicitly grant this Discord entry point control. Listing grants no authority.` };
      }
      const result = await operator('handback', { sessionId: command.sessionId, expectedGeneration: command.generation, reason: 'Owner explicitly delegated through native Discord command' });
      // A lost response must never be retried automatically: observe the new generation first.
      fresh();
      if (result?.id !== command.sessionId || result.mode !== 'delegated' || !Number.isSafeInteger(result.generation) || result.generation !== command.generation + 1 || !/^[A-Za-z0-9_-]{43}$/.test(result.capability)) throw Error('Invalid delegation response');
      return bind(result, fresh);
    },
  };
}
