import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The map renderer draws untrusted text. Its safety rests on never handing IR data to an HTML
// or URL sink, so this scan fails the build if the renderer's source grows one. Comments are
// stripped first so prose may name the APIs it forbids.
const sources = [
  ...readdirSync(__dirname)
    .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name))
    .map((name) => join(__dirname, name)),
  join(__dirname, "..", "panels", "architecture-map-panel.tsx"),
];

const BANNED: readonly [string, RegExp][] = [
  ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
  ["innerHTML/outerHTML", /\b(inner|outer)HTML\b/],
  ["insertAdjacentHTML", /insertAdjacentHTML/],
  ["document.write", /document\.write/],
  ["eval / Function", /\beval\s*\(|new\s+Function\s*\(/],
  ["foreignObject", /ForeignObject|foreignObject/],
  ["href / xlinkHref", /\bhref\b|xlinkHref/i],
  ["SvgXml / SvgUri / SvgCss", /\bSvg(Xml|Uri|Css|CssUri|FromXml)\b/],
  ["WebView / iframe", /\bWebView\b|<iframe/],
  ["Linking.openURL", /openURL/],
  ["useUnistyles", /\buseUnistyles\b/],
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("architecture map source safety", () => {
  it("scans the renderer, model and panel sources", () => {
    expect(sources.map((path) => path.split("/").pop()).sort()).toEqual(
      [
        "architecture-change-view.tsx",
        "architecture-change.ts",
        "architecture-map-panel.tsx",
        "architecture-map-view.tsx",
        "blast-radius-section.tsx",
        "change-summary.ts",
        "dependency-graph-model.ts",
        "dependency-graph-view.tsx",
        "change-view-request.ts",
        "discovery.ts",
        "generated-change.ts",
        "ir-model.ts",
        "ir-schema.ts",
        "layout.ts",
        "map-diff.ts",
        "pull-request-review-view.tsx",
        "review-file-order.ts",
        "review-flags.ts",
        "review-inbox.ts",
        "reverse-patch.ts",
        "use-architecture-change.ts",
        "use-architecture-maps.ts",
        "use-canvas-gestures.ts",
        "use-canvas-gestures.web.ts",
        "use-generated-change.ts",
      ].sort(),
    );
  });

  it.each(BANNED)("contains no %s", (_name, pattern) => {
    const offenders = sources.filter((path) =>
      pattern.test(stripComments(readFileSync(path, "utf8"))),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps invisible control and bidi characters out of its own source (write them as \\u escapes)", () => {
    const files = [
      ...sources,
      ...readdirSync(__dirname)
        .filter((name) => /\.test\.(ts|tsx)$/.test(name))
        .map((name) => join(__dirname, name)),
    ];
    const invisible =
      // eslint-disable-next-line no-control-regex -- matching control characters is the point
      /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;
    expect(files.filter((path) => invisible.test(readFileSync(path, "utf8")))).toEqual([]);
  });

  it.each(["architecture-map-view.tsx", "architecture-change-view.tsx"])(
    "%s renders SVG text only through the Text primitive",
    (file) => {
      const view = stripComments(readFileSync(join(__dirname, file), "utf8"));
      expect(view).toMatch(
        /import Svg, \{ G, Line, Polygon, Rect, Text as SvgText \} from "react-native-svg";/,
      );
      expect(view).not.toMatch(/TSpan|TextPath|Image\b|Use\b/);
    },
  );

  // withUnistyles puts an HTML wrapper around what it wraps on web; inside <svg> the browser never
  // paints it, so the whole picture came out blank. Only the canvas component may be wrapped.
  it.each([
    "architecture-map-view.tsx",
    "architecture-change-view.tsx",
    "dependency-graph-view.tsx",
  ])("%s never wraps an SVG element with withUnistyles", (file) => {
    const view = stripComments(readFileSync(join(__dirname, file), "utf8"));
    expect(view).not.toMatch(/withUnistyles\((G|Line|Polygon|Rect|SvgText|Svg)\)/);
  });
});
