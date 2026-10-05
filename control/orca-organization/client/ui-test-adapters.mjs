// Synthetic DOM adapter for component behavior tests. This is not a Paseo/phone UI test.
import React from "react";
export const calls = [];
export const scrollCalls = [];
export const layoutHandlers = new Map();
let handler;
export function setHandler(next) {
  handler = next;
  calls.length = 0;
}
export function useRpc(definition) {
  return (input) => {
    calls.push({ name: definition.name, input });
    return handler(definition.name, input);
  };
}
function component(tag, nativeKind) {
  return ({
    ref,
    children,
    testID,
    style,
    onLayout,
    onTouchStart,
    onTouchEnd,
    onTouchCancel,
    scrollEnabled,
    keyboardShouldPersistTaps,
    accessibilityElementsHidden,
    importantForAccessibility,
    pointerEvents,
    accessible,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    "aria-expanded": expanded,
    "aria-selected": selected,
    accessibilityLiveRegion,
    disabled,
    onPress,
    value,
    onChangeText,
    editable,
    multiline,
    maxLength,
  }) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: (value) => scrollCalls.push(value) }), []);
    if (testID && onLayout) layoutHandlers.set(testID, onLayout);
    return React.createElement(
      multiline ? "textarea" : tag,
      {
        style: { display: style?.display },
        "data-native-keyboard-taps": keyboardShouldPersistTaps,
        "data-native-accessibility-hidden": accessibilityElementsHidden,
        "data-native-important-accessibility": importantForAccessibility,
        "data-native-scroll-enabled": scrollEnabled,
        onTouchStart,
        onTouchEnd,
        onTouchCancel,
        "data-native-style": style ? JSON.stringify(style) : undefined,
        "data-native-pointer-events": pointerEvents,
        "data-native-accessible": accessible,
        "data-testid": testID,
        "data-native-kind": nativeKind,
        "aria-label": accessibilityLabel,
        role: accessibilityRole,
        "aria-checked": accessibilityState?.checked,
        "aria-selected": selected ?? accessibilityState?.selected,
        "aria-expanded": expanded ?? accessibilityState?.expanded,
        "aria-live": accessibilityLiveRegion,
        disabled: disabled || editable === false,
        onClick: onPress,
        value,
        maxLength,
        onChange: onChangeText ? (event) => onChangeText(event.target.value) : undefined,
      },
      children,
    );
  };
}
export const View = component("div"),
  Text = component("span"),
  ScrollView = component("div", "ScrollView"),
  Pressable = component("button"),
  TextInput = component("input");

// J3: a synthetic OS URL opener. It records requests; nothing is opened.
export const openedUrls = [];
// J4b: the host API seam (usePaseo). null = a host without it.
let paseo = null;
export function setPaseo(next) {
  paseo = next;
}
export const usePaseo = () => paseo ?? {};
export const Linking = {
  openURL: async (url) => {
    openedUrls.push(url);
  },
};

export const panResponders = [];
export const PanResponder = {
  create: (handlers) => {
    panResponders.push(handlers);
    return { panHandlers: {} };
  },
};

export const nativePans = [];
function SyntheticPanSurface({ onPanStart, onPanUpdate, onPanEnd, ...props }) {
  nativePans.push({ onPanStart, onPanUpdate, onPanEnd });
  return React.createElement(View, props);
}
export let PanSurface = SyntheticPanSurface;
export let PanScrollView = ScrollView;
export function setHostPanAvailable(value) {
  PanSurface = value ? SyntheticPanSurface : undefined;
  PanScrollView = value ? ScrollView : undefined;
}

export const copied = [];
export function copyText(text) {
  copied.push(text);
  return Promise.resolve();
}

export const Keyboard = {
  dismiss() {
    document.activeElement?.blur?.();
  },
};

// Owned native-catalog ports for the existing component harness. No daemon or provider is contacted.
let nativeHosts = [],
  nativeClients = new Map();
export function setNativeHostCatalog(hosts = [], clients = new Map()) {
  nativeHosts = hosts;
  nativeClients = clients;
}
export const useHosts = () => nativeHosts;
export function getPaseoClient(serverId) {
  const client = nativeClients.get(serverId);
  if (!client) throw new Error(`Fixture host is unavailable: ${serverId}`);
  return client;
}
export function SettingsInput({
  label,
  initialValue = "",
  onChangeText,
  placeholder,
  disabled,
  ref,
}) {
  const [text, setText] = React.useState(initialValue);
  React.useImperativeHandle(
    ref,
    () => ({ focus() {}, blur() {}, getText: () => text, replaceText: setText }),
    [text],
  );
  return React.createElement(
    "label",
    null,
    label,
    React.createElement("input", {
      "aria-label": label,
      value: text,
      placeholder,
      disabled,
      onChange: (event) => {
        setText(event.target.value);
        onChangeText(event.target.value);
      },
    }),
  );
}

export function SettingsSection({ title, children }) {
  return React.createElement("section", null, React.createElement("h3", null, title), children);
}
export function SettingsGroup({ title, children }) {
  return React.createElement("section", null, React.createElement("h2", null, title), children);
}

let nativeDirectory = Object.freeze({
  entries: Object.freeze([]),
  total: 0,
  truncated: 0,
  source: "native-cache",
});
const nativeListeners = new Set();
export function setObservedAgents(next) {
  nativeDirectory = next;
  for (const listener of nativeListeners) listener();
}
export function useObservedAgents() {
  return React.useSyncExternalStore(
    (listener) => {
      nativeListeners.add(listener);
      return () => nativeListeners.delete(listener);
    },
    () => nativeDirectory,
    () => nativeDirectory,
  );
}
