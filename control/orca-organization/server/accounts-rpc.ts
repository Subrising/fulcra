// Update-7: the Settings -> Accounts & models handlers. Reads return names, order, status, sessions and defaults only;
// a Claude token is accepted on add/replace and goes straight to the Keychain, never to a store, a log or a reply.
import fs from "node:fs";
import {
  readAccounts,
  publicView,
  addAccount,
  setAccount,
  moveAccount,
  removeAccount,
  setPolicy,
  setRotateOnLimit,
  setDefaultAccount,
  sessionAccounts,
  switchSession,
  controllerTakeOver,
  createKeychain,
  codexLogin,
  codexHome,
  PROVIDERS,
  type TakeOver,
} from "./accounts.mjs";
import { readRoleDefaults, writeRoleDefaults, MODE_CHOICES } from "./role-defaults-store.mjs";
import { accountAuthority, askOwner, recordAccountAction } from "./account-authority.mjs";
import type { AccountsView, SessionAccountsView } from "../shared/accounts";

type Paseo =
  | {
      providers?: { listModels?: (provider: string) => Promise<any> };
      agents?: {
        ref?: (id: string) => {
          refresh?: () => Promise<unknown>;
          current?: () => { provider?: string } | null;
        };
      };
    }
  | null
  | undefined;
// `takeOver`: the seam that continues a running session on another account with its history (W2). Absent, a switch
// takes effect at the session's next start.
// `host`: this Mac's name, for the plain refusal a device without account management sees (U7 accounts.manage).
interface Deps {
  root: () => string;
  configRoles: () => unknown;
  configModes?: () => unknown;
  keychain?: ReturnType<typeof createKeychain>;
  login?: typeof codexLogin;
  now?: () => number;
  takeOver?: TakeOver | null;
  host?: () => string;
}
interface Reply {
  ok: boolean;
  message: string | null;
}
type Audit = Parameters<typeof recordAccountAction>[0];
const ok = (message: string | null = null) => ({ ok: true, message });
const refused = (message: string) => ({ ok: false, message: message.slice(0, 300) });
// A failure a person can act on; never the underlying error text (it could carry a path).
const plain = (e: unknown, fallback: string) => {
  const m = e instanceof Error ? e.message : "";
  return /^(Name the account|An account with that name exists|Account limit reached|No such account|Priority is 1 to 99|Unknown (policy|role|provider|mode)|That does not look like a token from `claude setup-token`|The account store is busy|No such (Claude|Codex) account|That looks like a token, not a name|It is already (first|last))/.test(
    m,
  )
    ? m
    : fallback;
};

// The session's provider as the host knows it; the pool's own record when the host cannot say.
async function providerOf(paseo: Paseo, root: string, agentId: string): Promise<string | null> {
  try {
    const h = paseo?.agents?.ref?.(agentId);
    if (h?.refresh) await h.refresh();
    const p = h?.current?.()?.provider;
    if (typeof p === "string") return p;
  } catch {}
  return readAccounts(root).assignments[agentId]?.provider ?? null;
}

// The controller takeover adapter lives beside switchSession (accounts.mjs), so the controller's tests reach it too.
export { controllerTakeOver };

async function catalog(paseo: Paseo, provider: "claude" | "codex") {
  try {
    const list = await paseo?.providers?.listModels?.(provider);
    if (!list || list.error || !Array.isArray(list.models)) return null;
    return list.models
      .filter(
        (m: any) =>
          m?.provider === provider && m.isSelectable !== false && typeof m.id === "string",
      )
      .slice(0, 60)
      .map((m: any) => ({
        id: `${provider}/${m.id}`,
        label: String(m.label ?? m.name ?? m.id).slice(0, 80),
        efforts: (m.thinkingOptions ?? [])
          .map((o: any) => o?.id)
          .filter((x: unknown) => typeof x === "string")
          .slice(0, 12),
      }));
  } catch {
    return null;
  }
}

export function createAccountHandlers(d: Deps) {
  const keychain = d.keychain ?? createKeychain(),
    login = d.login ?? codexLogin,
    now = d.now ?? Date.now;
  const signIn = (id: string) => {
    // One browser sign-in on this Mac; the account reads "signing in" until it completes.
    void setAccount(d.root(), id, { auth: "signing-in" })
      .then(() => login(d.root(), id))
      .then(
        () => setAccount(d.root(), id, { auth: "ok" }),
        () => setAccount(d.root(), id, { auth: "expired" }),
      )
      .catch(() => {});
  };
  // U7 accounts.manage: every account RPC needs the host's account-management flag for this invocation (the owner, or a
  // device the owner granted it; never the read tier). A remote action is audited for the owner once it has happened;
  // the audit gets the action and the account's label only, and the host adds the device and the time.
  const ask = () => askOwner(d.host?.());
  const gate = async (
    run: () => Promise<{ reply: Reply; audit?: Audit | null }>,
  ): Promise<Reply> => {
    const authority = accountAuthority();
    if (!authority.allowed) return refused(ask());
    const { reply, audit } = await run();
    if (!reply.ok || !audit || !authority.remote) return reply;
    try {
      await recordAccountAction(audit);
      return reply;
    } catch {
      return {
        ok: true,
        message: `${reply.message ?? "Done."} The owner\u2019s audit could not record it.`.slice(
          0,
          300,
        ),
      };
    }
  };
  const readable = () => {
    if (!accountAuthority().allowed) throw new Error(ask());
  };
  const nameOf = (id: string | null | undefined) =>
    readAccounts(d.root()).accounts.find((x) => x.id === id)?.name ?? null;
  const handlers = {
    async read(paseo: Paseo): Promise<AccountsView> {
      const v = publicView(readAccounts(d.root()), now());
      const t = readRoleDefaults(
        d.root(),
        d.configRoles() as any,
        (d.configModes?.() ?? null) as any,
      );
      const [claude, codex] = await Promise.all([
        catalog(paseo, "claude"),
        catalog(paseo, "codex"),
      ]);
      const modeChoices = { claude: [...MODE_CHOICES.claude], codex: [...MODE_CHOICES.codex] };
      return {
        ...v,
        defaults: {
          roles: t.roles,
          orchestrationGuard: t.orchestrationGuard,
          modes: t.modes,
          modeChoices,
        },
        catalog: { claude, codex },
      };
    },
    async add(input: { provider: "claude" | "codex"; name: string; token?: string }) {
      if (input.provider === "claude" && !input.token)
        return refused("Paste the token `claude setup-token` printed for this account");
      if (input.provider === "codex" && input.token)
        return refused("A Codex account signs in in the browser; no token is pasted");
      let account: any;
      try {
        account = await addAccount(d.root(), { provider: input.provider, name: input.name }, now());
      } catch (e) {
        return refused(plain(e, "The account could not be added"));
      }
      if (input.provider === "claude") {
        try {
          await keychain.put(account.id, input.token!.trim());
        } catch (e) {
          await removeAccount(d.root(), account.id).catch(() => {});
          return refused(plain(e, "The token could not be kept in the Keychain"));
        }
        return ok("Added. New Claude sessions can use it now.");
      }
      signIn(account.id);
      return ok(
        "A browser sign-in opened on the Mac that runs this host. The account is ready when it finishes.",
      );
    },
    async update(input: {
      id: string;
      name?: string;
      enabled?: boolean;
      priority?: number;
      clearLimit?: true;
      token?: string;
      signIn?: true;
      remove?: true;
      move?: "up" | "down";
    }) {
      const a = readAccounts(d.root()).accounts.find((x) => x.id === input.id);
      if (!a) return refused("No such account");
      try {
        if (input.move) {
          await moveAccount(d.root(), a.id, input.move);
          return ok();
        }
        if (input.remove) {
          if (a.provider === "claude") await keychain.remove(a.id);
          else fs.rmSync(codexHome(d.root(), a.id), { recursive: true, force: true });
          await removeAccount(d.root(), a.id);
          return ok("Removed. Sessions using it move to another account at their next launch.");
        }
        if (input.token !== undefined) {
          if (a.provider !== "claude") return refused("A Codex account signs in in the browser");
          await keychain.put(a.id, input.token.trim());
          await setAccount(d.root(), a.id, { auth: "ok" });
        }
        if (input.signIn) {
          if (a.provider !== "codex") return refused("Replace a Claude account's token instead");
          signIn(a.id);
        }
        const patch: Record<string, unknown> = {};
        for (const k of ["name", "enabled", "priority", "clearLimit"] as const)
          if (input[k] !== undefined) patch[k] = input[k];
        if (Object.keys(patch).length) await setAccount(d.root(), a.id, patch);
        return ok(input.signIn ? "A browser sign-in opened on the Mac that runs this host." : null);
      } catch (e) {
        return refused(plain(e, "The account could not be changed"));
      }
    },
    async session(input: { agentId: string }, paseo: Paseo): Promise<SessionAccountsView> {
      readable();
      const provider = await providerOf(paseo, d.root(), input.agentId);
      if (!provider || !(PROVIDERS as readonly string[]).includes(provider))
        return { provider: null, current: null, accounts: [] };
      return sessionAccounts(
        readAccounts(d.root()),
        input.agentId,
        provider,
        now(),
      ) as SessionAccountsView;
    },
    async switch(
      input: { agentId: string; account: string },
      paseo: Paseo,
      operation: "switch" | "takeover" = "switch",
    ): Promise<Reply> {
      const provider = await providerOf(paseo, d.root(), input.agentId);
      if (!provider) return refused("That session could not be found");
      try {
        if (!accountAuthority().allowed) return refused(ask());
        if (operation === "takeover" && !d.takeOver)
          return refused("Account continuation is unavailable on this host");
        const r = await switchSession(
          d.root(),
          { sessionId: input.agentId, provider, account: input.account },
          { takeOver: d.takeOver ?? null },
          now(),
        );
        const s = readAccounts(d.root()),
          want = input.account.trim().toLowerCase();
        const to = s.accounts.find(
          (x) =>
            x.provider === provider && (x.id === input.account || x.name.toLowerCase() === want),
        );
        return {
          reply: { ok: r.ok, message: r.message },
          audit: r.moved && to ? { action: operation, accountLabel: to.name } : null,
        } as any;
      } catch (e) {
        return refused(plain(e, "The account could not be switched"));
      }
    },
    async settings(
      input: {
        policy?: "priority" | "spread";
        role?: string;
        defaults?: any;
        orchestrationGuard?: boolean;
        defaultAccount?: { provider: "claude" | "codex"; id: string | null };
        mode?: { provider: "claude" | "codex"; modeId: string };
      },
      paseo?: Paseo,
      readOnly = false,
    ) {
      // D13 / B3: this write goes to Fulcra's own files, not through management, so it refuses a read-only invocation itself.
      if (readOnly)
        return refused(
          "This device is read-only. Change defaults from the Mac that runs this host.",
        );
      try {
        // Update-7 W3: a model this host's provider does not list is refused plainly and nothing is saved. With no list
        // (provider unavailable) the choice is kept: every create path checks it again at launch and falls back.
        if (input.role && input.defaults) {
          for (const p of ["claude", "codex"] as const) {
            const model = input.defaults?.[p]?.model;
            if (typeof model !== "string" || !model) continue;
            const listed = await catalog(paseo, p);
            const entry = listed?.find((m: { id: string }) => m.id === model);
            if (listed && !entry)
              return refused(
                `${p === "claude" ? "Claude" : "Codex"} does not list ${model.slice(model.indexOf("/") + 1)} on this host. Pick one of its listed models.`,
              );
            // W3-3: and an effort that model does not offer here, so Settings never shows a value that cannot apply.
            const effort = input.defaults?.[p]?.thinkingOptionId;
            if (
              entry &&
              typeof effort === "string" &&
              effort &&
              entry.efforts.length &&
              !entry.efforts.includes(effort)
            )
              return refused(
                `${entry.label} does not offer ${effort} effort on this host. Pick one of: ${entry.efforts.join(", ")}.`,
              );
          }
        }
        if (input.mode)
          await writeRoleDefaults(d.root(), { mode: input.mode }, d.configRoles() as any);
        if (input.policy) await setPolicy(d.root(), input.policy);
        if (input.rotateOnLimit !== undefined)
          await setRotateOnLimit(d.root(), input.rotateOnLimit);
        if (input.defaultAccount)
          await setDefaultAccount(d.root(), input.defaultAccount.provider, input.defaultAccount.id);
        if (input.role || input.orchestrationGuard !== undefined)
          await writeRoleDefaults(
            d.root(),
            {
              role: input.role,
              defaults: input.defaults,
              orchestrationGuard: input.orchestrationGuard,
            },
            d.configRoles() as any,
          );
        const label = input.defaultAccount
          ? (nameOf(input.defaultAccount.id) ?? "First ready account")
          : input.mode
            ? `Permission mode for ${input.mode.provider === "claude" ? "Claude" : "Codex"}`
            : input.rotateOnLimit !== undefined
              ? input.rotateOnLimit
                ? "Continue on another account"
                : "Wait for its reset"
              : input.policy
                ? input.policy === "spread"
                  ? "Spread evenly"
                  : "In order"
                : input.role
                  ? `Defaults for ${input.role}`
                  : "Leads use sessions only";
        return {
          reply: ok(),
          audit: {
            action: input.defaultAccount ? "set-default" : "pool-settings",
            accountLabel: label,
          },
        } as any;
      } catch (e) {
        return refused(plain(e, "The settings could not be saved"));
      }
    },
  };
  // The account writes return { reply, audit } internally; add and update are mapped here.
  const add = handlers.add,
    update = handlers.update,
    switchTo = handlers.switch as any,
    settings = handlers.settings as any;
  return {
    ...handlers,
    async read(paseo: Paseo) {
      readable();
      return handlers.read(paseo);
    },
    add: (input: Parameters<typeof add>[0]) =>
      gate(async () => {
        const reply = await add(input);
        return { reply, audit: { action: "add", accountLabel: input.name.trim() } };
      }),
    update: (input: Parameters<typeof update>[0]) =>
      gate(async () => {
        const before = nameOf(input.id),
          reply = await update(input);
        return {
          reply,
          audit: before
            ? {
                action: input.remove ? "remove" : "update",
                accountLabel: input.remove ? before : input.name?.trim() || before,
              }
            : null,
        };
      }),
    switch: (input: { agentId: string; account: string }, paseo: Paseo) =>
      gate(async () => {
        const r = await switchTo(input, paseo);
        return "reply" in r ? r : { reply: r };
      }),
    takeover: (input: { agentId: string; account: string }, paseo: Paseo) =>
      gate(async () => {
        const r = await switchTo(input, paseo, "takeover");
        return "reply" in r ? r : { reply: r };
      }),
    settings: (input: Parameters<typeof handlers.settings>[0], paseo?: Paseo, readOnly = false) =>
      gate(async () => {
        const r = await settings(input, paseo, readOnly);
        return "reply" in r ? r : { reply: r };
      }),
  };
}
