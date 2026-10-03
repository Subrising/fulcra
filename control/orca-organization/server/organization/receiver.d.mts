import type { organizationReceiverRpc } from "../../shared/workspace-organization";
import type { ContractInput, ContractOutput } from "../../shared/rpc-contract";
export function createIntakeReceiverReader(
  readDirectory: () => Promise<unknown>,
): (
  input: ContractInput<typeof organizationReceiverRpc>,
) => Promise<ContractOutput<typeof organizationReceiverRpc>>;
