import { describe, expect, it } from "vitest";
import type { Token } from "markdown-it";
import { createMarkdownParser } from "./markdown-parser";
import { createAssistantMarkdownParser } from "./assistant-markdown-parser";

// react-native-markdown-display was removed upstream; the native renderer is now
// react-native-enriched-markdown, which parses in native code. These parsers still feed
// rich clipboard and link handling, so exercise the real token stream they produce.
type Parser = ReturnType<typeof createMarkdownParser>;

function flatten(tokens: Token[]): Token[] {
  return tokens.flatMap((token) => [token, ...flatten(token.children ?? [])]);
}

function parse(markdown: Parser, source: string): Token[] {
  return flatten(markdown.parse(source, {}));
}

describe("maintained parser token stream", () => {
  it("preserves commands, lists, tables and fences", () => {
    const markdown = createMarkdownParser({ linkify: true });
    const source = [
      'Run `tool --name="my repo"` (p) ...',
      "3. First\n4. Second\n   - inner **bold**",
      "| Name | Value |\n| :--- | ---: |\n| hello | `a` |",
      '```ts\nconst value = "unchanged";\n\nuse(value);\n```',
    ].join("\n\n");
    const tokens = parse(markdown, source);
    expect(tokens.find((token) => token.type === "code_inline")?.content).toBe(
      'tool --name="my repo"',
    );
    expect(tokens.find((token) => token.type === "ordered_list_open")?.attrGet("start")).toBe(3);
    expect(tokens.filter((token) => token.type === "table_open")).toHaveLength(1);
    const fence = tokens.find((token) => token.type === "fence");
    expect(fence?.content).toBe('const value = "unchanged";\n\nuse(value);\n');
    expect(fence?.info).toBe("ts");
    expect(
      tokens
        .filter((token) => token.type === "text")
        .map((token) => token.content)
        .join(""),
    ).toContain(" (p) ...");
  });

  it("keeps file links exclusive to assistant output and rejects executable links", () => {
    const source = "[source](file:///tmp/source.ts#L12) [bad](javascript:alert(1))";
    const hrefs = (markdown: Parser) =>
      parse(markdown, source)
        .filter((token) => token.type === "link_open")
        .map((token) => token.attrGet("href"));
    expect(hrefs(createAssistantMarkdownParser())).toEqual(["file:///tmp/source.ts#L12"]);
    expect(hrefs(createMarkdownParser({ linkify: true }))).toEqual([]);
  });
});
