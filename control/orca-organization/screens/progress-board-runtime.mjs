// Browser host adapter. The screen and RPC contract use their production implementations.
export { useRpc } from "../../../packages/plugin/src/client/rpc-context";
export function useHosts() {
  return window.boardHostCatalog;
}
export async function invokeHostRpc(host, method, input) {
  const response = await fetch(`/rpc/${host}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, input }),
  });
  if (!response.ok) throw Error("Host unavailable");
  return response.json();
}

export function getPaseoClient(host) {
  const snapshot = () => invokeHostRpc(host, "progress.board.snapshot", {});
  return {
    agents: {
      list: async () => ({
        entries: (await snapshot()).projects.flatMap((p) =>
          p.jobs.map((job) => ({
            agent: {
              ...job,
              pendingPermissions: [],
              labels: { project: p.name },
              model: job.model,
            },
          })),
        ),
        pageInfo: { hasMore: false },
        subscription: { release: async () => {} },
      }),
      // The board refreshes on agent updates; this fixture host sends none.
      subscribe: () => () => {},
    },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  };
}
