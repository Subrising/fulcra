import { describe, expect, it } from "vitest";
import { MarkdownIt, parser, type ASTNode } from "react-native-markdown-display";
import { createMarkdownParser } from "./markdown-parser";
import { createAssistantMarkdownParser } from "./assistant-markdown-parser";

// The upstream declaration incorrectly describes this callback's array as one node.
// Exercise the real token cleanup and AST conversion; no renderer or parser mocks.
const nativeParse = parser as unknown as (
  source: string,
  render: (nodes: ASTNode[]) => ASTNode[],
  markdown: ReturnType<typeof createMarkdownParser>,
) => ASTNode[];

function flatten(nodes: ASTNode[]): ASTNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

describe("maintained parser with the native Markdown renderer", () => {
  it("uses the renderer's constructor and preserves commands, lists, tables and fences", () => {
    const markdown = createMarkdownParser({ linkify: true });
    expect(markdown).toBeInstanceOf(MarkdownIt);
    const source = [
      'Run `tool --name="my repo"` (p) ...',
      "3. First\n4. Second\n   - inner **bold**",
      "| Name | Value |\n| :--- | ---: |\n| hello | `a` |",
      '```ts\nconst value = "unchanged";\n\nuse(value);\n```',
    ].join("\n\n");
    const nodes = flatten(nativeParse(source, (result) => result, markdown));
    expect(nodes.find((node) => node.type === "code_inline")?.content).toBe(
      'tool --name="my repo"',
    );
    expect(nodes.find((node) => node.type === "ordered_list")?.attributes.start).toBe(3);
    expect(nodes.filter((node) => node.type === "table")).toHaveLength(1);
    expect(nodes.find((node) => node.type === "fence")?.content).toBe(
      'const value = "unchanged";\n\nuse(value);\n',
    );
    expect(nodes.find((node) => node.type === "fence")?.sourceInfo).toBe("ts");
    expect(
      nodes
        .filter((node) => node.type === "text")
        .map((node) => node.content)
        .join(""),
    ).toContain(" (p) ...");
  });

  it("keeps file links exclusive to assistant output and rejects executable links", () => {
    const source = "[source](file:///tmp/source.ts#L12) [bad](javascript:alert(1))";
    const assistant = flatten(
      nativeParse(source, (result) => result, createAssistantMarkdownParser()),
    );
    expect(
      assistant.filter((node) => node.type === "link").map((node) => node.attributes.href),
    ).toEqual(["file:///tmp/source.ts#L12"]);
    const ordinary = flatten(
      nativeParse(source, (result) => result, createMarkdownParser({ linkify: true })),
    );
    expect(ordinary.filter((node) => node.type === "link")).toEqual([]);
  });
});
