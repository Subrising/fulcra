import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writePrivateFileAtomicSync } from "../private-files.js";

// Account metadata for the shared credential store (CONTRACTS §7.2). This file never holds a secret:
// tokens live in the OS credential store under the account id.
export const ConnectorIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);

export const CredentialAccountSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    connector: ConnectorIdSchema,
    site: z.string().max(253).nullable(),
    displayName: z.string().min(1).max(80),
    method: z.enum(["browser", "device", "token", "cli"]),
    scopes: z.array(z.string().max(60)).max(12),
    state: z.enum(["connected", "expired", "needs-reconnect", "revoked"]),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    lastCheckedAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type CredentialAccount = z.infer<typeof CredentialAccountSchema>;

const AccountsFileSchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(CredentialAccountSchema),
    // One-time imports already done, as "<pluginId>/<secretName>" → account id.
    imports: z.record(z.string(), z.string().uuid()),
  })
  .strict();

type AccountsFile = z.infer<typeof AccountsFileSchema>;

export interface AccountsStore {
  list(): Promise<CredentialAccount[]>;
  get(id: string): Promise<CredentialAccount | null>;
  put(account: CredentialAccount): Promise<void>;
  remove(id: string): Promise<boolean>;
  findImport(key: string): Promise<string | null>;
  recordImport(key: string, accountId: string): Promise<void>;
}

function emptyFile(): AccountsFile {
  return { version: 1, accounts: [], imports: {} };
}

export function createFileAccountsStore(filePath: string): AccountsStore {
  // Writes are serialized so two sign-ins finishing together cannot lose one another.
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<AccountsFile> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      throw error;
    }
    return AccountsFileSchema.parse(JSON.parse(raw));
  }

  function mutate<T>(change: (file: AccountsFile) => T): Promise<T> {
    const next = queue.then(async () => {
      const file = await load();
      const result = change(file);
      writePrivateFileAtomicSync(
        filePath,
        `${JSON.stringify(AccountsFileSchema.parse(file), null, 2)}\n`,
      );
      return result;
    });
    queue = next.catch(() => undefined);
    return next;
  }

  return createStore({ load, mutate });
}

export function createMemoryAccountsStore(): AccountsStore {
  let file = emptyFile();
  return createStore({
    load: async () => structuredClone(file),
    mutate: async (change) => {
      const copy = structuredClone(file);
      const result = change(copy);
      file = AccountsFileSchema.parse(copy);
      return result;
    },
  });
}

function createStore(io: {
  load(): Promise<AccountsFile>;
  mutate<T>(change: (file: AccountsFile) => T): Promise<T>;
}): AccountsStore {
  return {
    async list() {
      return (await io.load()).accounts;
    },
    async get(id) {
      return (await io.load()).accounts.find((account) => account.id === id) ?? null;
    },
    put(account) {
      const parsed = CredentialAccountSchema.parse(account);
      return io.mutate((file) => {
        const index = file.accounts.findIndex((existing) => existing.id === parsed.id);
        if (index === -1) file.accounts.push(parsed);
        else file.accounts[index] = parsed;
      });
    },
    remove(id) {
      return io.mutate((file) => {
        const before = file.accounts.length;
        file.accounts = file.accounts.filter((account) => account.id !== id);
        // Import records outlive the account: disconnecting an imported account must not let the
        // old plugin secret be imported again.
        return file.accounts.length !== before;
      });
    },
    async findImport(key) {
      return (await io.load()).imports[key] ?? null;
    },
    recordImport(key, accountId) {
      return io.mutate((file) => {
        file.imports[key] = accountId;
      });
    },
  };
}
