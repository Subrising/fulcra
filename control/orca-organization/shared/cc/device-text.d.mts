interface DeviceLike {
  label?: string;
  platform: string;
  keyStorage: string;
  userPresence: boolean;
}
export declare const PLATFORM_NAME: Readonly<Record<string, string>>;
export declare function protectionText(d: DeviceLike): string;
export declare function deviceLine(d: DeviceLike & { label: string }): string;
