import { describe, expect, it } from "vitest";
import { compactToolResult } from "./compact-result.js";

describe("compact tool results", () => {
  it("shows session counts, key fields, errors, and omitted rows", () => {
    const agents = Array.from({ length: 12 }, (_, i) => ({
      id: `fixture-${i}`,
      status: i === 11 ? "error" : "idle",
      lastError: i === 11 ? "Fixture failure" : null,
      capabilities: { detail: "large" },
    }));
    const response = compactToolResult({ content: [], structuredContent: { agents } });
    expect(response.structuredContent).toEqual({
      errors: [{ path: "result.agents.11.lastError", value: "Fixture failure" }],
      summary: {
        agents: {
          count: 12,
          shown: agents.slice(0, 5).map(({ id, status }) => ({ id, status })),
          omitted: 7,
        },
      },
      omitted: 12,
      fullResult: "Set fullResult: true for the full result.",
      notice:
        "12 more omitted; full result with fullResult: true. Counts include rows, fields, and characters.",
    });
    expect(JSON.parse(String(response.content[0]?.text))).toEqual(response.structuredContent);
  });
  it("bounds inspect and log text and preserves nested errors", () => {
    const response = compactToolResult({
      content: [],
      structuredContent: {
        snapshot: {
          id: "fixture",
          status: "error",
          lastError: "x".repeat(1200),
          content: "y".repeat(500),
        },
      },
    });
    expect(response.structuredContent).toMatchObject({
      errors: [{ value: "x".repeat(1200) }],
      omitted: 200,
      summary: { snapshot: { content: `${"y".repeat(300)} [200 characters omitted]` } },
    });
  });
  it("keeps fleet partial failures from omitted nodes", () => {
    const response = compactToolResult({
      content: [],
      structuredContent: {
        partial: true,
        nodes: Array.from({ length: 9 }, (_, i) => ({
          id: `node-${i}`,
          state: "idle",
          error: i === 8 ? { code: "UNAVAILABLE", message: "Fixture host is unavailable" } : null,
        })),
      },
    });
    expect(response.structuredContent).toMatchObject({
      errors: [
        {
          path: "result.nodes.8.error",
          value: { code: "UNAVAILABLE", message: "Fixture host is unavailable" },
        },
      ],
      summary: { partial: true, nodes: { count: 9, omitted: 4 } },
    });
  });
  it("returns full evidence only when requested", () => {
    const response = {
      content: [],
      structuredContent: { agents: Array.from({ length: 20 }, (_, id) => ({ id })) },
    };
    expect(compactToolResult(response, true)).toBe(response);
  });
  it("shows zero omissions for an empty list and retains failure status", () => {
    expect(
      compactToolResult({
        content: [],
        isError: true,
        structuredContent: { agents: [], error: "Fixture" },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: {
        errors: [{ path: "result.error", value: "Fixture" }],
        omitted: 0,
        summary: { agents: { count: 0, shown: [], omitted: 0 } },
      },
    });
  });
  it("preserves text-only errors", () => {
    const response = { content: [{ type: "text", text: "Fixture failure" }], isError: true };
    expect(compactToolResult(response)).toBe(response);
  });
});
