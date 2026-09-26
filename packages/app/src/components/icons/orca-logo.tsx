import { useMemo } from "react";
import { Image } from "react-native";

interface OrcaLogoProps {
  size?: number;
}

/** Keep a seafoam backing so the dark silhouette stays readable in either theme. */
export function OrcaLogo({ size = 64 }: OrcaLogoProps) {
  const style = useMemo(() => ({ width: size, height: size, borderRadius: size * 0.23 }), [size]);
  return (
    <Image
      source={require("../../../assets/images/fulcra-v1/icon.png")}
      style={style}
      resizeMode="contain"
      accessibilityLabel="Fulcra"
      accessibilityRole="image"
    />
  );
}
