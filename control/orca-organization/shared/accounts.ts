// Update-7: Settings -> Accounts & Defaults. The account pool (server/accounts.mjs) and the persisted role defaults
// (server/role-defaults-store.mjs), both in Fulcra's own files, never the shared config (L44). No read returns a
// credential or a path; the only credential that crosses this contract is a Claude token being ADDED (write only).
import { z } from "zod";
import { defineContract } from "./rpc-contract";

export const POOL_PROVIDERS = ["claude", "codex"] as const;
export const DEFAULT_ROLES = [
  "orchestration",
  "planning",
  "review",
  "implementation",
  "research",
] as const;
export type DefaultRole = (typeof DEFAULT_ROLES)[number];
const provider = z.enum(POOL_PROVIDERS);
const status = z.union([
  z.object({ state: z.literal("ok") }).strict(),
  z.object({ state: z.literal("disabled") }).strict(),
  z.object({ state: z.literal("auth-expired") }).strict(),
  z.object({ state: z.literal("signing-in") }).strict(),
  z.object({ state: z.literal("limited"), until: z.string().max(40) }).strict(),
]);
const account = z
  .object({
    id: z.string().uuid(),
    provider,
    name: z.string().max(60),
    enabled: z.boolean(),
    priority: z.number().int(),
    status,
    limitNote: z.string().max(200).nullable(),
    sessions: z.array(z.string().max(80)).max(50),
    lastUsedAt: z.string().max(40).nullable(),
  })
  .strict();
const selection = z
  .object({
    model: z.string().max(200).nullable(),
    thinkingOptionId: z.string().max(40).nullable(),
  })
  .strict();
const roleDefaults = z
  .object({ provider: provider.nullable(), claude: selection, codex: selection })
  .strict();
export const accountsView = z
  .object({
    policy: z.enum(["priority", "spread"]),
    accounts: z.array(account).max(32),
    allLimited: z
      .object({
        claude: z.string().max(40).nullable().optional(),
        codex: z.string().max(40).nullable().optional(),
      })
      .strict(),
    // `from` is null when a manual switch moved a session that had no account yet; `reason: "manual"` marks the owner's own switch
    // (the same field W2's continuation record carries; a usage-limit move has none).
    rotations: z
      .array(
        z
          .object({
            at: z.string(),
            session: z.string().max(80),
            provider,
            from: z.string().max(60).nullable(),
            to: z.string().max(60).nullable(),
            resetAt: z.string().nullable(),
            earliestReset: z.string().nullable(),
            reason: z.literal("manual").optional(),
          })
          .strict(),
      )
      .max(20),
    // The account each provider's NEW sessions take while it is ready (null: the pool's order decides).
    defaultAccounts: z
      .object({ claude: z.string().uuid().nullable(), codex: z.string().uuid().nullable() })
      .strict(),
    // Update-7 W3: the default permission mode per provider for new sessions, and the modes Settings offers.
    defaults: z
      .object({
        roles: z.record(z.enum(DEFAULT_ROLES), roleDefaults),
        orchestrationGuard: z.boolean(),
        modes: z.object({ claude: z.string().max(40), codex: z.string().max(40) }).strict(),
        modeChoices: z
          .object({
            claude: z.array(z.string().max(40)).max(8),
            codex: z.array(z.string().max(40)).max(8),
          })
          .strict(),
      })
      .strict(),
    // Per provider: models and the efforts each offers here, so the form only offers what the installed CLI supports.
    catalog: z
      .object({
        claude: z
          .array(
            z.object({ id: z.string(), label: z.string(), efforts: z.array(z.string()) }).strict(),
          )
          .nullable(),
        codex: z
          .array(
            z.object({ id: z.string(), label: z.string(), efforts: z.array(z.string()) }).strict(),
          )
          .nullable(),
      })
      .strict(),
  })
  .strict();
export type AccountsView = z.infer<typeof accountsView>;
const ok = z.object({ ok: z.boolean(), message: z.string().max(300).nullable() }).strict();
export const accountsRpc = defineContract({
  name: "organization.accounts",
  input: z.object({}).strict(),
  output: accountsView,
});
export const accountAddRpc = defineContract({
  name: "organization.accounts.add",
  // Claude: the token `claude setup-token` printed (kept in the Keychain; never echoed). Codex: none -- a browser
  // sign-in starts on this Mac and the account reads "signing in" until it completes.
  input: z
    .object({ provider, name: z.string().min(1).max(60), token: z.string().max(1024).optional() })
    .strict(),
  output: ok,
});
export const accountUpdateRpc = defineContract({
  name: "organization.accounts.update",
  input: z
    .object({
      id: z.string().uuid(),
      name: z.string().min(1).max(60).optional(),
      enabled: z.boolean().optional(),
      priority: z.number().int().min(1).max(99).optional(),
      clearLimit: z.literal(true).optional(),
      token: z.string().max(1024).optional(),
      signIn: z.literal(true).optional(),
      remove: z.literal(true).optional(),
      // 7b fold: swap with the neighbour of the same provider, atomically on the server.
      move: z.enum(["up", "down"]).optional(),
    })
    .strict(),
  output: ok,
});
export const poolSettingsRpc = defineContract({
  name: "organization.accounts.settings",
  input: z
    .object({
      policy: z.enum(["priority", "spread"]).optional(),
      role: z.enum(DEFAULT_ROLES).optional(),
      defaults: roleDefaults.optional(),
      orchestrationGuard: z.boolean().optional(),
      defaultAccount: z.object({ provider, id: z.string().uuid().nullable() }).strict().optional(),
      mode: z
        .object({ provider, modeId: z.string().min(1).max(40) })
        .strict()
        .optional(),
    })
    .strict(),
  output: ok,
});
// W1: "Switch account…" for one session (its menu, and /account in its chat). The read lists that session's provider's
// accounts with their state; the switch is a write, so a read-only device cannot make it.
export const sessionAccountsView = z
  .object({
    provider: provider.nullable(),
    current: z.string().uuid().nullable(),
    accounts: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string().max(60),
            status,
            isDefault: z.boolean(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type SessionAccountsView = z.infer<typeof sessionAccountsView>;
export const sessionAccountsRpc = defineContract({
  name: "organization.accounts.session",
  input: z.object({ agentId: z.string().min(1).max(80) }).strict(),
  output: sessionAccountsView,
});
// `account`: an account id, or its name as typed after /account (any case).
export const accountSwitchRpc = defineContract({
  name: "organization.accounts.switch",
  input: z
    .object({ agentId: z.string().min(1).max(80), account: z.string().min(1).max(80) })
    .strict(),
  output: ok,
});

// Explicit account continuation; distinct from giving a delegated session back to its human owner.
export const accountTakeoverRpc = defineContract({
  name: "organization.accounts.takeover",
  input: accountSwitchRpc.input,
  output: ok,
});
