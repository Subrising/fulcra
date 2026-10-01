import { ARCHITECTURE_IR_LIMITS } from "./ir-schema";

// Maps live at a fixed, workspace-relative location (prime decision J4). Only direct children
// of that directory are considered, and the path handed to the daemon is always built from the
// fixed directory plus a single validated file name, never from anything inside an IR. The
// daemon additionally realpath-confines every read to the workspace root.

export const ARCHITECTURE_MAP_DIRECTORY = ".fulcra/architecture";
export const ARCHITECTURE_MAP_SUFFIX = ".ir.json";
export const MAX_ARCHITECTURE_MAPS = 20;

// A plain file name: no separators, no NUL, not a dot-segment, and a visible first character.
const SAFE_FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,119}$/;

export interface ArchitectureMapEntry {
  name: string;
  path: string;
  size: number;
}

export interface DirectoryEntryLike {
  name: string;
  kind: "file" | "directory";
  size: number;
}

export function isArchitectureMapFileName(name: string): boolean {
  return (
    SAFE_FILE_NAME.test(name) &&
    name.endsWith(ARCHITECTURE_MAP_SUFFIX) &&
    name.length > ARCHITECTURE_MAP_SUFFIX.length &&
    !name.includes("..")
  );
}

export function architectureMapPath(name: string): string | null {
  return isArchitectureMapFileName(name) ? `${ARCHITECTURE_MAP_DIRECTORY}/${name}` : null;
}

export interface ArchitectureMapListing {
  maps: ArchitectureMapEntry[];
  oversized: string[];
  truncated: boolean;
}

export function selectArchitectureMaps(
  entries: readonly DirectoryEntryLike[],
): ArchitectureMapListing {
  const candidates = entries
    .filter((entry) => entry.kind === "file" && isArchitectureMapFileName(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const oversized = candidates
    .filter((entry) => entry.size > ARCHITECTURE_IR_LIMITS.maxBytes)
    .map((entry) => entry.name);
  const readable = candidates.filter((entry) => entry.size <= ARCHITECTURE_IR_LIMITS.maxBytes);
  const maps = readable.slice(0, MAX_ARCHITECTURE_MAPS).flatMap((entry) => {
    const path = architectureMapPath(entry.name);
    return path ? [{ name: entry.name, path, size: entry.size }] : [];
  });
  return { maps, oversized, truncated: readable.length > MAX_ARCHITECTURE_MAPS };
}

/** Missing directory reads as "no maps", not as a failure. */
export function isMissingDirectoryError(message: string): boolean {
  return /ENOENT|no such file|not found|does not exist/i.test(message);
}
