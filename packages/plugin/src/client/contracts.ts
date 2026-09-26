import type { ComponentType } from "react";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract } from "../rpc.js";
import type {
  PluginButtonRegistration,
  PluginHeaderButtonContribution,
  PluginComposerPillContribution,
} from "./buttons.js";
import type {
  PluginTheme,
  PluginWorkspaceSnapshot,
  PluginAgentSnapshot,
  PluginThemeContribution,
  PluginAttachmentSourceContribution,
  PluginTimelineTransformResult,
  PluginCleanup,
} from "../contracts.js";

export interface PluginHostProps {
  theme: PluginTheme;
  host: {
    id: string;
    label: string;
  };
  layout: {
    compact: boolean;
    platform: "ios" | "android" | "web";
  };
}

interface PluginNavigableHostProps extends PluginHostProps {
  /** Client-owned navigation. Undefined on older hosts; hide dependent affordances when absent. */
  readonly navigation?: {
    /** Present only on Electron. The browser runs locally; serverId selects workspace ownership. */
    readonly openBrowser?: (input: {
      readonly url: string;
      readonly workspaceId: string;
      readonly serverId?: string;
    }) => void;
    readonly openAgent: (input: { readonly agentId: string; readonly serverId?: string }) => void;
    readonly openWorkspace: (input: {
      readonly workspaceId: string;
      readonly serverId?: string;
    }) => void;
    /**
     * Optional on older clients. Requests navigation to a saved host even when offline.
     * An unloaded registry or missing host returns unavailable; requests are never queued.
     * Distinct from openAgent's optional serverId, which navigates without checking the host.
     */
    readonly openAgentOnHost?: (input: {
      readonly serverId: string;
      readonly agentId: string;
    }) => "requested" | "host-unavailable";
  };
}

export interface PluginSurfaceProps extends PluginNavigableHostProps {}

export interface PluginIconProps {
  name: string;
  size?: number;
  color?: string;
}

export type PluginPanelLocation = "workspace" | "explorer";

export interface PluginOpenPanelOptions {
  location?: PluginPanelLocation;
}

interface PluginWorkspacePanelBase {
  id: string;
  title: string;
  icon: string;
  locations?: readonly PluginPanelLocation[];
}

export interface PluginWorkspacePanelProps extends PluginNavigableHostProps {
  context: "workspace";
  workspaceId: string;
}

export interface PluginAgentPanelProps extends PluginNavigableHostProps {
  context: "agent";
  workspaceId: string;
  agentId: string;
}

export interface PluginClientOpenPanelOptions extends PluginOpenPanelOptions {
  workspaceId: string;
  agentId?: string;
}

// The answering device's key. The private key never leaves the device and is
// never reachable from the daemon or plugin server code; plugin client code gets status, pairing
// and choice signatures, each confirmed by the user on the device.
export type PluginDevicePlatform = "macos" | "ios" | "android" | "windows" | "linux";
export type PluginDeviceKeyStorage =
  | "secure-enclave"
  | "keychain-biometric"
  | "android-keystore"
  | "os-protected"
  | "software";

export interface PluginDeviceStatus {
  paired: boolean;
  deviceId?: string;
  publicKey?: string;
  platform: PluginDevicePlatform;
  keyStorage: PluginDeviceKeyStorage;
  // True when every signature needs Touch ID, Face ID or a fingerprint (or the device passcode).
  userPresence: boolean;
}

export interface PluginDevicePairResult {
  deviceId: string;
  // base64 DER SubjectPublicKeyInfo, P-256.
  publicKey: string;
  alg: "ES256";
  platform: PluginDevicePlatform;
  keyStorage: PluginDeviceKeyStorage;
  userPresence: boolean;
}

// Exactly the choice payload; anything else is refused before any prompt.
export interface PluginChoicePayload {
  decisionId: string;
  revision: number;
  optionId: string;
  digest: string | null;
  messageId: string;
  note: string;
  at: string;
  confirmDestructive: boolean;
}

export interface PluginChoiceProof {
  deviceId: string;
  alg: "ES256";
  // base64 raw r‖s (64 bytes) over the canonical JSON of `payload`.
  signature: string;
  payload: PluginChoicePayload;
}

export interface PluginDevice {
  status(): Promise<PluginDeviceStatus>;
  // Asks for Touch ID / Face ID / fingerprint (or a confirmation where the device has none), then
  // generates the key. `code` is the pairing code, shown in the prompt.
  pair(input?: { code?: string }): Promise<PluginDevicePairResult>;
  // `reason` is shown in the prompt, prefixed with "Fulcra:". A refused prompt rejects.
  sign(payload: PluginChoicePayload, reason: string): Promise<PluginChoiceProof>;
}

export interface PluginClientContext extends PluginCommandCapabilities {
  // Present only in apps that can hold a device key (iOS, Android, desktop). Absent in the
  // browser and in older apps.
  device?: PluginDevice;
  addSettingsScreen(contribution: PluginSettingsScreenContribution): PluginCleanup;
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): PluginCleanup;
  addSidebarItem(contribution: PluginSidebarContribution): PluginCleanup;
  addWorkspacePanel(contribution: PluginWorkspacePanelContribution): PluginCleanup;
  addCommandCenterItem(contribution: PluginCommandCenterItemContribution): PluginCleanup;
  addSlashCommand(contribution: PluginClientSlashCommandContribution): PluginCleanup;
  addHeaderButton(contribution: PluginHeaderButtonContribution): PluginButtonRegistration;
  addComposerPill(contribution: PluginComposerPillContribution): PluginButtonRegistration;
  addAttachmentSource(contribution: PluginAttachmentSourceContribution): PluginCleanup;
  addTheme(contribution: PluginThemeContribution): PluginCleanup;
  addTimelineTransformer<ItemType extends AgentTimelineItem["type"]>(
    contribution: PluginTimelineTransformerContribution<ItemType>,
  ): PluginCleanup;
  addTimelineRenderer<Schema extends ZodType>(
    contribution: PluginTimelineRendererContribution<Schema>,
  ): PluginCleanup;
  openPanel(id: string, options: PluginClientOpenPanelOptions): void;
}

export type PluginClientContribution = (client: PluginClientContext) => PluginCleanup;

export type PluginWorkspacePanelContribution =
  | (PluginWorkspacePanelBase & {
      context: "workspace";
      Component: ComponentType<PluginWorkspacePanelProps>;
    })
  | (PluginWorkspacePanelBase & {
      context: "agent";
      Component: ComponentType<PluginAgentPanelProps>;
    });

export interface PluginSettingsScreenContribution {
  id: string;
  title: string;
  icon: string;
  Component: ComponentType<PluginSurfaceProps>;
}

export interface PluginSurfaceContribution {
  id: string;
  Component: ComponentType<PluginSurfaceProps>;
}

export interface PluginSidebarContribution {
  id: string;
  title: string;
  icon: string;
  surface: string;
}

export type PluginTimelineTransformerContribution<
  ItemType extends AgentTimelineItem["type"] = AgentTimelineItem["type"],
> = ItemType extends AgentTimelineItem["type"]
  ? {
      id: string;
      query: {
        itemType: ItemType;
      };
      transform(input: {
        item: Extract<AgentTimelineItem, { type: ItemType }>;
        phase: "streaming" | "complete";
      }): PluginTimelineTransformResult | undefined;
    }
  : never;

export interface PluginTimelineItemProps<Data = unknown> extends PluginHostProps {
  agentId: string;
  item: {
    type: "plugin";
    kind: string;
    version: number;
    data: Data;
  };
  timestamp: Date;
}

export interface PluginTimelineRendererContribution<Schema extends ZodType = ZodType> {
  kind: string;
  version: number;
  schema: Schema;
  Component: ComponentType<PluginTimelineItemProps<ZodOutput<Schema>>>;
}

export interface PluginCommandCapabilities {
  paseo: PaseoApi;
  rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    input: ZodInput<InputSchema>,
  ): Promise<ZodOutput<OutputSchema>>;
  openSurface(id: string): void;
  openSettings(id: string): void;
}

export interface PluginGlobalCommandContext extends PluginCommandCapabilities {
  context: "global";
}

export interface PluginWorkspaceCommandContext extends PluginCommandCapabilities {
  context: "workspace";
  workspace: PluginWorkspaceSnapshot;
  openPanel(id: string, options?: PluginOpenPanelOptions): void;
}

export interface PluginAgentCommandContext extends PluginCommandCapabilities {
  context: "agent";
  workspace: PluginWorkspaceSnapshot;
  agent: PluginAgentSnapshot;
  openPanel(id: string, options?: PluginOpenPanelOptions): void;
}

interface PluginCommandCenterItemBase {
  id: string;
  title: string;
  icon: string;
  keywords?: readonly string[];
}

export type PluginCommandCenterItemContribution =
  | (PluginCommandCenterItemBase & {
      context: "global";
      onSelect(context: PluginGlobalCommandContext): void | Promise<void>;
    })
  | (PluginCommandCenterItemBase & {
      context: "workspace";
      onSelect(context: PluginWorkspaceCommandContext): void | Promise<void>;
    })
  | (PluginCommandCenterItemBase & {
      context: "agent";
      onSelect(context: PluginAgentCommandContext): void | Promise<void>;
    });

interface PluginClientSlashCommandBase {
  name: string;
  description: string;
  argumentHint: string;
}

export type PluginClientSlashCommandContribution =
  | (PluginClientSlashCommandBase & {
      context: "workspace";
      onSubmit(context: PluginWorkspaceCommandContext & { args: string }): void | Promise<void>;
    })
  | (PluginClientSlashCommandBase & {
      context: "agent";
      onSubmit(context: PluginAgentCommandContext & { args: string }): void | Promise<void>;
    });

export type SettingsState<Schema extends ZodType> = (
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "invalid"; error: string; revision: string }
  | { status: "ready"; values: ZodOutput<Schema>; revision: string }
) & {
  saving: boolean;
  saveError: string | null;
  /** Save an entire document against the revision currently displayed. Never throws. */
  save(values: ZodOutput<Schema>, revision: string): Promise<boolean>;
  reset(): Promise<boolean>;
  reload(): Promise<void>;
};
