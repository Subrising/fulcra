// Live-check shim for "@getpaseo/plugin/client": deploy reads and actions go to the real engine through bridge.mjs;
// every other Command Centre read is answered from the fictional fixtures, as in verify-screens.mjs.
export * from "../shims/plugin-client.mjs";
import { fixture } from "../fixtures.mjs";

const BRIDGE = new URLSearchParams(location.search).get("bridge") ?? "http://127.0.0.1:47901/rpc";
export function useRpc(definition) {
  if (!definition.name.startsWith("organization.deploy-"))
    return (input) => fixture(definition.name, input);
  return async (input) => {
    const r = await fetch(BRIDGE, {
      method: "POST",
      body: JSON.stringify({ name: definition.name, input }),
    });
    const body = await r.json();
    if (!body.ok) throw new Error(body.message);
    return body.output;
  };
}
