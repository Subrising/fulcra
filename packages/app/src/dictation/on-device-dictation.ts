export interface OnDeviceDictation {
  start(locale: string, onPartial: (text: string) => void): Promise<boolean>;
  append(base64: string): void;
  finish(): Promise<string>;
  cancel(): void;
}
export function createOnDeviceDictation(): OnDeviceDictation | null {
  return null;
}
