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
  status: z.object({ state: z.string() }),
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

const schema: OutputSchema<Account> = {
  idField: "id",
  columns: [
    { header: "ACCOUNT", field: "name" },
    { header: "PROVIDER", field: (row) => row.provider ?? "" },
    { header: "STATUS", field: (row) => row.status.state },
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
