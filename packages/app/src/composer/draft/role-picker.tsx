import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import type { SessionRole } from "@getpaseo/protocol/session-roles";
import { describeRoleDefault } from "@/provider-selection/role-defaults";
import type { DraftRole } from "./use-draft-role";

interface RolePickerProps {
  role: DraftRole;
  /** To name the role's model and effort in the provider they are for. */
  modelsByProvider: Map<string, AgentModelDefinition[]>;
  currentProvider: string | null;
  disabled: boolean;
}

/**
 * What the new session is for. Renders nothing when the host serves no role defaults;
 * choosing a role pre-fills its model and effort, which the model and effort controls
 * still override.
 */
export function RolePicker({ role, modelsByProvider, currentProvider, disabled }: RolePickerProps) {
  const { t } = useTranslation();
  if (role.choices.length === 0) return null;
  const provider = role.values?.provider ?? currentProvider;
  const description = describeRoleDefault({
    values: role.values,
    models: provider ? modelsByProvider.get(provider) : undefined,
  });
  const choices: Array<SessionRole | null> = [null, ...role.choices];
  return (
    <View style={styles.container} testID="new-session-role-picker">
      <View style={styles.row} accessibilityRole="radiogroup">
        <Text style={styles.label}>{t("workspaceSetup.role.label")}</Text>
        {choices.map((choice) => (
          <RoleChoice
            key={choice ?? "none"}
            role={choice}
            active={choice === role.selected}
            disabled={disabled}
            onSelect={role.select}
          />
        ))}
      </View>
      {role.selected && description ? (
        <Text style={styles.description} testID="new-session-role-description">
          {description.effort
            ? t("workspaceSetup.role.usesDefault", {
                role: t(`workspaceSetup.role.${role.selected}`),
                model: description.model,
                effort: description.effort,
              })
            : t("workspaceSetup.role.usesDefaultModel", {
                role: t(`workspaceSetup.role.${role.selected}`),
                model: description.model,
              })}
        </Text>
      ) : null}
    </View>
  );
}

function RoleChoice(props: {
  role: SessionRole | null;
  active: boolean;
  disabled: boolean;
  onSelect: (role: SessionRole | null) => void;
}) {
  const { t } = useTranslation();
  const { role, active, disabled, onSelect } = props;
  const press = useCallback(() => onSelect(role), [onSelect, role]);
  return (
    <Pressable
      testID={`new-session-role-${role ?? "none"}`}
      accessibilityRole="radio"
      accessibilityState={active ? CHECKED : UNCHECKED}
      disabled={disabled}
      onPress={press}
      style={active ? styles.choiceActive : styles.choice}
    >
      <Text style={active ? styles.choiceTextActive : styles.choiceText}>
        {role ? t(`workspaceSetup.role.${role}`) : t("workspaceSetup.role.none")}
      </Text>
    </Pressable>
  );
}

const CHECKED = { checked: true };
const UNCHECKED = { checked: false };

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
  },
  choice: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  choiceActive: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
  },
  choiceText: {
    color: theme.colors.foregroundMuted,
  },
  choiceTextActive: {
    color: theme.colors.foreground,
  },
  description: {
    color: theme.colors.foregroundMuted,
  },
}));
