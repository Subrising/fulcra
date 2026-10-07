import { useCallback, useMemo } from "react";
import { Pressable, Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { useMenuContext } from "@/components/ui/menu";
import { useSessionStore } from "@/stores/session-store";
import { sessionAccount, sessionAccountText, type SessionAccount } from "./session-account";

// Use the shared menu engine with a row-safe trigger: opening information must not navigate the row.
function SessionInfoTrigger({ account, testID }: { account: SessionAccount; testID?: string }) {
  const { triggerRef, open, setOpen } = useMenuContext("SessionInfoTrigger");
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  const onPress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      setOpen(!open);
    },
    [open, setOpen],
  );
  return (
    <Pressable
      ref={triggerRef}
      collapsable={false}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={`Session info, ${account.providerLabel}, ${sessionAccountText(account)}`}
      testID={testID}
      style={styles.trigger}
    >
      <Text numberOfLines={1} style={styles.label}>
        {sessionAccountText(account)}
      </Text>
    </Pressable>
  );
}

/** Shared row/header information. The account name comes from the live projection, including switches. Shows
 * nothing until the host names the account: an unnamed account is not news, and "unknown" on every idle row is noise. */
export function SessionAccountInfo({
  account,
  testID,
}: {
  account: SessionAccount | null;
  testID?: string;
}) {
  if (!account?.name) return null;
  return (
    <DropdownMenu>
      <SessionInfoTrigger account={account} testID={testID} />
      <DropdownMenuContent side="bottom" align="start" width={260} sheetTitle="Session info">
        <View style={styles.info} testID={testID ? `${testID}-info` : undefined}>
          <Text style={styles.title}>Session info</Text>
          <Text style={styles.label}>Provider: {account.providerLabel}</Text>
          <Text style={styles.label}>{sessionAccountText(account)}</Text>
          <Text style={styles.detail}>Current runtime account on this host</Text>
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CurrentSessionAccountInfo({
  serverId,
  agentId,
  header = true,
}: {
  serverId: string;
  agentId: string | undefined;
  header?: boolean;
}) {
  const provider = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return agentId
      ? (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId))?.provider
      : undefined;
  });
  const name = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return agentId
      ? (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId))?.labels?.[
          "fulcra.account-name"
        ]
      : undefined;
  });
  if (!provider) return null;
  return (
    <View style={header ? styles.header : undefined}>
      <SessionAccountInfo
        account={sessionAccount({
          provider,
          labels: name ? { "fulcra.account-name": name } : undefined,
        })}
        testID={`session-account-${agentId}`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: { maxWidth: "100%", paddingVertical: theme.spacing[1] },
  header: {
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  label: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  title: { fontSize: theme.fontSize.sm, fontWeight: "600", color: theme.colors.foreground },
  detail: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  info: { gap: theme.spacing[2], padding: theme.spacing[3] },
}));
