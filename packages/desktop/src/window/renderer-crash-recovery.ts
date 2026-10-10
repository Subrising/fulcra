import type { BrowserWindow } from "electron";

export interface RendererGoneDetails {
  reason: string;
  exitCode: number;
}

export interface RendererCrashLogger {
  error: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
}

export interface RendererCrashRecoveryDeps {
  logger: RendererCrashLogger;
  now?: () => number;
}

// Reasons that mean the renderer ended on purpose or the OS stopped it for a
// reason a reload cannot fix.
const NO_RELOAD_REASONS = new Set(["clean-exit", "launch-failed", "integrity-failure"]);
const MAX_RELOADS = 3;
const RELOAD_WINDOW_MS = 60_000;

export function shouldReloadRenderer(input: {
  reason: string;
  recentReloads: number;
}): boolean {
  return !NO_RELOAD_REASONS.has(input.reason) && input.recentReloads < MAX_RELOADS;
}

// A renderer that dies leaves a blank window and, before this module, no log
// line. This logs the reason and reloads the window up to MAX_RELOADS times
// per minute, so a crash loop stops instead of spinning.
export function setupRendererCrashRecovery(
  win: BrowserWindow,
  deps: RendererCrashRecoveryDeps,
): void {
  const now = deps.now ?? Date.now;
  let reloads: number[] = [];

  win.webContents.on("render-process-gone", (_event, details: RendererGoneDetails) => {
    const at = now();
    reloads = reloads.filter((time) => at - time < RELOAD_WINDOW_MS);
    const reload = shouldReloadRenderer({ reason: details.reason, recentReloads: reloads.length });
    deps.logger.error("[renderer] process gone", {
      reason: details.reason,
      exitCode: details.exitCode,
      willReload: reload,
    });
    if (!reload || win.isDestroyed()) {
      return;
    }
    reloads.push(at);
    win.webContents.reload();
  });
}

export function logChildProcessGone(
  logger: RendererCrashLogger,
  details: { type: string; reason: string; exitCode: number; name?: string },
): void {
  if (details.reason === "clean-exit") {
    return;
  }
  logger.error("[child-process] gone", {
    type: details.type,
    name: details.name ?? null,
    reason: details.reason,
    exitCode: details.exitCode,
  });
}
