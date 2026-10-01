import type {
  ArchitectureChangeImpact,
  CheckoutArchitectureChangeGetResponse,
} from "@getpaseo/protocol/messages";
import type { TFunction } from "i18next";
import { buildArchitectureChange, type ArchitectureChange } from "./architecture-change";

// A change drawn from its code by the host (`checkout.architecture-change.get`, CONTRACTS v1.17): the two
// generated maps go through the same comparison as drawn maps, so the pictures, colours and "Also affected" list
// are the ones people already know. The host's blast radius adds what a drawn map can't: the files and parts a
// change edits, what imports them, and whether tests reach them.

export type GeneratedPayload = CheckoutArchitectureChangeGetResponse["payload"];
export type ReadyChange = Extract<ArchitectureChange, { kind: "ready" }>;

const EDITED_NOTE = /\s·\s\d+ edited$/;

/**
 * A part whose files changed but whose shape did not would look unchanged in the pictures. The After map notes
 * how many of its files the change edited, so it is drawn as changed and counted as touched.
 */
export function noteEditedParts(afterText: string, impact: ArchitectureChangeImpact): string {
  const edited = new Map(impact.parts.map((p) => [p.id, p.added + p.modified + p.deleted]));
  const ir = JSON.parse(afterText) as { components?: { id?: unknown; tag?: unknown }[] };
  for (const component of ir.components ?? []) {
    const count = typeof component.id === "string" ? edited.get(component.id) : undefined;
    if (!count) continue;
    const tag = typeof component.tag === "string" ? component.tag.replace(EDITED_NOTE, "") : "";
    component.tag = `${tag}${tag ? " · " : ""}${count} edited`.slice(0, 200);
  }
  return JSON.stringify(ir);
}

export function generatedChange(payload: GeneratedPayload): ArchitectureChange | null {
  if (payload.status !== "ok" || !payload.before || !payload.after || !payload.impact) return null;
  const after = noteEditedParts(payload.after, payload.impact);
  return buildArchitectureChange({
    mapPath: "generated",
    headText: after,
    mapDiff: null,
    // The file facts come from the host's blast radius, not the drawn-map staleness rules.
    changedFiles: [],
    siblings: new Map(),
    pullRequest: payload.pullRequest ? { number: payload.pullRequest.number } : {},
    pullRequestMaps: { kind: "ok", base: payload.before, head: after },
  });
}

function listOf(items: readonly string[], max = 4): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

const baseName = (file: string) => file.slice(file.lastIndexOf("/") + 1);

/** What the change does, in a few plain sentences built from the comparison and the blast radius. */
export function plainSummary(
  t: TFunction,
  change: ReadyChange,
  impact: ArchitectureChangeImpact,
): string[] {
  const label = (id: string) =>
    change.head?.nodes.find((n) => n.id === id)?.label ??
    change.base?.nodes.find((n) => n.id === id)?.label ??
    id;
  const edgeLabel = (model: ReadyChange["head"], id: string) => {
    const edge = model?.edges.find((e) => e.id === id);
    return edge ? `${label(edge.from)} → ${label(edge.to)}` : id;
  };
  const k = "panels.architectureMap.change.generated";
  const lines: string[] = [
    t(`${k}.plainScope`, {
      files: impact.counts.files,
      parts: impact.parts.length,
      added: impact.counts.added,
      deleted: impact.counts.deleted,
    }),
  ];
  const { components, connections } = change.comparison;
  if (components.added.length)
    lines.push(t(`${k}.plainAddsParts`, { list: listOf(components.added.map(label)) }));
  if (components.removed.length)
    lines.push(t(`${k}.plainRemovesParts`, { list: listOf(components.removed.map(label)) }));
  if (connections.added.length)
    lines.push(
      t(`${k}.plainAddsConnections`, {
        list: listOf(
          connections.added.map((id) => edgeLabel(change.head, id)),
          3,
        ),
      }),
    );
  if (connections.removed.length)
    lines.push(
      t(`${k}.plainRemovesConnections`, {
        list: listOf(
          connections.removed.map((id) => edgeLabel(change.base, id)),
          3,
        ),
      }),
    );
  if (
    !components.added.length &&
    !components.removed.length &&
    !connections.added.length &&
    !connections.removed.length
  ) {
    lines.push(t(`${k}.plainStructureNone`));
  }
  const { dependents } = impact;
  lines.push(
    dependents.files === 0
      ? t(`${k}.plainReachNone`)
      : t(`${k}.plainReach`, {
          direct: dependents.direct ?? 0,
          files: dependents.files,
          parts: dependents.parts.length,
          top: listOf(
            dependents.parts.map((p) => p.label),
            3,
          ),
        }),
  );
  const { coverage } = impact;
  if (coverage.code === 0) lines.push(t(`${k}.plainTestsNoCode`));
  else if (coverage.covered === coverage.code) lines.push(t(`${k}.plainTestsAll`));
  else
    lines.push(
      t(`${k}.plainTestsSome`, {
        uncovered: coverage.code - coverage.covered,
        code: coverage.code,
        list: listOf(coverage.uncovered.map(baseName), 3),
      }),
    );
  return lines;
}
