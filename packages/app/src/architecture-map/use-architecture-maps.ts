import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import {
  ARCHITECTURE_MAP_DIRECTORY,
  isMissingDirectoryError,
  selectArchitectureMaps,
  type ArchitectureMapListing,
} from "./discovery";
import { parseArchitectureIr, type ArchitectureIrParseResult } from "./ir-model";
import { ARCHITECTURE_IR_LIMITS } from "./ir-schema";

// Read-only by construction: the only daemon calls are a directory listing of the fixed map
// directory and a size-capped file read. The daemon confines both to the workspace root.

// Maps are edited by hand between reads; a short stale time plus the panel's Reload keeps the
// view current without polling.
const MAP_STALE_TIME_MS = 5000;

export type ArchitectureMapListState =
  | { kind: "missing" }
  | ({ kind: "listed" } & ArchitectureMapListing);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useArchitectureMapList(input: { serverId: string; workspaceRoot: string | null }) {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: MAP_STALE_TIME_MS,
    queryKey: ["architecture-map-list", input.serverId, input.workspaceRoot],
    enabled: Boolean(client && input.workspaceRoot),
    retry: false,
    queryFn: async (): Promise<ArchitectureMapListState> => {
      if (!client || !input.workspaceRoot) return { kind: "missing" };
      try {
        const directory = await client.listDirectory(
          input.workspaceRoot,
          ARCHITECTURE_MAP_DIRECTORY,
        );
        return { kind: "listed", ...selectArchitectureMaps(directory.entries) };
      } catch (error) {
        if (isMissingDirectoryError(errorMessage(error))) return { kind: "missing" };
        throw error;
      }
    },
  });
}

export function useArchitectureMapDocument(input: {
  serverId: string;
  workspaceRoot: string | null;
  path: string | null;
  size: number | null;
}) {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: MAP_STALE_TIME_MS,
    queryKey: [
      "architecture-map-document",
      input.serverId,
      input.workspaceRoot,
      input.path,
      input.size,
    ],
    enabled: Boolean(client && input.workspaceRoot && input.path),
    retry: false,
    queryFn: async (): Promise<ArchitectureIrParseResult> => {
      if (!client || !input.workspaceRoot || !input.path) {
        return { kind: "invalid", reasons: ["document: unavailable"] };
      }
      const file = await client.readFile(
        input.workspaceRoot,
        input.path,
        undefined,
        ARCHITECTURE_IR_LIMITS.maxBytes,
      );
      return parseArchitectureIr(file.bytes);
    },
  });
}
