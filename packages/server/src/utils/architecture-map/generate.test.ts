import { describe, expect, it } from "vitest";
import { measureChangeImpact } from "./blast-radius.js";
import { pairFromSnapshots, planParts, type Snapshot } from "./generate.js";

// A small workspace: an app that imports a client package, which imports a protocol package.
function snapshot(commit: string, files: Record<string, string>): Snapshot {
  const entries = Object.entries(files);
  return {
    commit: commit.repeat(40).slice(0, 40),
    files: entries.map(([path, text]) => ({ path, blob: `${path}:${text.length}:${text}` })),
    texts: new Map(entries),
  };
}

const base = {
  "package.json": '{"name":"shop","workspaces":["packages/*"]}',
  "README.md": "docs",
  "packages/protocol/package.json": '{"name":"@shop/protocol"}',
  "packages/protocol/src/index.ts": "export const v = 1;",
  "packages/protocol/src/messages.ts": "export type M = 1;",
  "packages/protocol/src/schema.ts": "export const s = 1;",
  "packages/client/package.json": '{"name":"@shop/client"}',
  "packages/client/src/index.ts": 'import { v } from "@shop/protocol";\nexport const c = v;',
  "packages/client/src/socket.ts": 'import { c } from "./index.js";\nexport const s = c;',
  "packages/client/src/retry.ts": "export const r = 1;",
  "packages/client/src/socket.test.ts": 'import { s } from "./socket.js";\ns;',
  "packages/app/package.json": '{"name":"@shop/app"}',
  "packages/app/src/main.ts": 'import { c } from "@shop/client";\nexport const m = c;',
  "packages/app/src/screen.ts": 'import { m } from "./main";\nexport const x = m;',
  "packages/app/src/list.ts": "export const l = 1;",
};

describe("generated architecture maps", () => {
  it("draws packages as parts and imports between them as connections", () => {
    const pair = pairFromSnapshots(snapshot("a", base), snapshot("a", base));
    const ids = pair.after.ir.components.map((c) => c.id);
    // Root-level docs and config are "Other project files", drawn last.
    expect(ids).toEqual(["packages.app", "packages.client", "packages.protocol", "other-files"]);
    const edges = pair.after.ir.connections.map((c) => `${c.from}>${c.to}`);
    // One import each: below the drawing threshold and not part of a change, so nothing is drawn.
    expect(edges).toEqual([]);
    expect(pair.after.ir.meta.subtitle).toMatch(/Automatically generated/);
    expect(pair.after.ir.meta.subtitle).toMatch(/not deployed/);
    expect(pair.after.ir.cards[0].items[0]).toBe(`commit ${"a".repeat(40)}`);
  });

  it("draws a new connection a change adds, and keeps ids and positions stable across both ends", () => {
    const head = {
      ...base,
      "packages/app/src/list.ts": 'import { r } from "@shop/client/retry";\nexport const l = r;',
    };
    const pair = pairFromSnapshots(snapshot("a", base), snapshot("b", head));
    expect(pair.changed).toEqual(["packages/app/src/list.ts"]);
    const before = pair.before.ir.connections.map((c) => c.id);
    const after = pair.after.ir.connections.map((c) => c.id);
    expect(before).toEqual([]);
    expect(after).toEqual(["packages.app--packages.client"]);
    const at = (side: typeof pair.before) => new Map(side.ir.components.map((c) => [c.id, c.pos]));
    expect(at(pair.before)).toEqual(at(pair.after));
  });

  it("measures the blast radius: parts edited, what imports the change, and tests that reach it", () => {
    const head = {
      ...base,
      "packages/client/src/index.ts":
        'import { v } from "@shop/protocol";\nexport const c = v + 1;',
    };
    const impact = measureChangeImpact(pairFromSnapshots(snapshot("a", base), snapshot("b", head)));
    expect(impact.counts).toMatchObject({ files: 1, code: 1, tests: 0 });
    expect(impact.parts.map((p) => p.id)).toEqual(["packages.client"]);
    // socket.ts imports index.ts directly; main.ts through the package; screen.ts through main.ts.
    expect(impact.dependents.files).toBe(3);
    expect(impact.dependents.direct).toBe(2);
    expect(impact.coverage).toEqual({ code: 1, covered: 1, uncovered: [] });
    expect(impact.files[0].nearestTests).toEqual(["packages/client/src/socket.test.ts"]);
  });

  it("splits the folders a change edits first", () => {
    const code = Array.from({ length: 12 }, (_, i) => [`src/a/f${i}.ts`, `src/b/g${i}.ts`]).flat();
    expect(planParts(code, [""], 3, ["src/b/g1.ts"])).toEqual(["src/a", "src/b"]);
    // With room for one more part, the edited folder is the one split out.
    expect(planParts(code, [""], 2, ["src/b/g1.ts"])).toEqual(["", "src/b"]);
  });
});
