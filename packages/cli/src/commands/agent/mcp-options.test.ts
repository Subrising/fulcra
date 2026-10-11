import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildRunToolOptions, loadMcpConfig, parsePreapprove } from "./mcp-options.js";

const dir = mkdtempSync(join(tmpdir(), "mcp-options-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, body: unknown) => {
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
};
const stdio = { command: "node", args: ["server.mjs"] };

// Fulcra 0.2.17 (FU-107): run --mcp-config and --preapprove.
describe("run MCP options", () => {
  it("reads the Claude format and the bare map, and a server with a command and no type is stdio", () => {
    const wrapped = loadMcpConfig(file("a.json", { mcpServers: { songstudio: stdio } }));
    expect(wrapped).toEqual({ songstudio: { ...stdio, type: "stdio" } });
    const bare = loadMcpConfig(
      file("b.json", { web: { type: "http", url: "https://x.test/mcp" } }),
    );
    expect(bare.web).toEqual({ type: "http", url: "https://x.test/mcp" });
  });

  it("refuses a missing file, bad JSON, no servers, or a server with no usable type", () => {
    expect(() => loadMcpConfig(join(dir, "nope.json"))).toThrowError(/Failed to read/);
    expect(() => loadMcpConfig(file("c.json", "{not json"))).toThrowError();
    expect(() => loadMcpConfig(file("d.json", { mcpServers: {} }))).toThrowError(/at least one/);
    expect(() => loadMcpConfig(file("e.json", { mcpServers: { x: { foo: 1 } } }))).toThrowError(
      /needs type/,
    );
  });

  it("splits server.tool at the first dot and refuses a malformed value", () => {
    expect(parsePreapprove("songstudio.analyze")).toEqual({
      kind: "mcp",
      server: "songstudio",
      tool: "analyze",
    });
    expect(parsePreapprove("s.tool.v2").tool).toBe("tool.v2");
    for (const bad of ["songstudio", ".tool", "server."])
      expect(() => parsePreapprove(bad)).toThrow();
  });

  it("puts mcpServers and toolPolicy.preapproved in one result, so they go in the same create request", () => {
    const mcpConfig = file("f.json", { mcpServers: { songstudio: stdio } });
    expect(
      buildRunToolOptions({ mcpConfig, preapprove: ["songstudio.a", "songstudio.b"] }),
    ).toEqual({
      mcpServers: { songstudio: { ...stdio, type: "stdio" } },
      toolPolicy: {
        preapproved: [
          { kind: "mcp", server: "songstudio", tool: "a" },
          { kind: "mcp", server: "songstudio", tool: "b" },
        ],
      },
    });
    expect(buildRunToolOptions({ mcpConfig })).toEqual({
      mcpServers: { songstudio: { ...stdio, type: "stdio" } },
    });
    expect(buildRunToolOptions({})).toEqual({});
  });

  it("refuses a preapproval without --mcp-config, or for a server that is not in the file", () => {
    expect(() => buildRunToolOptions({ preapprove: ["songstudio.a"] })).toThrowError(
      /needs --mcp-config/,
    );
    const mcpConfig = file("g.json", { mcpServers: { songstudio: stdio } });
    expect(() => buildRunToolOptions({ mcpConfig, preapprove: ["other.a"] })).toThrowError(
      /not in/,
    );
  });
});
