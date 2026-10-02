export function askOwner(host?: string | null): string;
export function accountAuthority(management?: unknown): { allowed: boolean; remote: boolean };
export function recordAccountAction(
  entry: {
    action: "switch" | "set-default" | "takeover" | "add" | "remove" | "update" | "pool-settings";
    accountLabel: string;
  },
  management?: unknown,
): Promise<{ recorded: boolean }>;
