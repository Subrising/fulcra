import { controlHome } from './home.mjs';
import { portable } from '../portable-config.mjs';
import fs from 'node:fs';
import { request } from './client.mjs';
import { uuid } from './authority.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
function grant() {
  const file = process.env.ORCA_DELEGATION_FILE ?? '';
  if (!(file.startsWith(controlHome() + '/grants/') && /^[a-f0-9-]{36}-[0-9]+\.json$/.test(file.slice((controlHome() + '/grants/').length))) || fs.realpathSync(file) !== file) throw new Error('Invalid delegation file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > 1024) throw new Error('Invalid delegation file'); const row = JSON.parse(fs.readFileSync(fd, 'utf8')); if (!uuid(row.sessionId) || !/^[A-Za-z0-9_-]{43}$/.test(row.capability)) throw new Error('Invalid delegation'); return row; }
  finally { fs.closeSync(fd); }
}
const server = new McpServer({ name: 'orca-delegated-session', version: '1.0.0' });
async function run(method, input) {
  try { const current = grant(); const result = await request({ method, input: method === 'inspect' ? current.sessionId : { ...input, sessionId: current.sessionId }, capability: current.capability }); return { content: [{ type: 'text', text: JSON.stringify(result) }] }; }
  catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }], isError: true }; }
}
server.registerTool('session_status', { description: 'Inspect the single explicitly delegated session and its actual native state. Idle does not establish accepted work.', inputSchema: z.object({}).strict() }, () => run('inspect'));
server.registerTool('session_assign', { description: 'Send a task or correction to the single delegated session. Use a fresh UUID for a distinct instruction and reuse the same ID only to inspect an existing delivery. Never claim acceptance from send acknowledgment.', inputSchema: z.object({ messageId: z.string().refine(uuid, 'Use a lowercase UUID'), text: z.string().min(1).max(16384).refine(text => text.trim().length > 0 && Buffer.byteLength(text) <= 16384, 'Use nonempty text within 16384 UTF-8 bytes') }).strict() }, a => run('send', a));
await server.connect(new StdioServerTransport());
