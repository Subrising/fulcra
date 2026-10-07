// The restart banner shows once per restart, then lives under Home › All activity and history. "Seen" is local to
// this window: browser storage on web (so it survives a reload), memory elsewhere. Nothing is sent anywhere.
interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const memory = new Map<string, string[]>();
const KEEP = 20;
const key = (host: string) => JSON.stringify(["fulcra.recovery.seen.v1", host]);
function storage(): BrowserStorage | undefined {
  try {
    return (globalThis as { localStorage?: BrowserStorage }).localStorage;
  } catch {
    return;
  }
}
function read(host: string): string[] {
  let saved = memory.get(host) ?? [];
  try {
    const raw = storage()?.getItem(key(host));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) saved = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    /* memory only */
  }
  memory.set(host, saved);
  return saved;
}
export function bannerSeen(host: string, signature: string): boolean {
  return read(host).includes(signature);
}
export function markBannerSeen(host: string, signature: string) {
  const next = [signature, ...read(host).filter((s) => s !== signature)].slice(0, KEEP);
  memory.set(host, next);
  try {
    storage()?.setItem(key(host), JSON.stringify(next));
  } catch {
    /* memory only */
  }
}
