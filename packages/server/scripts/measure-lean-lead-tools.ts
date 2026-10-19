/** Run matched requests against a scratch daemon. A local relay records provider usage. */
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import pino from "pino";
import { createPaseoDaemon } from "../src/server/bootstrap.js";
import { loadConfig } from "../src/server/config.js";
import { createMemoryCredentialBackend } from "../src/server/integrations/credential-backend.js";
import { ClaudeAgentClient } from "../src/server/agent/providers/claude/agent.js";
import { BuiltinPluginLoader } from "../src/server/plugins/builtin/index.js";

const [preset, taskPath, outputPath] = process.argv.slice(2);
if (
  !["on", "lead"].includes(preset) ||
  !taskPath ||
  !outputPath ||
  !process.env.LEAN_MEASURE_RELAY ||
  !process.env.LEAN_MEASURE_PROVIDER_HOME
)
  throw new Error(
    "Use on|lead task.json output.json with LEAN_MEASURE_RELAY and LEAN_MEASURE_PROVIDER_HOME",
  );
const task = JSON.parse(await readFile(taskPath, "utf8")) as {
  scratch: string;
  model: string;
  prompts: string[];
};
const home = await mkdtemp(path.join(os.tmpdir(), "lean-lead-measure-"));
const logger = pino({ level: "silent" });
if (os.homedir() === process.env.LEAN_MEASURE_PROVIDER_HOME)
  throw new Error("Run with a scratch HOME and a separate provider home");
const credential = process.env.LEAN_MEASURE_CREDENTIAL;
const provider = new ClaudeAgentClient({
  logger,
  runtimeSettings: {
    env: {
      HOME: process.env.LEAN_MEASURE_PROVIDER_HOME,
      ...(credential
        ? {
            ANTHROPIC_API_KEY: credential.startsWith("sk-ant-api") ? credential : "",
            CLAUDE_CODE_OAUTH_TOKEN: credential.startsWith("sk-ant-api") ? "" : credential,
            ANTHROPIC_AUTH_TOKEN: "",
          }
        : {}),
      ANTHROPIC_BASE_URL: process.env.LEAN_MEASURE_RELAY,
      // A non-Anthropic base URL turns off deferred tool loading in the Claude CLI.
      // Keep it on so the capture matches live sessions, which defer MCP tools.
      ENABLE_TOOL_SEARCH: "true",
    },
  },
});
const daemon = await createPaseoDaemon(
  {
    ...loadConfig(home, { env: {} }),
    listen: "127.0.0.1:0",
    staticDir: home,
    relayEnabled: false,
    mcpEnabled: true,
    mcpInjectIntoAgents: true,
    mcpInjectLabels: { "fulcra.mcp": "on" },
    browserToolsEnabled: true,
    agentClients: { claude: provider },
  },
  logger,
  {
    credentialBackend: createMemoryCredentialBackend(),
    builtinPlugins: new BuiltinPluginLoader(undefined, []),
  },
);
const results: unknown[] = [];
try {
  await daemon.start();
  const agent = await daemon.agentManager.createAgent(
    { provider: "claude", model: task.model, modeId: "bypassPermissions", cwd: task.scratch },
    undefined,
    { labels: { "fulcra.mcp": preset } },
  );
  for (const [turn, prompt] of (process.env.LEAN_MEASURE_FIRST_ONLY
    ? task.prompts.slice(0, 1)
    : task.prompts
  ).entries()) {
    const result = await daemon.agentManager.runAgent(agent.id, prompt);
    if (!result.usage?.inputTokens)
      throw new Error(`Measurement failed before model input: ${result.finalText}`);
    results.push({ turn, usage: result.usage, finalText: result.finalText });
    await writeFile(outputPath, JSON.stringify({ preset, results }, null, 2));
    process.stdout.write(`${preset}: completed turn ${turn}\n`);
  }
  await daemon.agentManager.archiveAgent(agent.id);
} finally {
  await daemon.stop();
  await rm(home, { recursive: true, force: true });
}
