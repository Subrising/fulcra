export const SESSION_ACCOUNT_LABEL = "fulcra.account-name";

export interface SessionAccount {
  providerLabel: string;
  name: string | null;
}

/** Only the live daemon projection identifies the attached account. Saved assignments are not ownership. */
export function sessionAccount(input: {
  provider: string;
  labels?: Readonly<Record<string, string>> | null;
}): SessionAccount | null {
  if (input.provider !== "claude" && input.provider !== "codex") return null;
  const name = input.labels?.[SESSION_ACCOUNT_LABEL]?.trim() || null;
  return { providerLabel: input.provider === "claude" ? "Claude" : "Codex", name };
}

export function sessionAccountText(account: SessionAccount): string {
  return account.name ? `Account: ${account.name}` : "Account unknown";
}

export function sessionAccountDescription(provider: string, name: string | null): string {
  const account = sessionAccount({
    provider,
    labels: name ? { [SESSION_ACCOUNT_LABEL]: name } : undefined,
  });
  return account?.name ? ` · ${sessionAccountText(account)}` : "";
}

export function runtimeAccountName(
  agent: { labels?: Readonly<Record<string, string>> } | null,
): string | null {
  return agent?.labels?.[SESSION_ACCOUNT_LABEL] ?? null;
}
