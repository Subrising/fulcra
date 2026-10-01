/**
 * What a new session is for, and the defaults the organization plugin serves for it.
 *
 * A creation says its role with one label, SESSION_ROLE_LABEL. The organization plugin's
 * agent.create hook reads it and fills a model / effort the creation did not set; the
 * new-session form reads the same table (SESSION_DEFAULTS_RPC) to show and pre-fill them.
 * No label is exactly the behaviour before roles existed.
 *
 * CROSS-TREE CONTRACT: the plugin states these same literals in its
 * shared/session-defaults.ts and asserts them in its tests; neither tree can import the
 * other. Kebab-case for the method, as for SESSION_OWNERSHIP_RPC.
 */
export const SESSION_ROLE_LABEL = "fulcra.role";
export const SESSION_DEFAULTS_RPC = "organization.session-defaults";

export const SESSION_ROLES = ["planning", "orchestration", "implementation"] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export function isSessionRole(value: unknown): value is SessionRole {
  return typeof value === "string" && (SESSION_ROLES as readonly string[]).includes(value);
}

/** Bare model ids, as the provider's model catalog names them. */
export interface SessionRoleSelection {
  model: string | null;
  thinkingOptionId: string | null;
}

/**
 * `effective` is what a creation would launch here after the installed provider's check;
 * `unknown` means the check could not run, and `configured` is all that is known.
 */
export interface SessionRoleProviderDefaults {
  status: "offered" | "falls-back" | "unknown";
  configured: SessionRoleSelection;
  effective: SessionRoleSelection | null;
}

export interface SessionRoleDefaults {
  provider: string | null;
  providers: Partial<Record<string, SessionRoleProviderDefaults>>;
}

export interface SessionDefaultsResponse {
  roles: Partial<Record<SessionRole, SessionRoleDefaults>>;
  /**
   * Update-7 W3: the host's default permission mode per provider for a new session (Fulcra Settings). Optional: an
   * older plugin sends none, and the form then uses the provider's own default.
   */
  modes?: Partial<Record<string, string>>;
}
