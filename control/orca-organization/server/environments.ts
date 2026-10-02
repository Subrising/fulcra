// Fulcra J8 Environments, server side. Thin, typed views over the controller's operator methods
// (src/control/environments.mjs), which decide every rule. This file adds only:
//   - the last good view per project, returned `stale` when the controller does not answer (CONTRACTS §1);
//   - per-row validation, so one malformed record drops out instead of blanking the tab.
// There is no handler that runs a promotion: running follows a chosen, proven approval in the controller.
import {
  environmentsRpc,
  environmentProposeRpc,
  promotionCreateRpc,
  promotionCancelRpc,
  environmentView,
  promotionView,
  promotion,
} from "../shared/cc/environment";
import type { ContractInput, ContractOutput } from "../shared/rpc-contract";
type Call = (method: string, input?: unknown) => Promise<any>;
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const message = (e: unknown) => clip(e instanceof Error ? e.message : String(e), 500);

export function createEnvironments({
  call,
  now = () => new Date().toISOString(),
}: {
  call: Call;
  now?: () => string;
}) {
  const last = new Map<string, ContractOutput<typeof environmentsRpc>>();
  return {
    async view(input: unknown): Promise<ContractOutput<typeof environmentsRpc>> {
      const { projectId } = environmentsRpc.input.parse(input);
      try {
        const raw = await call("environments-view", { projectId });
        const environments = (raw?.environments ?? []).flatMap((e: unknown) => {
          const r = environmentView.safeParse(e);
          return r.success ? [r.data] : [];
        });
        const promotions = (raw?.promotions ?? []).flatMap((p: unknown) => {
          const r = promotionView.safeParse(p);
          return r.success ? [r.data] : [];
        });
        const partial =
          environments.length !== (raw?.environments ?? []).length ||
          promotions.length !== (raw?.promotions ?? []).length;
        const out = environmentsRpc.output.parse({
          version: 1,
          observedAt: raw?.observedAt ?? now(),
          partial,
          stale: false,
          error: null,
          projectId,
          environments,
          promotions,
        });
        last.set(projectId, out);
        return out;
      } catch (error) {
        const kept = last.get(projectId);
        if (kept) return { ...kept, stale: true, error: message(error) };
        return {
          version: 1,
          observedAt: now(),
          partial: true,
          stale: true,
          error: message(error),
          projectId,
          environments: [],
          promotions: [],
        };
      }
    },
    async propose(
      input: ContractInput<typeof environmentProposeRpc>,
    ): Promise<ContractOutput<typeof environmentProposeRpc>> {
      const a = environmentProposeRpc.input.parse(input);
      try {
        const r = await call("environments-propose", a);
        return {
          ok: true,
          message: null,
          observedAt: now(),
          environmentId: r.environmentId ?? null,
          decisionId: r.decisionId ?? null,
          waiting: r.waiting ?? null,
        };
      } catch (error) {
        return {
          ok: false,
          message: message(error),
          observedAt: now(),
          environmentId: null,
          decisionId: null,
          waiting: null,
        };
      }
    },
    async create(
      input: ContractInput<typeof promotionCreateRpc>,
    ): Promise<ContractOutput<typeof promotionCreateRpc>> {
      const a = promotionCreateRpc.input.parse(input);
      try {
        const r = await call("promotions-create", a);
        return {
          ok: true,
          message: null,
          observedAt: now(),
          promotion: promotion.parse(r.promotion),
          waiting: r.waiting ?? null,
        };
      } catch (error) {
        return {
          ok: false,
          message: message(error),
          observedAt: now(),
          promotion: null,
          waiting: null,
        };
      }
    },
    async cancel(
      input: ContractInput<typeof promotionCancelRpc>,
    ): Promise<ContractOutput<typeof promotionCancelRpc>> {
      const a = promotionCancelRpc.input.parse(input);
      try {
        const r = await call("promotions-cancel", a);
        return {
          ok: true,
          message: null,
          observedAt: now(),
          promotion: promotion.parse(r.promotion),
        };
      } catch (error) {
        return { ok: false, message: message(error), observedAt: now(), promotion: null };
      }
    },
  };
}
