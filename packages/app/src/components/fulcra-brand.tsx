// Fulcra brand components (FU-401). The glow, the mark and the eyebrow come from the website.
// Rules (FINAL-BRIEF section 4):
// - BrandGlow only on welcome, splash and open-project. Never behind chat, diff or terminal.
//   A test (fulcra-brand.test.ts) lists the only files that may import it.
// - Static: no motion, so reduced motion is met.
// - Burgundy appears only on the mark tile, the glow and the user chat bubble.
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Svg, {
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Mask,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";
import { FULCRA_BRAND } from "@/styles/fulcra-theme";

const GLOW_MAX_HEIGHT = 420;

// Port of website site.css:146-154 (.glow). Burgundy and coral radial light from the top edge,
// masked to fade out by the bottom. Fixed brand hues; the glowVeil token softens it in light.
export function BrandGlow({ height = GLOW_MAX_HEIGHT }: { height?: number }) {
  const h = Math.min(height, GLOW_MAX_HEIGHT);
  return (
    <View
      pointerEvents="none"
      style={[styles.glow, { height: h }]}
      testID="brand-glow"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
        <Defs>
          <RadialGradient id="fulcra-glow-burgundy" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={FULCRA_BRAND.burgundy} stopOpacity={0.95} />
            <Stop offset="0.85" stopColor={FULCRA_BRAND.burgundy} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="fulcra-glow-coral" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={FULCRA_BRAND.coral} stopOpacity={0.4} />
            <Stop offset="0.7" stopColor={FULCRA_BRAND.coral} stopOpacity={0} />
          </RadialGradient>
          <LinearGradient id="fulcra-glow-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0.7" stopColor="#ffffff" stopOpacity={1} />
            <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
          </LinearGradient>
          <Mask
            id="fulcra-glow-mask"
            x="0"
            y="0"
            width="100"
            height="100"
            maskUnits="userSpaceOnUse"
          >
            <Rect x="0" y="0" width="100" height="100" fill="url(#fulcra-glow-fade)" />
          </Mask>
        </Defs>
        <G mask="url(#fulcra-glow-mask)">
          <Ellipse cx="50" cy="0" rx="85" ry="95" fill="url(#fulcra-glow-burgundy)" />
          <Ellipse cx="50" cy="0" rx="52" ry="70" fill="url(#fulcra-glow-coral)" />
        </G>
      </Svg>
      <View style={styles.glowVeil} />
    </View>
  );
}

// The Keystone arch (fulcra-v1/icon.svg, byte-identical to the website mark) on a burgundy tile.
export function BrandMarkTile({ size = 56 }: { size?: number }) {
  return (
    <View
      style={[styles.markTile, { width: size, height: size, borderRadius: size * 0.24 }]}
      testID="brand-mark"
      accessibilityRole="image"
      accessibilityLabel="Fulcra"
    >
      <Svg width={size} height={size} viewBox="0 0 1000 1000">
        <G transform="translate(500 540.526) scale(0.965)">
          <Path
            d="M340 0 A340 340 0 0 0 275.066 -199.847 L137.533 -99.923 A170 170 0 0 1 170 0 Z"
            fill="#F2E7D5"
          />
          <Path
            d="M275.066 -199.847 A340 340 0 0 0 105.066 -323.359 L52.533 -161.68 A170 170 0 0 1 137.533 -99.923 Z"
            fill="#F2E7D5"
          />
          <Path
            d="M118.663 -365.206 A384 384 0 0 0 -118.663 -365.206 L-52.533 -161.68 A170 170 0 0 1 52.533 -161.68 Z"
            fill="#FF8A5B"
          />
          <Path
            d="M-105.066 -323.359 A340 340 0 0 0 -275.066 -199.847 L-137.533 -99.923 A170 170 0 0 1 -52.533 -161.68 Z"
            fill="#F2E7D5"
          />
          <Path
            d="M-275.066 -199.847 A340 340 0 0 0 -340 -0 L-170 -0 A170 170 0 0 1 -137.533 -99.923 Z"
            fill="#F2E7D5"
          />
          <Path d="M0 0 L326.843 -237.465" stroke="#5E1623" strokeWidth={18} />
          <Path d="M0 0 L124.843 -384.227" stroke="#5E1623" strokeWidth={18} />
          <Path d="M0 0 L-124.843 -384.227" stroke="#5E1623" strokeWidth={18} />
          <Path d="M0 0 L-326.843 -237.465" stroke="#5E1623" strokeWidth={18} />
          <Path d="M-340 18 L-170 18 L-170 300 L-340 300 Z" fill="#F2E7D5" />
          <Path d="M170 18 L340 18 L340 300 L170 300 Z" fill="#F2E7D5" />
        </G>
      </Svg>
    </View>
  );
}

// Small label above a heading: 13px, 700, +0.14em, uppercase, in the accent (site.css:303-309).
export function BrandEyebrow({ children }: { children: ReactNode }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

// Tight heading tracking from the site (-0.035em hero), weight 700. The app body size is kept.
export function BrandHeadline({
  children,
  accentLine,
  fontSize = 40,
}: {
  children: ReactNode;
  accentLine?: ReactNode;
  fontSize?: number;
}) {
  return (
    <Text
      style={[
        styles.headline,
        { fontSize, lineHeight: Math.round(fontSize * 1.08), letterSpacing: -0.035 * fontSize },
      ]}
      accessibilityRole="header"
    >
      {children}
      {accentLine ? (
        <>
          {"\n"}
          <Text style={styles.headlineAccent}>{accentLine}</Text>
        </>
      ) : null}
    </Text>
  );
}

// Empty state: 28px mark tile + eyebrow + one line. No glow (D5).
export function BrandEmptyState({ eyebrow, line }: { eyebrow: string; line: string }) {
  return (
    <View style={styles.emptyState} testID="brand-empty-state">
      <BrandMarkTile size={28} />
      <BrandEyebrow>{eyebrow}</BrandEyebrow>
      <Text style={styles.emptyLine}>{line}</Text>
    </View>
  );
}

// 3px accent bar at the left edge of the selected or active sidebar row (D3).
export function SidebarSelectedBar() {
  return <View pointerEvents="none" style={styles.selectedBar} testID="sidebar-selected-bar" />;
}

// Sidebar head: small mark tile + eyebrow wordmark. One per sidebar, never in nav rows.
export function SidebarBrandRow() {
  return (
    <View style={styles.sidebarBrandRow} testID="sidebar-brand-row">
      <BrandMarkTile size={22} />
      <BrandEyebrow>Fulcra</BrandEyebrow>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  glow: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  glowVeil: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.glowVeil,
  },
  markTile: {
    backgroundColor: FULCRA_BRAND.burgundy,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  emptyState: {
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  selectedBar: {
    position: "absolute",
    left: 0,
    top: 6,
    bottom: 6,
    width: 3,
    borderRadius: 2,
    backgroundColor: theme.colors.accent,
    zIndex: 1,
  },
  sidebarBrandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  eyebrow: {
    color: theme.colors.accent,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 13 * 0.14,
    textTransform: "uppercase",
  },
  headline: {
    color: theme.colors.foreground,
    fontWeight: "700",
    textAlign: "center",
  },
  headlineAccent: {
    color: theme.colors.accentBright,
  },
}));
