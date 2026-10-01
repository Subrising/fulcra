import React from "react";
import { darkTheme, lightTheme } from "../../packages/app/src/styles/theme";
export const fixtureTheme =
  new URLSearchParams(location.search).get("theme") === "light" ? lightTheme : darkTheme;
type Theme = typeof fixtureTheme;
type Props = Record<string, unknown>;
export const StyleSheet = {
  create: (styles: Props | ((theme: Theme) => Props)) =>
    typeof styles === "function" ? styles(fixtureTheme) : styles,
};
export const withUnistyles =
  (Component: React.ComponentType<Props>) =>
  ({ uniProps, ...props }: Props & { uniProps?: (theme: Theme) => Props }) => (
    <Component {...(uniProps?.(fixtureTheme) ?? {})} {...props} />
  );
