import type { TrustedPluginContributionV11 } from "@getpaseo/plugin/server";
import type {
  ControllerManagementCommandV11,
  ManagementPrincipalV11,
} from "@getpaseo/protocol/controller-management";
import type { ControllerChannel } from "./controller-channel.js";
import type { RadiusScratchInput } from "@getpaseo/protocol/radius-scratch";
import type { ProvenanceBindingV11 } from "@getpaseo/protocol/trusted-input";
export interface ControllerDistribution {
  setup: TrustedPluginContributionV11;
  validate(command: ControllerManagementCommandV11): ControllerManagementCommandV11;
  /** D13: whether a validated command is a controller read (read-only devices run only these). Optional. */
  isRead?(command: ControllerManagementCommandV11): boolean;
  readonly ready: boolean;
  /** Private host-owned grant directory from the existing distribution home. */
  readonly reportGrantDirectory?: string;
  /** Host-private fixed-root adapter. Original owner/destructive closures never cross the wire. */
  simulateRadiusScratch?(
    input: RadiusScratchInput,
    assertCurrentOwner: () => void,
    assertCurrentPruneOwner?: () => void,
  ): unknown;
  start(host: {
    /** Host-owned private store path, never a shared config key or caller input. */
    intercomRateSettingsFile?: string;
    automaticResumeEnabled?: () => boolean;
    boot: string;
    /** The boot this one replaced (daemon-boot.ts), or null when it cannot be established. */
    previousBoot?: string | null;
    consumeManagement(
      command: ControllerManagementCommandV11,
      principal: ManagementPrincipalV11,
    ): void;
    createChannel(
      child: object,
      send: (frame: unknown) => Promise<unknown>,
      emit: (frame: unknown) => void,
      issue: (binding: ProvenanceBindingV11) => string,
    ): ControllerChannel & { serviceReady(): void };
  }): void;
  stop(): Promise<void>;
  /** End of an orderly shutdown only: this boot's final human-input counters, keyed by agent id. */
  sealBoot?(record: { boot: string; humanAt: Readonly<Record<string, number>> }): void;
}
