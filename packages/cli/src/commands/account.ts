import { Command } from "commander";
import { z } from "zod";
import { connectToDaemon } from "../utils/client.js";
import { addJsonAndDaemonHostOptions } from "../utils/command-options.js";
import { withOutput, type CommandOptions, type OutputSchema } from "../output/index.js";
import { controllerPluginIdFromTrustedReports } from "@getpaseo/protocol/bundled-controller";

const account = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string().optional(),
  status: z.object({
    state: z.string(),
    until: z.string().optional(),
    reason: z.string().optional(),
  }),
  isDefault: z.boolean().optional(),
});
const listing = z.object({ accounts: z.array(account) });
const reply = z.object({ ok: z.boolean(), message: z.string().nullable() });
type Account = z.infer<typeof account>;
export interface AccountClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  fetchAgent(options: { agentId: string }): Promise<{ agent: { id: string } } | null>;
  getPluginCatalog?(): Promise<{
    trustedPlugins?: readonly { id: string; contract?: "1.1"; hooks: readonly string[] }[];
  }>;
}

/** The host's configured bundled controller; the legacy ID when the catalog can't say. */
async function controllerId(client: AccountClient): Promise<string> {
  const catalog = await client.getPluginCatalog?.().catch(() => undefined);
  return controllerPluginIdFromTrustedReports(catalog?.trustedPlugins);
}
interface AccountOptions extends CommandOptions {
  agent?: string;
}

export async function listAccounts(client: AccountClient, agentId?: string): Promise<Account[]> {
  if (!agentId) {
    const plugin = await controllerId(client);
    return listing.parse(await client.invokePluginRpc(plugin, "organization.accounts", {}))
      .accounts;
  }
  const id = await resolveAgent(client, agentId);
  const result = await client.invokePluginRpc(
    await controllerId(client),
    "organization.accounts.session",
    {
      agentId: id,
    },
  );
  return listing.parse(result).accounts;
}

async function resolveAgent(client: AccountClient, agentId: string): Promise<string> {
  const result = await client.fetchAgent({ agentId });
  if (!result) throw new Error(`Session not found: ${agentId}`);
  return result.agent.id;
}

export async function switchAccountSession(
  client: AccountClient,
  agentId: string,
  name: string,
): Promise<string> {
  const accountName = name.trim();
  if (!accountName || accountName.length > 80)
    throw new Error("Name an account (1 to 80 characters).");
  const id = await resolveAgent(client, agentId);
  const result = reply.parse(
    await client.invokePluginRpc(await controllerId(client), "organization.accounts.switch", {
      agentId: id,
      account: accountName,
    }),
  );
  if (!result.ok) throw new Error(result.message ?? "The account could not be switched.");
  return result.message ?? "Switched account.";
}

/** The environment name the host's account hook reads to pin a launch to one pooled account (FU-59). */
export const ACCOUNT_REQUEST_ENV = "FULCRA_ACCOUNT_REQUEST";

/**
 * Checks a named account for `fulcra run --account`: it must exist for the provider and be usable now. Returns the
 * account's name, which the host's launch hook pins the new session to. Errors name the account and the reason.
 */
export async function resolveRunAccount(
  client: AccountClient,
  name: string,
  provider: string,
): Promise<string> {
  const wanted = name.trim().toLowerCase();
  if (!wanted) throw { code: "INVALID_ACCOUNT", message: "--account needs an account name" };
  const found = (await listAccounts(client)).find(
    (a) =>
      (a.provider === undefined || a.provider === provider) &&
      (a.name.toLowerCase() === wanted || a.id.toLowerCase() === wanted),
  );
  if (!found)
    throw {
      code: "ACCOUNT_NOT_FOUND",
      message: `No ${provider} account is named "${name.trim()}"`,
    };
  if (found.status.state !== "ok") {
    const until = (found.status as { until?: string }).until;
    const reason = (found.status as { reason?: string }).reason;
    throw {
      code: found.status.state === "limited" ? "ACCOUNT_LIMITED" : "ACCOUNT_UNAVAILABLE",
      message: `Account "${found.name}" cannot be used now (${found.status.state}${until ? ` until ${until}` : ""}${reason ? `: ${reason}` : ""})`,
    };
  }
  return found.name;
}

export function statusReason(status: { state: string; until?: string; reason?: string }): string {
  if (status.state === "revoked") return status.reason || "token revoked or invalid";
  if (status.state === "limited") return `limit until ${status.until ?? "unknown"}`;
  return "";
}

const schema: OutputSchema<Account> = {
  idField: "id",
  columns: [
    { header: "ACCOUNT", field: "name" },
    { header: "PROVIDER", field: (row) => row.provider ?? "" },
    { header: "STATUS", field: (row) => row.status.state },
    // Why an account is down: the CLI's own line for a revoked token, or the reset time of a usage limit.
    { header: "REASON", field: (row) => statusReason(row.status) },
  ],
};

export function createAccountCommand(): Command {
  const cmd = new Command("account").description(
    "List pooled accounts or switch one session with its history",
  );
  addJsonAndDaemonHostOptions(
    cmd.command("ls").alias("list").option("--agent <id>", "List accounts for this session"),
  ).action(
    withOutput<Account, []>(async (options: AccountOptions, _command: Command) => {
      const client = await connectToDaemon({ target: options.daemonTarget });
      try {
        return { type: "list" as const, data: await listAccounts(client, options.agent), schema };
      } finally {
        await client.close().catch(() => {});
      }
    }),
  );
  addJsonAndDaemonHostOptions(
    cmd
      .command("use")
      .argument("<name>", "Account name or ID")
      .requiredOption("--agent <id>", "Session to continue on this account"),
  ).action(
    withOutput(async (name: string, options: AccountOptions, _command: Command) => {
      const client = await connectToDaemon({ target: options.daemonTarget });
      try {
        const message = await switchAccountSession(client, options.agent!, name);
        return {
          type: "single" as const,
          data: { agentId: options.agent!, message },
          schema: {
            idField: "agentId" as const,
            columns: [
              { header: "SESSION", field: "agentId" as const },
              { header: "RESULT", field: "message" as const },
            ],
          },
        };
      } finally {
        await client.close().catch(() => {});
      }
    }),
  );
  return cmd;
}
