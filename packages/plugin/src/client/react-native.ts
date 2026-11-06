<<<<<<< HEAD
import type {
  ComponentType,
  FunctionComponent,
  ReactNode,
  ForwardRefExoticComponent,
  RefAttributes,
  ReactElement,
  Ref,
} from "react";
import type {
  StyleProp,
  ViewStyle,
  ViewProps,
  ScrollView as NativeScrollView,
  ScrollViewProps,
  FlatList as NativeFlatList,
  FlatListProps,
  TextInput as NativeTextInput,
  TextInputProps,
} from "react-native";
import type { PluginIconProps } from "./contracts.js";
=======
// COMPAT(pluginReactNativeEntrypoint): added in v0.13.0, remove after 2027-04-20
/** @deprecated Import Paseo UI from @getpaseo/plugin/client/ui. */
export * from "./ui.js";
>>>>>>> refs/remotes/upstream/tags/v0.14.0

/** @deprecated Render StreamedText from @getpaseo/plugin/client/ui. Removed after 2027-04-20 with this entry. */
export declare function useRevealedText(text: string, phase: "streaming" | "complete"): string;
<<<<<<< HEAD

export type { PluginIconProps } from "./contracts.js";

/** React Native scrolling with the host's sheet gestures when rendered inside a sheet. */
export declare const ScrollView: ForwardRefExoticComponent<
  ScrollViewProps & RefAttributes<NativeScrollView>
>;
export declare function FlatList<Item>(
  props: FlatListProps<Item> & { ref?: Ref<NativeFlatList<Item>> },
): ReactElement;
/** Copies text to this client's clipboard. Rejects when copying is unavailable or denied. */
export declare function copyText(text: string): Promise<void>;

/** Native input focus integrated with modal keyboard positioning. */
export declare const TextInput: ForwardRefExoticComponent<
  TextInputProps & RefAttributes<NativeTextInput>
>;

export interface PanTranslation {
  x: number;
  y: number;
}
export interface PanSurfaceProps extends ViewProps {
  onPanStart(): void;
  onPanUpdate(translation: PanTranslation): void;
  onPanEnd(cancelled: boolean): void;
}
/** Opt-in page scrolling that waits for descendant PanSurface gestures. */
export declare const PanScrollView: ForwardRefExoticComponent<
  ScrollViewProps & RefAttributes<NativeScrollView>
>;
/** Native pan arbitration; child buttons retain ordinary tap/accessibility behavior. */
export declare const PanSurface: ComponentType<PanSurfaceProps>;
=======
>>>>>>> refs/remotes/upstream/tags/v0.14.0
