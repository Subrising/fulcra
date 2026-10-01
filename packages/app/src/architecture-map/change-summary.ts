import { ARCHITECTURE_MAP_DIRECTORY, ARCHITECTURE_MAP_SUFFIX } from "./discovery";
import type { ArchitectureMapModel } from "./ir-model";

// The rules behind the Change view's warnings and counts. They match the control repo's ADW gate
// (orca-architecture-map/validate.mjs --since): a change is significant when it touches
// SIGNIFICANT_FILES or more files (map files not counted), or any file a map cites as its source;
// a significant change that changed no map file leaves the diagram possibly out of date.

export const SIGNIFICANT_FILES = 10;
// "services.yaml SHA256 6ee1e4c3" -- the Source card citation the map skill requires.
const CITATION = /^([A-Za-z0-9_./ -]+?) SHA-?256 ([0-9a-f]{8,64})\b/i;
const CODE = /\.(mjs|js|ts|tsx|cjs|mts|cts|jsx)$/;
const TEST = /\.test\.|\.spec\.|(^|\/)__tests__\//;

export function isArchitectureMapPath(path: string): boolean {
  return (
    path.startsWith(`${ARCHITECTURE_MAP_DIRECTORY}/`) &&
    path.endsWith(ARCHITECTURE_MAP_SUFFIX) &&
    !path.slice(ARCHITECTURE_MAP_DIRECTORY.length + 1).includes("/")
  );
}

/** Project-relative source files the map says it was drawn from. */
export function citedSources(model: Pick<ArchitectureMapModel, "cards"> | null): string[] {
  if (!model) return [];
  const found = new Set<string>();
  for (const card of model.cards) {
    for (const item of card.items) {
      const match = CITATION.exec(item.text);
      if (match?.[1]) found.add(match[1].trim());
    }
  }
  return [...found].sort();
}

export interface Staleness {
  significant: boolean;
  /** Files changed, map files not counted. */
  fileCount: number;
  /** Cited source files this change touched. */
  citedChanged: string[];
  mapUpdated: boolean;
  outOfDate: boolean;
}

export function assessStaleness(input: {
  changedPaths: readonly string[];
  cited: readonly string[];
}): Staleness {
  const mapFiles = input.changedPaths.filter(isArchitectureMapPath);
  const fileCount = input.changedPaths.length - mapFiles.length;
  const citedChanged = input.cited.filter((file) => input.changedPaths.includes(file));
  const significant = fileCount >= SIGNIFICANT_FILES || citedChanged.length > 0;
  const mapUpdated = mapFiles.length > 0;
  return {
    significant,
    fileCount,
    citedChanged,
    mapUpdated,
    outOfDate: significant && !mapUpdated,
  };
}

/** Changed JavaScript/TypeScript files that are not tests and still exist. */
export function changedCodeFiles(
  changed: readonly { path: string; isDeleted: boolean }[],
): string[] {
  return changed
    .filter((file) => !file.isDeleted && CODE.test(file.path) && !TEST.test(file.path))
    .map((file) => file.path)
    .sort();
}

export function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
}

/**
 * The quick check this view can make without reading the whole project: a test file named after
 * the changed file sits beside it ("cart.ts" and "cart.test.ts"). The decision summary uses the
 * full import-graph check from the control repo; this one only claims what it looked at.
 */
export function hasTestBeside(path: string, siblingNames: readonly string[]): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const stem = name.replace(/\.[^.]+$/, "");
  return siblingNames.some(
    (sibling) =>
      sibling !== name &&
      (sibling.startsWith(`${stem}.test.`) || sibling.startsWith(`${stem}.spec.`)),
  );
}
