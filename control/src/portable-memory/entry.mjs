import { portable } from '../portable-config.mjs';
import { createMemory } from './core.mjs';
import { serve } from './server.mjs';
if (!portable || !['claude', 'codex', 'local'].includes(process.env.ORCA_MEMORY_CLIENT)) throw Error('Explicit portable memory client required');
await serve(createMemory(portable.memoryRoot));
