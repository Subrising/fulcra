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
