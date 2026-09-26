import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseArchitectureIr,
  styleForConnectionVariant,
  toDisplayText,
  toneForCardDot,
  toneForComponentType,
  type ArchitectureIrParseResult,
} from "./ir-model";
import { ARCHITECTURE_IR_LIMITS } from "./ir-schema";

const fixtureDir = join(__dirname, "fixtures");
const encoder = new TextEncoder();

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as Record<string, unknown>;
}

function parseJson(value: unknown): ArchitectureIrParseResult {
  return parseArchitectureIr(encoder.encode(JSON.stringify(value)));
}

// Parsed fixture JSON is mutated freely to build malformed documents.
type ParsedJson = ReturnType<typeof JSON.parse>;

function head(): ParsedJson {
  return fixture("head.ir.json");
}

function expectInvalid(result: ArchitectureIrParseResult, reason: RegExp): void {
  expect(result.kind).toBe("invalid");
  if (result.kind !== "invalid") return;
  expect(result.reasons.some((entry) => reason.test(entry))).toBe(true);
}

function okModel(result: ArchitectureIrParseResult) {
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error(JSON.stringify(result));
  return result.model;
}

describe("parseArchitectureIr accepts the reviewed example IRs", () => {
  it("reads the head IR: 4 components, 3 connections, 2 cards", () => {
    const model = okModel(parseArchitectureIr(readFileSync(join(fixtureDir, "head.ir.json"))));
    expect(model.title).toBe("Radius definition: defproof-app");
    expect(model.subtitle).toMatch(/Manually mapped/);
    expect(model.nodes.map((node) => node.id)).toEqual(["environment", "app", "demo", "image"]);
    expect(model.edges).toHaveLength(3);
    expect(model.cards).toHaveLength(2);
    expect(model.cards[0]?.items.map((item) => item.text)).toContain(
      "image digest sha256:0ae87935398b92627ab73bbe2bdf43d777419076804ba1a6e346f5cb06de43ca",
    );
    expect(model.hiddenCharactersRemoved).toBe(false);
  });

  it("reads the baseline IR: 3 components, 2 connections", () => {
    const model = okModel(parseArchitectureIr(readFileSync(join(fixtureDir, "baseline.ir.json"))));
    expect(model.nodes).toHaveLength(3);
    expect(model.edges).toHaveLength(2);
  });

  it("keeps authored geometry and presentation hints", () => {
    const model = okModel(parseJson(head()));
    const image = model.nodes.find((node) => node.id === "image");
    expect(image).toMatchObject({ x: 600, y: 210, width: 260, height: 62, tone: "external" });
    const toEnvironment = model.edges.find((edge) => edge.id === "application-to-environment");
    expect(toEnvironment).toMatchObject({ fromSide: "top", toSide: "bottom", style: "dashed" });
    const toApp = model.edges.find((edge) => edge.id === "container-to-application");
    expect(toApp).toMatchObject({ style: "emphasis", labelDy: 72 });
  });

  it("ignores unknown optional fields instead of rejecting them", () => {
    const ir = head();
    ir["x-fulcra"] = { links: [] };
    ir.components[0]["x-fulcra"] = { links: [{ kind: "file", path: "src" }] };
    expect(parseJson(ir).kind).toBe("ok");
  });

  it("parses boundaries so they can be listed", () => {
    const ir = head();
    ir.boundaries = [{ kind: "network", label: "cluster" }];
    expect(okModel(parseJson(ir)).boundaries).toEqual([
      { key: "boundary-0", kind: "network", label: "cluster" },
    ]);
  });
});

describe("parseArchitectureIr refuses documents it cannot render faithfully", () => {
  it("refuses an unknown schema_version", () => {
    const ir = head();
    ir.schema_version = 2;
    expectInvalid(parseJson(ir), /^schema_version:/);
  });

  it("refuses a diagram_type other than architecture", () => {
    const ir = head();
    ir.diagram_type = "sequence";
    expectInvalid(parseJson(ir), /^diagram_type:/);
  });

  it("refuses duplicate component ids", () => {
    const ir = head();
    ir.components[1].id = "environment";
    expectInvalid(parseJson(ir), /duplicate id "environment"/);
  });

  it("refuses duplicate connection ids", () => {
    const ir = head();
    ir.connections[1].id = ir.connections[0].id;
    expectInvalid(parseJson(ir), /^connections\.1\.id: duplicate id/);
  });

  it("refuses a connection to an unknown component", () => {
    const ir = head();
    ir.connections[0].to = "nowhere";
    expectInvalid(parseJson(ir), /^connections\.0\.to: unknown component "nowhere"/);
  });

  it("refuses a connection from an unknown component", () => {
    const ir = head();
    ir.connections[0].from = "nowhere";
    expectInvalid(parseJson(ir), /^connections\.0\.from: unknown component "nowhere"/);
  });

  it("refuses a connection without an id", () => {
    const ir = head();
    delete ir.connections[0].id;
    expectInvalid(parseJson(ir), /^connections\.0\.id:/);
  });

  it("refuses coordinates outside the canvas bound", () => {
    const ir = head();
    ir.components[0].pos = [1e9, 0];
    expectInvalid(parseJson(ir), /^components\.0\.pos\.0:/);
  });

  it("refuses a non-positive size", () => {
    const ir = head();
    ir.components[0].size = [0, 62];
    expectInvalid(parseJson(ir), /^components\.0\.size\.0:/);
  });

  it("refuses a label over the length cap", () => {
    const ir = head();
    ir.components[0].label = "x".repeat(ARCHITECTURE_IR_LIMITS.labelLength + 1);
    expectInvalid(parseJson(ir), /^components\.0\.label:/);
  });

  it("accepts a label at the length cap", () => {
    const ir = head();
    ir.components[0].label = "x".repeat(ARCHITECTURE_IR_LIMITS.labelLength);
    expect(parseJson(ir).kind).toBe("ok");
  });

  it("refuses more components than the cap", () => {
    const ir = head();
    ir.connections = [];
    ir.components = Array.from({ length: ARCHITECTURE_IR_LIMITS.maxComponents + 1 }, (_, i) => ({
      id: `n${i}`,
      type: "backend",
      label: `n${i}`,
      pos: [i, 0],
      size: [10, 10],
    }));
    expectInvalid(parseJson(ir), /^components:/);
  });

  it("refuses more connections than the cap", () => {
    const ir = head();
    ir.connections = Array.from({ length: ARCHITECTURE_IR_LIMITS.maxConnections + 1 }, (_, i) => ({
      id: `c${i}`,
      from: "demo",
      to: "app",
    }));
    expectInvalid(parseJson(ir), /^connections:/);
  });

  it("refuses an id that could name an Object.prototype member", () => {
    const ir = head();
    ir.components[0].id = "__proto__";
    ir.connections[1].to = "__proto__";
    expectInvalid(parseJson(ir), /^components\.0\.id: invalid id/);
  });

  it("refuses an id containing a path separator", () => {
    const ir = head();
    ir.components[0].id = "../etc";
    expectInvalid(parseJson(ir), /^components\.0\.id: invalid id/);
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(parseArchitectureIr(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))).toEqual({
      kind: "invalid",
      reasons: ["document: not valid UTF-8"],
    });
  });

  it("refuses text that is not JSON", () => {
    expectInvalid(parseArchitectureIr(encoder.encode("{ nope")), /not valid JSON/);
  });

  it("refuses a document over the byte cap before decoding it", () => {
    const bytes = new Uint8Array(ARCHITECTURE_IR_LIMITS.maxBytes + 1);
    expect(parseArchitectureIr(bytes)).toEqual({
      kind: "too_large",
      bytes: ARCHITECTURE_IR_LIMITS.maxBytes + 1,
    });
  });

  it("accepts a document exactly at the byte cap boundary check", () => {
    const text = JSON.stringify(head());
    const padded = text + " ".repeat(ARCHITECTURE_IR_LIMITS.maxBytes - encoder.encode(text).length);
    expect(encoder.encode(padded).byteLength).toBe(ARCHITECTURE_IR_LIMITS.maxBytes);
    expect(parseArchitectureIr(encoder.encode(padded)).kind).toBe("ok");
  });

  it("caps the number of reasons reported", () => {
    const ir = head();
    ir.connections = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, from: "x", to: "y" }));
    const result = parseJson(ir);
    expect(result.kind === "invalid" && result.reasons.length).toBe(20);
  });
});

describe("display normalisation", () => {
  it("removes bidi controls and flags the model", () => {
    const ir = head();
    ir.components[0].label = "safe\u202Egnp.exe";
    const model = okModel(parseJson(ir));
    expect(model.nodes[0]?.label).toBe("safegnp.exe");
    expect(model.hiddenCharactersRemoved).toBe(true);
  });

  it("turns line breaks into spaces without flagging them as hidden", () => {
    expect(toDisplayText("a\nb\tc")).toEqual({ text: "a b c", hiddenRemoved: false });
  });

  it("removes C0, C1, isolate and mark characters", () => {
    expect(toDisplayText("a\u0000b\u0085c\u2066d\u200Fe\u061Cf")).toEqual({
      text: "abcdef",
      hiddenRemoved: true,
    });
  });

  it("leaves markup as literal text for the renderer to show as text", () => {
    const ir = head();
    ir.components[0].label = '<img src=x onerror="alert(1)">';
    expect(okModel(parseJson(ir)).nodes[0]?.label).toBe('<img src=x onerror="alert(1)">');
  });
});

describe("style lookups are closed sets", () => {
  it("maps known component types and falls back to neutral", () => {
    expect(toneForComponentType("backend")).toBe("service");
    expect(toneForComponentType("database")).toBe("data");
    expect(toneForComponentType("spaceship")).toBe("neutral");
  });

  it("never resolves inherited object members", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(toneForComponentType(name)).toBe("neutral");
      expect(styleForConnectionVariant(name)).toBe("solid");
      expect(toneForCardDot(name)).toBe("neutral");
    }
  });

  it("maps variants and dots, defaulting unknowns", () => {
    expect(styleForConnectionVariant(undefined)).toBe("solid");
    expect(styleForConnectionVariant("dashed")).toBe("dashed");
    expect(styleForConnectionVariant("url(javascript:x)")).toBe("solid");
    expect(toneForCardDot("emerald")).toBe("emerald");
    expect(toneForCardDot("#ff0000")).toBe("neutral");
  });
});
