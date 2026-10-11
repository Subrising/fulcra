import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandError } from "../../output/index.js";

// Fulcra 0.2.17 (FU-100b, ledger FU-107): `fulcra run --mcp-config <file> --preapprove <server.tool>`. The MCP servers and the
// tools that run without a prompt go in the SAME create request, because the daemon accepts a preapproved MCP tool only
// when its server is in that request. Claude settings files do not allow MCP tools for SDK-supplied servers; this does.

export interface RunToolOptions {
  mcpServers?: Record<string, Record<string, unknown>>;
  toolPolicy?: { preapproved: Array<{ kind: "mcp"; server: string; tool: string }> };
}

const fail = (message: string, details?: string): never => {
  throw {
    code: "INVALID_OPTIONS",
    message,
    ...(details ? { details } : {}),
  } satisfies CommandError;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Reads `{ "mcpServers": { name: {...} } }` (the Claude format) or the bare `{ name: {...} }` map. */
export function loadMcpConfig(file: string): Record<string, Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (error) {
    return fail(
      `Failed to read --mcp-config ${file}`,
      error instanceof Error ? error.message : String(error),
    );
  }
  const map = isObject(parsed) && isObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
  if (!isObject(map) || Object.keys(map).length === 0)
    return fail("--mcp-config must hold at least one MCP server", file);
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of Object.entries(map)) {
    if (!isObject(raw)) return fail(`MCP server "${name}" must be an object`);
    // A server with a command and no type is a stdio server, as in the Claude format.
    const type = raw.type ?? (typeof raw.command === "string" ? "stdio" : undefined);
    if (type !== "stdio" && type !== "http" && type !== "sse")
      return fail(`MCP server "${name}" needs type stdio, http or sse`);
    servers[name] = { ...raw, type };
  }
  return servers;
}

/** "server.tool" -> a preapproval. The server is the text before the first dot; the tool is the rest. */
export function parsePreapprove(value: string): { kind: "mcp"; server: string; tool: string } {
  const text = value.trim();
  const dot = text.indexOf(".");
  if (dot <= 0 || dot === text.length - 1)
    return fail(`--preapprove needs <server.tool>, got "${value}"`);
  return { kind: "mcp", server: text.slice(0, dot), tool: text.slice(dot + 1) };
}

/** The create-request fields for the two options. Fails when a preapproval names a server that is not in the file. */
export function buildRunToolOptions(input: {
  mcpConfig?: string;
  preapprove?: string[];
}): RunToolOptions {
  const grants = (input.preapprove ?? []).map(parsePreapprove);
  if (!input.mcpConfig) {
    if (grants.length > 0) fail("--preapprove needs --mcp-config, which names the MCP servers");
    return {};
  }
  const mcpServers = loadMcpConfig(input.mcpConfig);
  for (const grant of grants)
    if (!(grant.server in mcpServers))
      fail(`--preapprove names server "${grant.server}", which is not in ${input.mcpConfig}`);
  return {
    mcpServers,
    ...(grants.length > 0 ? { toolPolicy: { preapproved: grants } } : {}),
  };
}
