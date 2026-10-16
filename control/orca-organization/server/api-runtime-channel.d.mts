import type { ChildProcess } from "node:child_process";
export function createApiRuntimeChannel(options: {
  root: string;
  accountId: string;
  epoch?: string | null;
  onStop: () => void;
}): { release(): void; attach(child: ChildProcess): string | null };
