// Screenshot shim for "@getpaseo/plugin/client": every read is answered from the fictional fixtures.
import {
  fixture,
  changeWorkspaces,
  multihost,
  WORKSHOP_SERVER_ID,
  WORKSHOP_AGENT_ID,
} from "../fixtures.mjs";
export function useRpc(definition) {
  return (input) => fixture(definition.name, input);
}

export function usePaseo() {
  return { workspaces: { list: async () => ({ entries: changeWorkspaces }) } };
}

// MH2: the app's saved hosts and its own live read of the second host (only in the two-host picture).
const WORKSHOP = { serverId: WORKSHOP_SERVER_ID, label: "Workshop", status: "online" };
export function useHosts() {
  return multihost() ? [WORKSHOP] : [];
}
export function getPaseoClient(serverId) {
  const now = Date.now(),
    ago = (minutes) => new Date(now - minutes * 60000).toISOString();
  const workshop = [
    {
      id: WORKSHOP_AGENT_ID,
      status: "idle",
      title: "Tally builder",
      provider: "codex",
      updatedAt: ago(1),
      backgroundWork: { count: 1 },
    },
    {
      id: "00000000-0000-4000-8000-000000000401",
      status: "idle",
      title: "Tally release check",
      provider: "claude",
      updatedAt: ago(20),
    },
    {
      id: "00000000-0000-4000-8000-000000000402",
      status: "running",
      title: "Nightly build",
      provider: "codex",
      updatedAt: ago(35),
      backgroundWork: { count: 1 },
    },
    {
      id: "00000000-0000-4000-8000-000000000403",
      status: "closed",
      title: "Old spike",
      provider: "codex",
      updatedAt: ago(600),
    },
  ];
  return {
    agents: {
      list: async () => ({
        entries: serverId === WORKSHOP_SERVER_ID ? workshop.map((agent) => ({ agent })) : [],
      }),
    },
  };
}
