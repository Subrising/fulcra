import { portable } from '../portable-config.mjs';
import fs from 'node:fs';
import { request } from './client.mjs';
const home = (portable.controller);
const bytes = fs.readFileSync(0); if (bytes.length > 32768) throw new Error('Operator input too large');
const operator = fs.readFileSync(`${home}/operator.secret`, 'utf8');
const method = process.argv[2], input = bytes.length ? JSON.parse(bytes) : undefined;
const result = await request({ method, input, operator });
if (result?.capability) {
  const grantFile = `${home}/grants/${result.id}-${result.generation}.json`;
  try {
    fs.mkdirSync(`${home}/grants`, { recursive: true, mode: 0o700 });
    fs.writeFileSync(grantFile, JSON.stringify({ sessionId: result.id, generation: result.generation, capability: result.capability }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    try { await request({ method: 'takeover', input: { sessionId: result.id, reason: 'Grant persistence failed; revoke unreachable delegation' }, operator }); }
    catch { console.error(`Take over session ${result.id} generation ${result.generation}; grant persistence and automatic revocation failed`); }
    throw new Error(`Grant could not be saved for ${result.id}; inspect control mode before a new handback`, { cause: error });
  }
  delete result.capability; result.grantFile = grantFile;
}
console.log(JSON.stringify(result, null, 2));
