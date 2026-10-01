// FIX-8 W3 (B, owner decision 30 Sep: "for all new sessions for claude or codex on Fulcra on any system ... the default
// should be auto-mode/full-access"): the BUILT-IN Codex default is full-access, also on a host with no Fulcra config.
// Precedence is unchanged (explicit > role > Settings > config > this default). Internal helper agents stay pinned to a
// non-unattended mode of their own (R1 P-1).
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { buildProviderRegistry } from "../../provider-registry.js";
import { ClaudeAgentClient } from "../claude/agent.js";
import { CodexAppServerAgentClient } from "../codex-app-server-agent.js";
import { resetCodexLiveCatalogCache } from "./live-model-catalog.js";

function fakeCodex(dir: string): string {
  const file = path.join(dir, "fake-codex.cjs");
  writeFileSync(
    file,
    `
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 0.159.1\\n"); process.exit(0); }
if (args[0] === "debug") process.exit(2);
let buffer = "";
const result = (method) => method === "model/list" ? { data: [{ id: "gpt-6.1-sol", isDefault: true }] } : method === "config/read" ? { config: {} } : {};
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const i = buffer.indexOf("\\n"); if (i === -1) break;
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (!line) continue;
    const m = JSON.parse(line); if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result: result(m.method) }) + "\\n");
  }
});
`,
  );
  return file;
}

const unattended = (provider: string, modeId: string | undefined) =>
  AGENT_PROVIDER_DEFINITIONS.find((p) => p.id === provider)?.modes.find((m) => m.id === modeId)
    ?.isUnattended === true;

describe("codex default permission mode (daemon side)", () => {
  test("the provider definition's built-in default is full-access", () => {
    const codex = AGENT_PROVIDER_DEFINITIONS.find((p) => p.id === "codex");
    expect(codex?.defaultModeId).toBe("full-access");
  });

  test("the catalog and the create default are full-access (auto-review stays selectable)", async () => {
    resetCodexLiveCatalogCache();
    const dir = mkdtempSync(path.join(tmpdir(), "codex-default-mode-"));
    try {
      const registry = buildProviderRegistry(createTestLogger(), {
        providerOverrides: {
          "codex-mode": {
            extends: "codex",
            label: "Codex",
            command: [process.execPath, fakeCodex(dir)],
          },
        },
      });
      const client = registry["codex-mode"].createClient(createTestLogger());
      const catalog = await client.fetchCatalog!({ scope: "global", force: true });
      expect(catalog.defaultModeId).toBe("full-access");
      expect(catalog.modes?.map((m) => m.id)).toEqual(
        expect.arrayContaining(["auto-review", "full-access"]),
      );
      expect(
        await client.resolveDefaultModeId!({ config: { provider: "codex-mode", cwd: dir } }),
      ).toBe("full-access");
      expect(client.internalModeId).toBe("auto"); // passed through the registry wrapper
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("internal helper agents use a non-unattended mode on both providers", () => {
    const codex = new CodexAppServerAgentClient(createTestLogger()).internalModeId;
    const claude = new ClaudeAgentClient({ logger: createTestLogger() }).internalModeId;
    expect(codex).toBe("auto");
    expect(claude).toBe("plan");
    expect(unattended("codex", codex)).toBe(false);
    expect(unattended("claude", claude)).toBe(false);
  });
});
