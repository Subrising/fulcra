import { describe, expect, it } from "vitest";
import { createMarkdownParser } from "./markdown-parser";

// Text that must remain copyable, including sequences rewritten by typographer.
// `--flag` alone is deliberately absent: the en-dash rules need
// whitespace or a word character on both sides, so a CLI flag after a space is
// never touched and asserting on it would prove nothing.
const VERBATIM_TEXT = [
  "(c)",
  "(C)",
  "(r)",
  "(R)",
  "(tm)",
  "(TM)",
  "(p)",
  "(P)",
  "+-",
  "two dots .. here",
  "wait for it...",
  "what????",
  "stop!!!!",
  "hmm,, ok",
  "a -- b",
  "word--word",
  "a --- b",
  'run --name="my repo"',
  "it's fine",
];

describe("createMarkdownParser", () => {
  it("renders every typographer-rewritten sequence verbatim", () => {
    const parser = createMarkdownParser({ linkify: true });

    for (const source of VERBATIM_TEXT) {
      expect(parser.renderInline(source)).toBe(escapeHtml(source));
    }
  });

  it("would fail if typographer were switched back on", () => {
    // Guards the assertion above: proves the fixture actually exercises the
    // rules, so a future refactor can't quietly make the test vacuous.
    const typographer = createMarkdownParser({ linkify: true });
    typographer.set({ typographer: true });

    for (const source of VERBATIM_TEXT.filter((text) => !["(p)", "(P)"].includes(text))) {
      expect(typographer.renderInline(source)).not.toBe(escapeHtml(source));
    }
  });

  it("rejects file:// links", () => {
    const parser = createMarkdownParser({ linkify: true });

    expect(parser.render("[open](file:///tmp/a.ts)")).not.toContain("href");
  });

  it("rejects javascript: links", () => {
    const parser = createMarkdownParser({ linkify: true });

    expect(parser.render("[x](javascript:alert(1))")).not.toContain("href");
  });

  it("linkifies bare URLs only when asked", () => {
    expect(createMarkdownParser({ linkify: true }).render("see https://paseo.sh now")).toContain(
      'href="https://paseo.sh"',
    );
    expect(
      createMarkdownParser({ linkify: false }).render("see https://paseo.sh now"),
    ).not.toContain("href");
  });

  it("preserves bare domains, email links and complete user-info URL targets", () => {
    const parser = createMarkdownParser({ linkify: true });
    expect(parser.renderInline("example.com hello@example.com https://u:p@example.com/repo")).toBe(
      '<a href="http://example.com">example.com</a> <a href="mailto:hello@example.com">hello@example.com</a> <a href="https://u:p@example.com/repo">https://u:p@example.com/repo</a>',
    );
    expect(
      createMarkdownParser({ linkify: false }).renderInline("example.com hello@example.com"),
    ).toBe("example.com hello@example.com");
  });

  it("ends automatic links before Unicode punctuation", () => {
    expect(
      createMarkdownParser({ linkify: true }).renderInline("https://example.com/a，下一条"),
    ).toBe('<a href="https://example.com/a">https://example.com/a</a>，下一条');
  });
});

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}
