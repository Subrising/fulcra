import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlHome } from './home.mjs';
import { resolveSocketPath } from './socket-location.mjs';
export function request(envelope) {
  const socket = resolveSocketPath(controlHome());
  const data = JSON.stringify(envelope) + '\n'; if (Buffer.byteLength(data) > 32768) throw new Error('Request too large');
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket); let bytes = ''; client.setEncoding('utf8');
    client.setTimeout(30000, () => client.destroy(new Error('Controller response timed out; inspect durable delivery before retrying')));
    client.on('connect', () => client.write(data)); client.on('error', reject);
    client.on('data', chunk => { bytes += chunk; if (Buffer.byteLength(bytes) > 524288) client.destroy(new Error('Controller response too large')); });
    client.on('end', () => { try { const value = JSON.parse(bytes); if (value.error) throw new Error(value.error); resolve(value.result); } catch (e) { reject(e); } });
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const bytes = fs.readFileSync(0); if (bytes.length > 32768) throw new Error('Request too large'); console.log(JSON.stringify(await request(JSON.parse(bytes.toString('utf8'))), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
