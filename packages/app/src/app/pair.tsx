import { useCallback } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { buildOpenProjectRoute } from "@/utils/host-routes";

// Both branded pairing schemes enter this route while the root offer listener imports the invitation.
export default function PairScreen() {
  const { error } = useLocalSearchParams<{ error?: string }>();
  const router = useRouter();
  const goHome = useCallback(() => router.replace(buildOpenProjectRoute()), [router]);
  return (
    <View style={styles.container}>
      <Text accessibilityLiveRegion="polite" style={styles.text}>
        {error ? `Pairing could not finish. ${error}` : "Connecting to your host…"}
      </Text>
      <Button variant="secondary" onPress={goHome}>
        Back to home
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
    backgroundColor: theme.colors.surface0,
  },
  text: { fontSize: 16, textAlign: "center", color: theme.colors.foreground },
}));
