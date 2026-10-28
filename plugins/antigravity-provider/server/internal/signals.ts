import { execCommand } from "@getpaseo/plugin/server";

interface SignalOptions {
  platform: NodeJS.Platform;
  pid: number;
  signal: NodeJS.Signals;
}

type SignalPlan =
  | { type: "group"; pid: number; signal: NodeJS.Signals }
  | { type: "tree"; command: "taskkill"; args: string[] };

export function signalPlan(options: SignalOptions): SignalPlan {
  if (options.platform === "win32") {
    return { type: "tree", command: "taskkill", args: ["/PID", String(options.pid), "/T", "/F"] };
  }
  return { type: "group", pid: -options.pid, signal: options.signal };
}

// macOS reports EPERM, not ESRCH, when a group holds only a defunct (unreaped) leader.
export async function isDefunct(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execCommand("ps", ["-o", "stat=", "-p", String(pid)], {
      shell: false,
    });
    return stdout.trim().startsWith("Z");
  } catch (error) {
    // ps exits 1 when no such process exists.
    return error instanceof Error && "code" in error && error.code === 1;
  }
}

export async function signalProcess(
  options: SignalOptions,
  defunct: (pid: number) => Promise<boolean> = isDefunct,
): Promise<void> {
  const plan = signalPlan(options);
  if (plan.type === "tree") return killTree(plan);
  try {
    process.kill(plan.pid, plan.signal);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ESRCH") return;
    // Any other EPERM is a real permission failure and must surface.
    if (code === "EPERM" && (await defunct(options.pid))) return;
    throw error;
  }
}

async function killTree(plan: Extract<SignalPlan, { type: "tree" }>): Promise<void> {
  try {
    await execCommand(plan.command, plan.args, { shell: false });
  } catch (error) {
    // taskkill reports an already-exited PID with exit code 128.
    if (!(error instanceof Error && "code" in error && error.code === 128)) throw error;
  }
}
