export function processSnapshot(): { pid: number; parent: number; start: string }[];
export function processIdentity(pid: number | undefined): string | null;
export function stopRecordedTree(pid: number | undefined, start: string | null): Promise<void>;
