export type {
  PluginHostProps,
  PluginSurfaceProps,
  PluginScreenProps,
  PluginPopoverProps,
  PluginScreenParams,
  PluginOpenScreenInput,
  PluginScreenLocation,
  PluginSidebarItemProps,
  PluginSidebarItemContribution,
  PluginIconProps,
  PluginPanelLocation,
  PluginOpenPanelOptions,
  PluginWorkspacePanelProps,
  PluginAgentPanelProps,
  PluginClientOpenPanelOptions,
  PluginClientContext,
  PluginChoicePayload,
  PluginChoiceProof,
  PluginDevice,
  PluginDeviceKeyStorage,
  PluginDevicePairResult,
  PluginDevicePlatform,
  PluginDeviceStatus,
  PluginClientContribution,
  PluginWorkspacePanelContribution,
  PluginSettingsScreenContribution,
  PluginSurfaceContribution,
  PluginScreenContribution,
  PluginScreenTitle,
  PluginSidebarContribution,
  PluginTimelineTransformerContribution,
  PluginTimelineItemProps,
  PluginTimelineRendererContribution,
  PluginTurnFooterContribution,
  PluginTurnFooterProps,
  PluginTurnToolCall,
  PluginCommandCapabilities,
  PluginGlobalCommandContext,
  PluginWorkspaceCommandContext,
  PluginAgentCommandContext,
  PluginCommandCenterItemContribution,
  PluginClientSlashCommandContribution,
  SettingsState,
} from "./contracts.js";
export type {
  PluginButton,
  PluginButtonBehavior,
  PluginButtonContentProps,
  PluginButtonContext,
  PluginButtonIcon,
  PluginButtonIconProps,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginComposerPillContribution,
  PluginHeaderButtonContribution,
} from "./buttons.js";
export { usePaseo } from "./paseo-context.js";
export { useAgent, useWorkspace } from "./client-state.js";
export { useRpc } from "./rpc-context.js";
import type { SettingsDefinition } from "../settings.js";
import type { SettingsState } from "./contracts.js";
import type { ZodType } from "zod";
export declare function useSettings<Schema extends ZodType>(
  definition: SettingsDefinition<Schema>,
): SettingsState<Schema>;

/** Configured app host, including hosts that are currently disconnected. */
export interface PluginHostSummary {
  readonly serverId: string;
  readonly label: string;
  readonly status: "idle" | "connecting" | "online" | "offline" | "error";
}
/** Live configured hosts. Supplied by the app's client bundle loader. */
export declare function useHosts(): readonly PluginHostSummary[];
/** Borrow an online host's API under this installation's lifetime. */
export declare function getPaseoClient(serverId: string): import("@getpaseo/client").PaseoApi;
/** Open an absolute HTTP(S) URL using the client platform’s external opener. */
export declare function openExternalUrl(url: string): Promise<void>;

/** Sanitised immutable projection of native events already cached by this app. No new host read. */
export interface PluginObservedAgent {
  readonly serverId: string;
  readonly agentId: string;
  readonly hostName: string;
  readonly connection: PluginHostSummary["status"];
  readonly title: string;
  readonly provider: string;
  readonly model: string | null;
  readonly status: string;
  readonly activity: "working" | "idle" | "permission" | "error" | "unknown" | "unavailable";
  readonly observedAt: string | null;
  /** Creation ancestry only; never an organisation/reporting relationship. */
  readonly creatorAgentId: string | null;
  readonly workspace: {
    readonly id: string;
    readonly projectId: string;
    readonly projectName: string;
    readonly kind: string;
    readonly changesAvailable: boolean;
  } | null;
}
export interface PluginObservedAgentDirectory {
  readonly entries: readonly PluginObservedAgent[];
  readonly total: number;
  readonly truncated: number;
  /** Cached records with inconsistent host identity are counted but never routed. */
  readonly withheld?: number;
  readonly source: "native-cache";
}
/** Optional at runtime on older apps. Cache observation only, with explicit subset coverage. */
export declare function useObservedAgents(): PluginObservedAgentDirectory;
