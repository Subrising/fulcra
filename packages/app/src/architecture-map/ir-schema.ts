import { z } from "zod";

// Architecture IR v1, the diagram source format Archify's CLI compiles. Fulcra reads the same
// files and renders them itself; no Archify code is copied. Only the fields evidenced by the
// reviewed example IRs and the comparator receipt are modelled. Unknown optional fields are
// stripped (not rejected) so an IR stays portable between the two renderers. Every limit here
// bounds work done on untrusted input before anything is laid out or drawn.
export const ARCHITECTURE_IR_LIMITS = {
  maxBytes: 1_048_576,
  maxComponents: 500,
  maxConnections: 2000,
  maxCards: 12,
  maxCardItems: 20,
  maxBoundaries: 100,
  maxCoordinate: 100_000,
  maxSize: 10_000,
  maxLabelDy: 1000,
  titleLength: 200,
  subtitleLength: 400,
  labelLength: 120,
  detailLength: 200,
  cardTitleLength: 120,
  cardItemLength: 400,
} as const;

const L = ARCHITECTURE_IR_LIMITS;

// Ids are identities (the comparator keys components and connections by id) and are used only
// as Map keys, never as object keys; the pattern also keeps `__proto__` and friends out.
export const ARCHITECTURE_IR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const idSchema = z.string().regex(ARCHITECTURE_IR_ID_PATTERN, "invalid id");
const text = (max: number) => z.string().max(max);
const coordinate = z.number().finite().min(-L.maxCoordinate).max(L.maxCoordinate);
const extent = z.number().finite().min(1).max(L.maxSize);
const side = z.enum(["top", "bottom", "left", "right"]);

const componentSchema = z.object({
  id: idSchema,
  type: z.string().max(64),
  label: text(L.labelLength),
  sublabel: text(L.detailLength).optional(),
  tag: text(L.detailLength).optional(),
  pos: z.tuple([coordinate, coordinate]),
  size: z.tuple([extent, extent]),
});

const connectionSchema = z.object({
  id: idSchema,
  from: idSchema,
  to: idSchema,
  label: text(L.detailLength).optional(),
  variant: z.string().max(64).optional(),
  fromSide: side.optional(),
  toSide: side.optional(),
  labelDy: z.number().finite().min(-L.maxLabelDy).max(L.maxLabelDy).optional(),
});

const cardSchema = z.object({
  dot: z.string().max(64).optional(),
  title: text(L.cardTitleLength),
  items: z.array(text(L.cardItemLength)).max(L.maxCardItems).default([]),
});

const boundarySchema = z.object({
  kind: z.string().max(64),
  label: text(L.labelLength),
});

export const architectureIrSchema = z.object({
  schema_version: z.literal(1),
  diagram_type: z.literal("architecture"),
  meta: z.object({
    title: text(L.titleLength),
    subtitle: text(L.subtitleLength).optional(),
  }),
  components: z.array(componentSchema).min(1).max(L.maxComponents),
  connections: z.array(connectionSchema).max(L.maxConnections).default([]),
  cards: z.array(cardSchema).max(L.maxCards).default([]),
  boundaries: z.array(boundarySchema).max(L.maxBoundaries).default([]),
});

export type ArchitectureIr = z.infer<typeof architectureIrSchema>;
export type ArchitectureIrComponent = ArchitectureIr["components"][number];
export type ArchitectureIrConnection = ArchitectureIr["connections"][number];
export type ArchitectureSide = z.infer<typeof side>;
