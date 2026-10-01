import { z } from "zod";

// Shared credential store and plugin notifications (Fulcra CONTRACTS §3.4, §7.2). Every RPC here is
// gated on `server_info.features.credentials` / `features.pluginNotifications`. No response ever
// carries a secret: account rows are metadata only.

export const ConnectorIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
export const SignInMethodSchema = z.enum(["browser", "device", "token", "cli"]);
export const SignInRedirectSchema = z.enum(["app", "loopback"]);

export const CredentialAccountSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  connector: ConnectorIdSchema,
  site: z.string().nullable(),
  displayName: z.string(),
  method: SignInMethodSchema,
  scopes: z.array(z.string()),
  state: z.enum(["connected", "expired", "needs-reconnect", "revoked"]),
  expiresAt: z.string().nullable(),
  lastCheckedAt: z.string(),
  createdAt: z.string(),
});

export const SignInMethodAvailabilitySchema = z.object({
  method: SignInMethodSchema,
  // `unavailable` and `needs-broker` methods are hidden in the UI; `token` is always available.
  status: z.enum(["available", "unavailable", "needs-broker"]),
  reason: z.string().optional(),
});

export const CredentialProviderSummarySchema = z.object({
  connector: ConnectorIdSchema,
  label: z.string(),
  selfHosted: z.boolean(),
  requiresSite: z.boolean(),
  requiresEmailForToken: z.boolean(),
  // The token form offers an optional username (Bitbucket Data Center personal tokens).
  acceptsUsernameForToken: z.boolean().optional(),
  methods: z.array(SignInMethodAvailabilitySchema),
  tokenHelp: z.object({ createUrl: z.string(), scopes: z.array(z.string()), note: z.string() }),
});

export const SignInFlowSchema = z.object({
  flowId: z.string(),
  method: SignInMethodSchema,
  expiresAt: z.string(),
  userCode: z.string().optional(),
  verifyUrl: z.string().optional(),
  authUrl: z.string().optional(),
});

export const SignInCompleteInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("token"),
    token: z.string().min(1).max(4096),
    // Jira and Bitbucket Cloud: the account email (required). Bitbucket Data Center: an optional
    // username for a personal token. Refused for other connectors.
    email: z.string().max(254).optional(),
  }),
  z.object({ kind: z.literal("poll") }),
  // The OAuth redirect the app received: fulcra://oauth/<flowId>?code=…&state=…
  z.object({ kind: z.literal("callback"), url: z.string().min(1).max(4096) }),
]);

export const SignInCompleteResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), retryAfterSeconds: z.number() }),
  z.object({ status: z.literal("connected"), account: CredentialAccountSchema }),
]);

export const CredentialsListRequestSchema = z.object({
  type: z.literal("credentials.list.request"),
  requestId: z.string(),
});

export const CredentialsBeginRequestSchema = z.object({
  type: z.literal("credentials.begin.request"),
  requestId: z.string(),
  connector: ConnectorIdSchema,
  method: SignInMethodSchema,
  site: z.string().max(260).optional(),
  redirect: SignInRedirectSchema.optional(),
});

export const CredentialsCompleteRequestSchema = z.object({
  type: z.literal("credentials.complete.request"),
  requestId: z.string(),
  // Omitted for a callback: the host reads the flow id from the callback URL.
  flowId: z.string().optional(),
  input: SignInCompleteInputSchema,
});

export const CredentialsReconnectRequestSchema = z.object({
  type: z.literal("credentials.reconnect.request"),
  requestId: z.string(),
  accountId: z.string(),
  method: SignInMethodSchema.optional(),
  redirect: SignInRedirectSchema.optional(),
});

export const CredentialsRemoveRequestSchema = z.object({
  type: z.literal("credentials.remove.request"),
  requestId: z.string(),
  accountId: z.string(),
});

export const CredentialsListResponseSchema = z.object({
  type: z.literal("credentials.list.response"),
  payload: z.object({
    requestId: z.string(),
    accounts: z.array(CredentialAccountSchema),
    providers: z.array(CredentialProviderSummarySchema),
  }),
});

export const CredentialsBeginResponseSchema = z.object({
  type: z.literal("credentials.begin.response"),
  payload: z.object({ requestId: z.string(), flow: SignInFlowSchema }),
});

export const CredentialsCompleteResponseSchema = z.object({
  type: z.literal("credentials.complete.response"),
  payload: z.object({ requestId: z.string(), result: SignInCompleteResultSchema }),
});

export const CredentialsReconnectResponseSchema = z.object({
  type: z.literal("credentials.reconnect.response"),
  payload: z.object({ requestId: z.string(), flow: SignInFlowSchema }),
});

export const CredentialsRemoveResponseSchema = z.object({
  type: z.literal("credentials.remove.response"),
  payload: z.object({ requestId: z.string(), removed: z.boolean() }),
});

export const PluginNotificationSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  key: z.string(),
  title: z.string(),
  urgency: z.enum(["now", "today", "fyi"]),
  deepLink: z.string().nullable(),
  createdAt: z.string(),
  // True only once the push service accepted the push.
  pushed: z.boolean(),
  delivery: z.enum(["not-needed", "pending", "sent", "no-devices", "failed"]).optional(),
});

export const PluginNotificationsListRequestSchema = z.object({
  type: z.literal("plugin.notifications.list.request"),
  requestId: z.string(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const PluginNotificationsListResponseSchema = z.object({
  type: z.literal("plugin.notifications.list.response"),
  payload: z.object({ requestId: z.string(), notifications: z.array(PluginNotificationSchema) }),
});

export type CredentialAccount = z.infer<typeof CredentialAccountSchema>;
export type CredentialProviderSummary = z.infer<typeof CredentialProviderSummarySchema>;
export type SignInFlow = z.infer<typeof SignInFlowSchema>;
export type SignInCompleteInput = z.infer<typeof SignInCompleteInputSchema>;
export type SignInCompleteResult = z.infer<typeof SignInCompleteResultSchema>;
export type PluginNotification = z.infer<typeof PluginNotificationSchema>;
export type SignInMethod = z.infer<typeof SignInMethodSchema>;
export type SignInRedirect = z.infer<typeof SignInRedirectSchema>;
