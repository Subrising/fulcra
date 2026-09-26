import {
  ARCHITECTURE_IR_LIMITS,
  architectureIrSchema,
  type ArchitectureIr,
  type ArchitectureSide,
} from "./ir-schema";

// The IR is untrusted input. This module turns bytes into a render model that the view can
// draw without further checks: every string is display-safe plain text, every style is one of
// a fixed set of tokens, and every connection resolves to two known components. Anything else
// fails the whole document closed, with reasons, rather than rendering part of it.

export type NodeTone =
  | "service"
  | "client"
  | "external"
  | "data"
  | "messaging"
  | "cloud"
  | "security"
  | "neutral";

export type EdgeStyle = "solid" | "emphasis" | "dashed";

export type CardTone = "emerald" | "cyan" | "amber" | "rose" | "violet" | "neutral";

export interface ArchitectureMapNode {
  id: string;
  type: string;
  tone: NodeTone;
  label: string;
  sublabel: string | null;
  tag: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArchitectureMapEdge {
  id: string;
  from: string;
  to: string;
  label: string | null;
  style: EdgeStyle;
  fromSide: ArchitectureSide | null;
  toSide: ArchitectureSide | null;
  labelDy: number;
}

// Cards, items and boundaries have no identity in the IR; `key` is their stable position in the
// document so the view never keys rows by a render-time index.
export interface ArchitectureMapCardItem {
  key: string;
  text: string;
}

export interface ArchitectureMapCard {
  key: string;
  tone: CardTone;
  title: string;
  items: ArchitectureMapCardItem[];
}

export interface ArchitectureMapBoundary {
  key: string;
  kind: string;
  label: string;
}

export interface ArchitectureMapModel {
  title: string;
  subtitle: string | null;
  nodes: ArchitectureMapNode[];
  edges: ArchitectureMapEdge[];
  cards: ArchitectureMapCard[];
  boundaries: ArchitectureMapBoundary[];
  /** True when control or bidi characters were removed from any displayed string. */
  hiddenCharactersRemoved: boolean;
}

export type ArchitectureIrParseResult =
  | { kind: "ok"; model: ArchitectureMapModel }
  | { kind: "too_large"; bytes: number }
  | { kind: "invalid"; reasons: string[] };

const NODE_TONES: ReadonlyMap<string, NodeTone> = new Map([
  ["backend", "service"],
  ["frontend", "client"],
  ["external", "external"],
  ["database", "data"],
  ["messagebus", "messaging"],
  ["cloud", "cloud"],
  ["security", "security"],
]);

const EDGE_STYLES: ReadonlyMap<string, EdgeStyle> = new Map([
  ["emphasis", "emphasis"],
  ["dashed", "dashed"],
  ["solid", "solid"],
]);

const CARD_TONES: ReadonlyMap<string, CardTone> = new Map([
  ["emerald", "emerald"],
  ["cyan", "cyan"],
  ["amber", "amber"],
  ["rose", "rose"],
  ["violet", "violet"],
]);

// Lookups go through Map.get so a value such as "constructor" or "__proto__" can never resolve
// to something inherited from Object.prototype.
export function toneForComponentType(type: string): NodeTone {
  return NODE_TONES.get(type) ?? "neutral";
}

export function styleForConnectionVariant(variant: string | undefined): EdgeStyle {
  return (variant === undefined ? undefined : EDGE_STYLES.get(variant)) ?? "solid";
}

export function toneForCardDot(dot: string | undefined): CardTone {
  return (dot === undefined ? undefined : CARD_TONES.get(dot)) ?? "neutral";
}

// C0/C1 controls (line breaks and tabs become spaces), and the bidi embedding, override,
// isolate and mark characters that can make a label display differently from what it says.
const LINE_CONTROLS = /[\t\n\r\v\f]/g;
const HIDDEN_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export interface DisplayText {
  text: string;
  hiddenRemoved: boolean;
}

export function toDisplayText(value: string): DisplayText {
  const spaced = value.replace(LINE_CONTROLS, " ");
  const text = spaced.replace(HIDDEN_CHARACTERS, "");
  return { text, hiddenRemoved: text !== spaced };
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "document" : path.map(String).join(".");
}

function checkReferences(ir: ArchitectureIr): string[] {
  const reasons: string[] = [];
  const componentIds = new Set<string>();
  for (const [index, component] of ir.components.entries()) {
    if (componentIds.has(component.id)) {
      reasons.push(`components.${index}.id: duplicate id "${component.id}"`);
    }
    componentIds.add(component.id);
  }
  const connectionIds = new Set<string>();
  for (const [index, connection] of ir.connections.entries()) {
    if (connectionIds.has(connection.id)) {
      reasons.push(`connections.${index}.id: duplicate id "${connection.id}"`);
    }
    connectionIds.add(connection.id);
    if (!componentIds.has(connection.from)) {
      reasons.push(`connections.${index}.from: unknown component "${connection.from}"`);
    }
    if (!componentIds.has(connection.to)) {
      reasons.push(`connections.${index}.to: unknown component "${connection.to}"`);
    }
  }
  return reasons;
}

function buildModel(ir: ArchitectureIr): ArchitectureMapModel {
  let hiddenCharactersRemoved = false;
  const display = (value: string): string => {
    const result = toDisplayText(value);
    hiddenCharactersRemoved ||= result.hiddenRemoved;
    return result.text;
  };
  const optionalDisplay = (value: string | undefined): string | null => {
    if (value === undefined) return null;
    const result = display(value);
    return result.length > 0 ? result : null;
  };

  const nodes = ir.components.map((component) => ({
    id: component.id,
    type: display(component.type),
    tone: toneForComponentType(component.type),
    label: display(component.label),
    sublabel: optionalDisplay(component.sublabel),
    tag: optionalDisplay(component.tag),
    x: component.pos[0],
    y: component.pos[1],
    width: component.size[0],
    height: component.size[1],
  }));
  const edges = ir.connections.map((connection) => ({
    id: connection.id,
    from: connection.from,
    to: connection.to,
    label: optionalDisplay(connection.label),
    style: styleForConnectionVariant(connection.variant),
    fromSide: connection.fromSide ?? null,
    toSide: connection.toSide ?? null,
    labelDy: connection.labelDy ?? 0,
  }));
  const cards = ir.cards.map((card, cardIndex) => ({
    key: `card-${cardIndex}`,
    tone: toneForCardDot(card.dot),
    title: display(card.title),
    items: card.items.map((item, itemIndex) => ({
      key: `card-${cardIndex}-item-${itemIndex}`,
      text: display(item),
    })),
  }));
  const boundaries = ir.boundaries.map((boundary, boundaryIndex) => ({
    key: `boundary-${boundaryIndex}`,
    kind: display(boundary.kind),
    label: display(boundary.label),
  }));
  return {
    title: display(ir.meta.title),
    subtitle: optionalDisplay(ir.meta.subtitle),
    nodes,
    edges,
    cards,
    boundaries,
    hiddenCharactersRemoved,
  };
}

export function parseArchitectureIr(bytes: Uint8Array): ArchitectureIrParseResult {
  if (bytes.byteLength > ARCHITECTURE_IR_LIMITS.maxBytes) {
    return { kind: "too_large", bytes: bytes.byteLength };
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "invalid", reasons: ["document: not valid UTF-8"] };
  }
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return { kind: "invalid", reasons: ["document: not valid JSON"] };
  }
  const parsed = architectureIrSchema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: "invalid",
      reasons: parsed.error.issues
        .slice(0, 20)
        .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`),
    };
  }
  const referenceReasons = checkReferences(parsed.data);
  if (referenceReasons.length > 0) {
    return { kind: "invalid", reasons: referenceReasons.slice(0, 20) };
  }
  return { kind: "ok", model: buildModel(parsed.data) };
}
