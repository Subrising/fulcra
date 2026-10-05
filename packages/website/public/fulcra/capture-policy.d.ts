export interface PublicProductFrame {
  id: string;
  title: string;
  alt: string;
  caption: string;
  src: string;
  sourceCommit: string;
  verificationCommit: string;
  artifactSeal: string;
  asarSha256: string;
  version: string;
  capturedOn: "mac-mini" | "macbook-pro";
  capturedAt: string;
  sha256: string;
  actualCapture: true;
  installedCapture: true;
  publicSafe: true;
  width: number;
  height: number;
  kind?: "desktop-app" | "compact-web" | "native-mobile";
  chapter?: "organise" | "delegate" | "follow" | "continue";
}
export function acceptedFrames(value: unknown): PublicProductFrame[];
