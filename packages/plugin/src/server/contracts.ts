import type { PaseoApi } from "@getpaseo/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract } from "../rpc.js";
import type { PluginCleanup } from "../contracts.js";
import type { ProviderRegistration } from "./provider.js";
import type { PluginLifecycleRegistration } from "./lifecycle.js";

export interface PluginHandlerContext {
  paseo: PaseoApi;
  management?: import("./management.js").PluginManagementContextV11;
}

export type PluginSettingsState<Schema extends ZodType> =
  | {
      status: "ready";
      revision: string;
      values: ZodOutput<Schema>;
    }
  | {
      status: "invalid";
      revision: string;
      error: string;
    };

export interface PluginSettings<Schema extends ZodType> {
  read(): Promise<PluginSettingsState<Schema>>;
  subscribe(listener: (state: PluginSettingsState<Schema>) => void | Promise<void>): PluginCleanup;
}

// Secrets the operator stored for this plugin in the host's login keychain. The host namespaces every
// name by plugin id; `exists` never reads the value. Hosts that predate this capability omit it.
export interface PluginSecrets {
  read(name: string): Promise<string | null>;
  exists(name: string): Promise<boolean>;
}

// A notification for the user. Every accepted one joins the host's in-app list; only `now` also
// pushes to the Fulcra apps. Title only, at most 120 characters, one line. Idempotent by `key`:
// repeating a key returns the original. Requires `requirements.notify: true` in the manifest.
export interface PluginNotifyInput {
  key: string;
  title: string;
  urgency: "now" | "today" | "fyi";
  // An app route ("/inbox/…") or a fulcra:// link.
  deepLink?: string;
}

export interface PluginNotifyResult {
  id: string;
  duplicate: boolean;
}

// A provider API request the host makes for the plugin with a connected account's credential.
// `path` is relative to the account's provider API base (api.github.com; https://<site>/rest/api/…
// for Jira; api.bitbucket.org/2.0/… or the Bitbucket Data Center site's /rest/…). Authentication is
// the host's: an Authorization, Cookie or Host header is refused.
export interface PluginCredentialRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  headers?: Record<string, string>;
  body?: unknown;
}

// The provider's answer with the account's secret scrubbed out. `headers` holds only content-type,
// etag, last-modified, link, retry-after and the x-ratelimit-* headers. `body` is parsed JSON when
// the provider answered JSON, otherwise text.
export interface PluginCredentialResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

// The shared credential store. The plugin never receives a secret. `request` reaches only accounts
// of connectors listed in the manifest's `requirements.credentials`; methods other than GET also
// need `requirements.credentialsWrite`. Each account has a per-minute request budget.
export interface PluginCredentials {
  request(
    accountId: string,
    connectorId: string,
    request: PluginCredentialRequest,
  ): Promise<PluginCredentialResponse>;
  // Once per item: copies a token this plugin stored with `security add-generic-password` under
  // `ai.fulcra.plugin.<runtime id>` into an account. The old item is left untouched.
  importLegacy(input: {
    secretName: string;
    connector: string;
    site?: string | null;
    email?: string | null;
  }): Promise<{ accountId: string; imported: boolean }>;
}

export interface PluginServerContext extends PluginLifecycleRegistration {
  inputObservations: import("./trusted.js").TrustedPluginServer["inputObservations"];
  /** Available only in a bundled index.host.js contribution; ordinary plugins are refused. */
  admission: import("./trusted.js").TrustedPluginServer["admission"];
  guard: import("./trusted.js").TrustedPluginServer["guard"];
  claude: import("./trusted.js").TrustedPluginServer["claude"];
  issueProvenance: import("./trusted.js").TrustedPluginServer["issueProvenance"];
  secrets?: PluginSecrets;
  // Hosts that predate these capabilities omit them.
  notify?(input: PluginNotifyInput): Promise<PluginNotifyResult>;
  credentials?: PluginCredentials;
  registerSettings<Schema extends ZodType>(
    definition: import("../settings.js").SettingsDefinition<Schema>,
  ): PluginSettings<Schema>;
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
    /** D13: `readOnly` declares a read. A read-only device may call only the bundled Command Centre plugin's reads. */
    options?: { readOnly?: boolean },
  ): void;
  registerProvider(provider: ProviderRegistration): void;
}

export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
