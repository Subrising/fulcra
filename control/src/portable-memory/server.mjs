import { createMemory, LIMITS } from './core.mjs';
export const tools = [
  { name: 'shared_memory_search', description: 'Find shared decisions by literal keywords. Default current excludes the designated history archive; use history or all explicitly for earlier evidence. Returns corpus labels, source paths, hashes, excerpts and selected-scope coverage limits. Corpus labels do not establish authority or freshness.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 512 }, maxResults: { type: 'integer', minimum: 1, maximum: 8 }, scope: { type: 'string', enum: ['current', 'history', 'all'], default: 'current' } }, required: ['query'], additionalProperties: false } },
  { name: 'shared_memory_read', description: 'Read an exact current or historical canonical source with a corpus label. An optional expectedSha256 detects changes since retrieval. Labels describe location, not authority or freshness.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, from: { type: 'integer', minimum: 1 }, lines: { type: 'integer', minimum: 1, maximum: 400 }, expectedSha256: { type: 'string' } }, required: ['path'], additionalProperties: false } },
];
export function serve(memory = createMemory(), input = process.stdin, output = process.stdout) {
  const send = async value => { if (!output.write(JSON.stringify(value) + '\n')) await new Promise(resolve => output.once('drain', resolve)); };
  const error = (id, message, code = -32602) => send({ jsonrpc: '2.0', id, error: { code, message } });
  async function handle(q) {
    if (!q || typeof q !== 'object' || Array.isArray(q) || q.jsonrpc !== '2.0' || typeof q.method !== 'string') return error(null, 'Invalid request');
    if (q.id === undefined) return;
    if (!(typeof q.id === 'string' || Number.isSafeInteger(q.id) || q.id === null)) return error(null, 'Invalid id');
    const result = value => send({ jsonrpc: '2.0', id: q.id, result: value });
    if (q.method === 'initialize') return result({ protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(q.params?.protocolVersion) ? q.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'orca-canonical-memory', version: '1.1.0' } });
    if (q.method === 'tools/list') return result({ tools });
    if (q.method === 'ping') return result({});
    if (q.method === 'resources/list') return result({ resources: [] });
    if (q.method === 'resources/templates/list') return result({ resourceTemplates: [] });
    if (q.method === 'prompts/list') return result({ prompts: [] });
    if (q.method !== 'tools/call' || !tools.some(t => t.name === q.params?.name)) return error(q.id, 'Unknown method or tool', -32601);
    try {
      const value = await memory[q.params.name === 'shared_memory_search' ? 'search' : 'read'](q.params.arguments);
      return result({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });
    } catch (e) { return result({ content: [{ type: 'text', text: JSON.stringify({ error: e.code ?? 'ERROR', message: e.message }) }], isError: true }); }
  }
  // Async iteration applies backpressure: one request executes at a time, without an unbounded promise queue.
  return (async () => {
    let pending = Buffer.alloc(0), dropping = false;
    for await (const chunk of input) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < data.length) {
        const newline = data.indexOf(10, offset), end = newline < 0 ? data.length : newline;
        if (!dropping && pending.length + end - offset > LIMITS.requestBytes) {
          pending = Buffer.alloc(0); dropping = true; await error(null, 'Request byte limit exceeded');
        }
        if (!dropping) pending = Buffer.concat([pending, data.subarray(offset, end)]);
        if (newline >= 0) {
          if (!dropping && pending.length) {
            let q;
            try { q = JSON.parse(pending.toString('utf8')); } catch { await error(null, 'Invalid JSON', -32700); }
            if (q !== undefined) await handle(q);
          }
          pending = Buffer.alloc(0); dropping = false;
        }
        offset = newline < 0 ? data.length : newline + 1;
      }
    }
    if (pending.length || dropping) await error(null, 'Incomplete request');
  })();
}
