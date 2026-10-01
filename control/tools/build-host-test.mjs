// Build the actual product host/manager/provider into an isolated test fixture.
// Run under the project's heavy-work lock. Paths are supplied by the test runner,
// never written to a dependency manifest or used by the portable release build.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
const [productArg, outputArg] = process.argv.slice(2);
if (!productArg || !outputArg) throw Error('Usage: build-host-test.mjs PRODUCT_SOURCE OUTPUT');
const product = path.resolve(productArg), outfile = path.resolve(outputArg);
const require = createRequire(path.join(product, 'package.json'));
const { build } = require('esbuild');
const exports = [
  ['TrustedPlugins', 'plugins/trusted.ts'],
  ['Session', 'session.ts'],
  ['MessageReceipts', 'message-receipts/index.ts'],
  ['ControllerChannel', 'plugins/controller-channel.ts'],
  ['toAgentPayload', 'agent/agent-projections.ts'],
  ['AgentManager', 'agent/agent-manager.ts'],
  ['AgentStorage', 'agent/agent-storage.ts'],
  ['sendPromptToAgent', 'agent/agent-prompt.ts'],
  ['createTestAgentClient', 'test-utils/fake-agent-client.ts'],
  ['createTestLogger', '../test-utils/test-logger.ts'],
  ['CODEX_TURN_ADMISSION', 'agent/agent-sdk-types.ts'],
  ['CodexAppServerAgentSession', 'agent/providers/codex-app-server-agent.ts'],
  ['createFakeCodexAppServer', 'agent/providers/codex/test-utils/fake-app-server.ts'],
];
await build({ stdin: { contents: exports.map(([name, file]) => `export { ${name} } from ${JSON.stringify(path.join(product, 'packages/server/src/server', file))};`).join('\n'), loader: 'ts', resolveDir: product },
  outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external',
  banner: { js: `import { createRequire as __fixtureRequire } from 'node:module'; const require = __fixtureRequire(${JSON.stringify(path.join(product, 'package.json'))});` } });

// Internal product modules also use createRequire(import.meta.url). Keep their
// dependency lookup within this test fixture; cleanup removes this symlink.
const modules = path.join(path.dirname(outfile), 'node_modules');
if (!fs.existsSync(modules)) fs.symlinkSync(path.relative(path.dirname(outfile), path.join(product, 'node_modules')), modules, 'dir');
else if (fs.realpathSync(modules) !== fs.realpathSync(path.join(product, 'node_modules'))) throw Error('Test fixture dependency directory belongs to another build');
