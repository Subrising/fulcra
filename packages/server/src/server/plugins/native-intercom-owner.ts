import {
  PromoteReportPrimeSchema,
  DemoteReportPrimeSchema,
} from "@getpaseo/protocol/native-report-hierarchy";
import {
  RegisterReportPrimeSchema,
  AdoptReportParentSchema,
} from "@getpaseo/protocol/native-intercom";
import type { ManagementAuthority } from "./management.js";
import type { MessageReceipts } from "../message-receipts/index.js";
import type { NativeReportRegistry } from "../report-registry.js";
import type { IntercomRates } from "../intercom-rates.js";

/** Real owner invocation only; report/paired credentials cannot enter this native reserved route. */
export function registerNativeIntercomRates(
  management: ManagementAuthority,
  rates: IntercomRates,
): void {
  management.registerOwnerHandler("intercom-rate-settings-get", async (command, owner) => {
    if (command.input !== null) throw new Error("Invalid native Settings read input");
    const result = await rates.snapshot(owner.requireOwner);
    owner.requireOwner();
    return result;
  });
  management.registerOwnerHandler("intercom-rate-settings-set", async (command, owner) => {
    const result = await rates.set(command.input, owner.requireOwner);
    owner.requireOwner();
    return result;
  });
}

/** Only ManagementAuthority's owner route can invoke these private registration writes. */
export function registerNativeReportRegistry(
  management: ManagementAuthority,
  registry: NativeReportRegistry,
): void {
  management.registerOwnerHandler("report-prime-promote", async (command, owner) => {
    const input = PromoteReportPrimeSchema.parse(command.input);
    const result = await registry.promotePrime(input, owner);
    owner.requireOwner();
    if (result.current) await registry.publishHierarchyGrants(result.epoch, owner);
    owner.requireOwner();
    return result;
  });
  management.registerOwnerHandler("report-prime-demote", async (command, owner) => {
    const input = DemoteReportPrimeSchema.parse(command.input);
    const result = await registry.demotePrime(input, owner);
    owner.requireOwner();
    if (result.current) await registry.publishHierarchyGrants(result.epoch, owner);
    owner.requireOwner();
    return result;
  });
  management.registerOwnerHandler("report-project-transfer", async (command, owner) => {
    const result = await registry.transferProject(command.input, owner);
    owner.requireOwner();
    if (result.current) await registry.publishHierarchyGrants(result.epoch, owner);
    owner.requireOwner();
    return result;
  });
  management.registerOwnerHandler("artifact-tool-owner-set", (command, owner) =>
    registry.setArtifactTool(command.input, owner),
  );
  management.registerOwnerHandler("report-prime-register", async (command, owner) => {
    const input = RegisterReportPrimeSchema.parse(command.input);
    const receipt = await registry.registerPrime(input, owner);
    owner.requireOwner();
    if (receipt.current) await registry.publishReportGrant(input.identity, receipt.epoch, owner);
    owner.requireOwner();
    return receipt;
  });
  management.registerOwnerHandler("report-parent-adopt", async (command, owner) => {
    const input = AdoptReportParentSchema.parse(command.input);
    const receipt = await registry.adoptParent(input, owner);
    owner.requireOwner();
    if (receipt.current) await registry.publishReportGrant(input.child, receipt.epoch, owner);
    owner.requireOwner();
    return receipt;
  });
  management.registerOwnerHandler("report-registration-revoke", (command, owner) =>
    registry.revoke(command.input, owner),
  );
}

/** Host bootstrap wiring only; never exposed to a plugin or report credential. */
export function registerNativeReceiptMaintenance(
  management: ManagementAuthority,
  receipts: MessageReceipts,
): void {
  management.registerOwnerHandler("intercom-receipt-maintenance", async (command, authority) => {
    if (command.input !== null) throw new Error("Invalid native maintenance status input");
    // Retain the real ManagementAuthority guard across every awaited ledger boundary.
    const status = await receipts.maintenance(authority.requireOwner);
    authority.requireOwner();
    return status;
  });
}
