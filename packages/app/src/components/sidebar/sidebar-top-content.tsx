import { createContext, useContext, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

// FULCRA(sidebar): the sidebar's top rows (main assistant, new chat, plugin rows such as Leads) scroll with Pinned
// and the sessions below them, as one area. A long Leads block used to sit above the scroll and hide Pinned and
// Working on small screens. The sidebar provides the rows; each list mode renders them first in its scroll content.
const SidebarTopContentContext = createContext<ReactNode>(null);

export const SidebarTopContentProvider = SidebarTopContentContext.Provider;

/** The top rows, first in a sidebar scroll. `inset` cancels a list's horizontal content padding. */
export function SidebarTopContent({ inset = false }: { inset?: boolean }) {
  const content = useContext(SidebarTopContentContext);
  if (!content) return null;
  return (
    <View style={inset ? styles.inset : undefined} testID="sidebar-top-content">
      {content}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inset: {
    marginHorizontal: -theme.spacing[2],
  },
}));
