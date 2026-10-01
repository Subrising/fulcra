import type { AgentManager } from "../agent/agent-manager.js";
import { TrustedPlugins } from "../plugins/trusted.js";

type WithInput = AgentManager["withInput"];

/**
 * Gives an AgentManager test double the host's real V1.1 trusted-input surface.
 *
 * The double keeps any `trustedPlugins`/`withInput` it already defines. Otherwise it gets a real
 * `TrustedPlugins` (the same default AgentManager constructs when no trusted plugin is installed), and a
 * `withInput` that mirrors AgentManager.withInput by routing through that instance. Admission therefore runs
 * the real checks (provenance tokens, operation binding, human-input counting) rather than an allow-all stub.
 */
export function withTrustedSurface<T extends object>(stub: T): T {
  const target = stub as T & { trustedPlugins?: TrustedPlugins; withInput?: WithInput };
  const trustedPlugins = target.trustedPlugins ?? new TrustedPlugins();
  if (!target.trustedPlugins) target.trustedPlugins = trustedPlugins;
  if (!target.withInput) {
    const withInput = (
      agentId: string,
      kind: Parameters<WithInput>[1],
      messageId: string | undefined,
      operation: Parameters<WithInput>[3],
      payload?: Parameters<WithInput>[4],
      handle?: Parameters<WithInput>[5],
    ) => {
      return trustedPlugins.input(
        // With no trusted plugin registered, admission reads only the agent id; passing the id alone keeps
        // the double's own getAgent call sequence untouched.
        { id: agentId } as Parameters<TrustedPlugins["input"]>[0],
        kind,
        messageId,
        () => operation(trustedPlugins.captureOperation()),
        payload,
        handle,
      );
    };
    target.withInput = withInput as WithInput;
  }
  return stub;
}
