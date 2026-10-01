// Fulcra §3.6 paired devices, server side: thin typed views over the controller's operator methods
// (src/control/devices.mjs), which verify every signature. A refusal is returned as an answer ({ok:false, message}),
// never retried here.
import { devicesRpc, devicePairOpenRpc, devicePairCompleteRpc, devicePairApproveRpc, deviceRevokeRpc, device } from "../shared/cc/devices";
import type { ContractInput, ContractOutput } from "../shared/rpc-contract";
type Call = (method: string, input?: unknown) => Promise<any>;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
// v1.8 §3.6 rule 3 (R2-1): the first-device window opens only when BOTH the host offers its device API (J5b ctx.device)
// and the prime has switched pairing on in the controller. This is the host half; the controller checks its own.
export const PAIRING_OFF = "Pairing arrives with the next Fulcra update";
export function createDevices({ call, hostDevice = false, now = () => new Date().toISOString() }: { call: Call; hostDevice?: boolean; now?: () => string }) {
  let last: ContractOutput<typeof devicesRpc> | null = null;
  const written = async (method: string, input: unknown) => {
    const observedAt = now();
    try { const r = await call(method, input); return { ok: true, message: null, observedAt, device: device.parse(r.device) }; }
    catch (e) { return { ok: false, message: message(e), observedAt, device: null }; }
  };
  return {
    async list(): Promise<ContractOutput<typeof devicesRpc>> {
      try { const r = await call("devices-list", null); last = devicesRpc.output.parse({ version: 1, observedAt: r.observedAt, stale: false, error: null, devices: r.devices, pairingWindow: r.pairingWindow }); return last; }
      catch (e) { return last ? { ...last, stale: true, error: message(e) } : { version: 1, observedAt: now(), stale: true, error: message(e), devices: [], pairingWindow: null }; }
    },
    async open(_input: ContractInput<typeof devicePairOpenRpc>): Promise<ContractOutput<typeof devicePairOpenRpc>> {
      const observedAt = now();
      if (!hostDevice) return { ok: false, message: PAIRING_OFF, observedAt, windowId: null, code: null, expiresAt: null };
      try { const r = await call("devices-pair-open", null); return { ok: true, message: r.note ?? null, observedAt, windowId: r.windowId, code: r.code, expiresAt: r.expiresAt }; }
      catch (e) { return { ok: false, message: message(e), observedAt, windowId: null, code: null, expiresAt: null }; }
    },
    complete: (input: ContractInput<typeof devicePairCompleteRpc>): Promise<ContractOutput<typeof devicePairCompleteRpc>> => written("devices-pair-complete", input),
    approve: (input: ContractInput<typeof devicePairApproveRpc>): Promise<ContractOutput<typeof devicePairApproveRpc>> => written("devices-pair-approve", input),
    revoke: (input: ContractInput<typeof deviceRevokeRpc>): Promise<ContractOutput<typeof deviceRevokeRpc>> => written("devices-revoke", input),
  };
}
