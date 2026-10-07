export function toolEnvironment(options?: {
  bin?: string;
  kubeconfig?: string;
}): Record<string, string>;
export class ToolError extends Error {
  code: number | null;
  output: string;
}
export interface RunOptions {
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  onLine?: (line: string) => void;
  input?: string;
  signal?: AbortSignal;
}
export function runTool(
  file: string,
  args: string[],
  options?: RunOptions,
): Promise<{ code: number; stdout: string; stderr: string }>;
export function mustRun(
  file: string,
  args: string[],
  options?: RunOptions,
): Promise<{ code: number; stdout: string; stderr: string }>;
