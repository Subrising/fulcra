import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { forwardOAuthCallback, type OAuthCallbackOutcome } from "@/integrations/oauth-callback";
import { credentialClients } from "@/integrations/oauth-callback-listener";

function describeOutcome(outcome: OAuthCallbackOutcome | null): string {
  if (!outcome) return "Finishing sign-in…";
  if (outcome.status === "connected") {
    return `${outcome.displayName} is connected. You can go back to Integrations.`;
  }
  if (outcome.status === "pending") {
    return "Still waiting for the tracker to confirm. Go back to Integrations and try again shortly.";
  }
  return outcome.message;
}

// Mobile: `fulcra://oauth/<flowId>?…` opens this route. The link is rebuilt exactly as it arrived (path and
// query) and handed to the host that started the sign-in; the host validates it and uses it once.
export default function OAuthCallbackScreen() {
  const pathname = usePathname();
  const params = useGlobalSearchParams<Record<string, string>>();
  const [outcome, setOutcome] = useState<OAuthCallbackOutcome | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(
      Object.entries(params).filter(
        (entry): entry is [string, string] => entry[0] !== "flowId" && typeof entry[1] === "string",
      ),
    ).toString();
    const url = `fulcra:/${pathname}${query ? `?${query}` : ""}`;
    void forwardOAuthCallback(url, credentialClients()).then(setOutcome);
  }, [pathname, params]);
  return (
    <View style={styles.container}>
      <Text accessibilityLiveRegion="polite" style={styles.text}>
        {describeOutcome(outcome)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: theme.colors.surface0,
  },
  text: {
    fontSize: 16,
    textAlign: "center",
    color: theme.colors.foreground,
  },
}));
