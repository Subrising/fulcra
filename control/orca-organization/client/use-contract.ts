import { useRpc } from "@getpaseo/plugin/client";
import type { Contract, ContractReceive, ContractSend } from "../shared/rpc-contract";

/**
 * `useRpc` with the plugin's `extends ZodType` constraint removed. Same hook at runtime; see
 * `shared/rpc-contract.ts` for why that constraint cannot be discharged under zod 4.6.2.
 */
export const useContract = useRpc as unknown as <Input, Output>(
  contract: Contract<Input, Output>,
) => (
  input: ContractSend<Contract<Input, Output>>,
) => Promise<ContractReceive<Contract<Input, Output>>>;
