import React, { forwardRef } from "react";
import type { ScrollView, ScrollViewProps } from "react-native";
import type { PanSurfaceProps } from "@getpaseo/plugin/client/react-native";
import type * as Host from "./pan-surface";

// Plugin evaluation can run before native UI initialization.
export const PanScrollView = forwardRef<ScrollView, ScrollViewProps>(
  function PanScrollView(props, ref) {
    const { PanScrollView: HostScrollView } = require("./pan-surface") as typeof Host;
    return <HostScrollView {...props} ref={ref} />;
  },
);
export function PanSurface(props: PanSurfaceProps) {
  const { PanSurface: HostSurface } = require("./pan-surface") as typeof Host;
  return <HostSurface {...props} />;
}
