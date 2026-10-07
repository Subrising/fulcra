import path from "node:path";
import { OrganizationStore } from "./store.mjs";
import { installationPath } from "../installation";
import { currentManagement } from "../management-context.mjs";
import {
  organizationDirectoryRpc,
  organizationMutateRpc,
  organizationReceiverRpc,
} from "../../shared/workspace-organization";
import { createIntakeReceiverReader } from "./receiver.mjs";
import { localCall } from "../management";
import { CONTROLLER_METHOD } from "../../shared/roles";
import { COMPANY } from "../tasks";
import type { Contract, ContractInput, ContractOutput } from "../../shared/rpc-contract";
type Register = <I, O>(
  contract: Contract<I, O>,
  handler: (
    input: ContractInput<Contract<I, O>>,
  ) => ContractOutput<Contract<I, O>> | Promise<ContractOutput<Contract<I, O>>>,
  readOnly?: boolean,
) => void;
export function contributeWorkspaceOrganization(register: Register) {
  let store: OrganizationStore | undefined;
  const owned = () =>
    (store ??= new OrganizationStore(
      path.join(installationPath("controllerHome"), "workspace-organization.sqlite"),
    ));
  register(organizationDirectoryRpc, () => ({ ...owned().read(), companyId: COMPANY }), true);
  register(
    organizationReceiverRpc,
    createIntakeReceiverReader(() => localCall(CONTROLLER_METHOD.directory)),
    true,
  );
  register(organizationMutateRpc, (input) => {
    const invocation = currentManagement();
    if (!invocation || invocation.readOnly)
      throw new Error("Workspace organization is read-only on this connection");
    return { ...owned().mutate(input), companyId: COMPANY };
  });
  return () => {
    store?.close();
    store = undefined;
  };
}
