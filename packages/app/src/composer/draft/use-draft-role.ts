import { useCallback } from "react";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { SessionRole } from "@getpaseo/protocol/session-roles";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import type { FormInitialValues } from "@/provider-selection/resolve-agent-form";
import {
  availableRoles,
  roleInitialValues,
  selectedDraftRole,
} from "@/provider-selection/role-defaults";
import { useSessionRoleDefaults } from "@/provider-selection/use-session-role-defaults";

export interface DraftRole {
  /** Roles the host has defaults for; empty hides the picker. */
  choices: SessionRole[];
  selected: SessionRole | null;
  /** The role's model / effort (and provider, when it names one) as form initial values. */
  values: FormInitialValues | undefined;
  select: (role: SessionRole | null) => void;
}

/**
 * What the new session is for, remembered across sessions. A remembered role the host no
 * longer serves reads as no role, so a host without role defaults is exactly as before.
 */
export function useDraftRole(serverId: string, setupProvider: AgentProvider | null): DraftRole {
  const table = useSessionRoleDefaults(serverId);
  const { preferences, updatePreferences } = useFormPreferences();
  const choices = availableRoles(table);
  const selected = selectedDraftRole(preferences, choices);
  const values = roleInitialValues({
    role: selected,
    table,
    provider: setupProvider ?? (preferences.provider as AgentProvider | undefined) ?? null,
  });
  const select = useCallback(
    (role: SessionRole | null) => {
      void updatePreferences({ role: role ?? undefined, roleChosen: true });
    },
    [updatePreferences],
  );
  return { choices, selected, values, select };
}
