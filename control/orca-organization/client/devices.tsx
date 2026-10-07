import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { devicesRpc, protectionText } from "../shared/cc/devices";

/**
 * Settings › Devices (CONTRACTS v1.6 §3.6, prime decision S-1). The devices that can prove an answer is the owner's.
 *
 * Pairing and revoking are signed on a paired device, whose key and Touch ID / Face ID prompt come from the app
 * (J5b, `ctx.device`). This build has no such API yet, so the list is read-only and says so plainly: until a device
 * is paired, answers from this app are recorded as the operator's, and approvals that start work cannot be answered.
 */
const DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
export function DevicesSurface({ theme, layout }: Pick<PluginSurfaceProps, "theme" | "layout">) {
  const read = useContract(devicesRpc),
    c = theme.colors;
  const query = useQuery({
    queryKey: ["orca-organization", "devices"],
    queryFn: () => read({}),
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const d = query.data,
    devices = d?.devices ?? [],
    active = devices.filter((x) => x.state === "active");
  const box = (children: ReactNode, key?: string) => (
    <View
      key={key}
      style={{
        gap: 6,
        padding: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
      }}
    >
      {children}
    </View>
  );
  return (
    <ScrollView
      testID="devices-list"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 12 : 24,
        gap: 16,
        maxWidth: 760,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <View style={{ gap: 4 }}>
        <Text
          accessibilityRole="header"
          style={{ color: c.foreground, fontSize: 26, fontWeight: "700" }}
        >
          Devices
        </Text>
        <Text style={{ color: c.foregroundMuted }}>
          The phones and computers that can confirm an answer is really yours.
        </Text>
      </View>
      {d?.stale && <Text style={{ color: c.statusWarning }}>May be out of date. {d.error}</Text>}
      {box(
        <>
          <Text style={{ color: c.foreground, fontWeight: "700", fontSize: 16 }}>
            {active.length
              ? `${active.length} device${active.length === 1 ? "" : "s"} paired`
              : "No devices paired"}
          </Text>
          <Text style={{ color: c.foreground }}>
            {active.length
              ? "Answers you confirm on a paired device count as yours. Anything answered without one is marked as answered by the operator."
              : "Device pairing isn't available in this version of Fulcra yet. Until it is, answers from this app are marked as answered by the operator, and approvals that start work wait for a paired device."}
          </Text>
        </>,
        "status",
      )}
      {!d && (
        <Text style={{ color: c.foregroundMuted }}>
          {query.isPending ? "Checking your devices…" : "Your devices could not be read."}
        </Text>
      )}
      {devices.map((x) =>
        box(
          <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <Text style={{ color: c.foreground, fontWeight: "700", fontSize: 16 }}>
                {x.label}
              </Text>
              <Text
                style={{
                  color: x.state === "active" ? c.statusSuccess : c.statusDanger,
                  fontSize: 12,
                  fontWeight: "700",
                }}
              >
                {x.state === "active" ? "Paired" : "Revoked"}
              </Text>
            </View>
            <Text style={{ color: c.foreground }}>{protectionText(x)}</Text>
            <Text style={{ color: c.foregroundMuted }}>
              Paired {new Date(x.pairedAt).toLocaleDateString(undefined, DATE)}
              {x.revokedAt
                ? ` · revoked ${new Date(x.revokedAt).toLocaleDateString(undefined, DATE)}`
                : ""}
              {x.lastUsedAt
                ? ` · last used ${new Date(x.lastUsedAt).toLocaleDateString(undefined, DATE)}`
                : ""}
            </Text>
            {x.state === "active" && (
              <View
                testID={`device-revoke-${x.id}`}
                accessibilityRole="button"
                accessibilityState={{ disabled: true }}
                aria-disabled
                style={{
                  alignSelf: "flex-start",
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: 16,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: c.border,
                  opacity: 0.6,
                }}
              >
                <Text style={{ color: c.foreground, fontWeight: "600" }}>Revoke</Text>
              </View>
            )}
            {x.state === "active" && (
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                Revoking needs device pairing, which isn't available in this version yet.
              </Text>
            )}
          </>,
          x.id,
        ),
      )}
    </ScrollView>
  );
}
