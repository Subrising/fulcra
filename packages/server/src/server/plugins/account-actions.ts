import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writePrivateFileAtomicSync } from "../private-files.js";

// U7: the owner's audit of account actions made from paired devices (switch, set the default, take over, ...).
// Each record is the device, the action, the account's display label and the time: never a credential. The plugin
// supplies only the action and the label; the host adds the device (from the management invocation) and the time.

export const ACCOUNT_ACTIONS = [
  "switch",
  "set-default",
  "takeover",
  "add",
  "remove",
  "update",
  "pool-settings",
] as const;
export type AccountActionKind = (typeof ACCOUNT_ACTIONS)[number];

// Anything that looks like a credential or a credential file is refused, so a label can never carry one to the
// owner's screen or to another device.
const CREDENTIAL_SHAPED =
  /sk-ant-|\bsk-[A-Za-z0-9_-]{16,}|\bgh[opsu]_|github_pat_|\bxox[abp]-|\beyJ[A-Za-z0-9_-]{8,}\.|auth\.json|access_token|refresh_token|[A-Za-z0-9+/_-]{40,}/i;

export const AccountActionInputSchema = z
  .object({
    action: z.enum(ACCOUNT_ACTIONS),
    accountLabel: z
      .string()
      .trim()
      .min(1)
      .max(80)
      // Printable text only: no control characters.
      .regex(/^[^\p{Cc}]+$/u)
      .refine((label) => !CREDENTIAL_SHAPED.test(label)),
  })
  .strict();

export interface AccountActionRecord {
  at: string;
  deviceId: string;
  action: AccountActionKind;
  accountLabel: string;
}

export interface AccountActionSink {
  record(entry: AccountActionRecord): void;
}

const RecordSchema = z
  .object({
    at: z.string().datetime(),
    deviceId: z.string().regex(/^dev_[A-Za-z0-9_-]{16}$/),
    action: z.enum(ACCOUNT_ACTIONS),
    accountLabel: z.string().min(1).max(80),
  })
  .strict();
const FileSchema = z.object({ v: z.literal(1), entries: z.array(RecordSchema).max(200) }).strict();
const MAX_ENTRIES = 200;

/** `<PASEO_HOME>/accounts-audit.json`, private to the owner, newest last, the latest 200 kept. */
export class AccountActionsAudit implements AccountActionSink {
  private readonly file: string;
  constructor(home: string) {
    this.file = path.join(home, "accounts-audit.json");
  }
  record(entry: AccountActionRecord): void {
    const parsed = RecordSchema.parse(entry);
    const entries = [...this.read(), parsed].slice(-MAX_ENTRIES);
    writePrivateFileAtomicSync(this.file, `${JSON.stringify({ v: 1, entries }, null, 2)}\n`);
  }
  /** Newest first. An unreadable file lists nothing rather than failing the owner's screen. */
  list(): AccountActionRecord[] {
    return this.read().toReversed();
  }
  private read(): AccountActionRecord[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
    const parsed = FileSchema.safeParse(raw);
    return parsed.success ? parsed.data.entries : [];
  }
}
