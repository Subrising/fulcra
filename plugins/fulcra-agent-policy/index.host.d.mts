import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { LimitResumeService } from "./server/service.mjs";
import type { ReportUpObserver } from "./server/report-observer.mjs";
export interface PolicyHooks {
  on<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    handler: (event: PluginLifecycleEvents[Name]) => void | Promise<void>,
  ): () => void;
}
export function registerRecoveryHooks(server: PolicyHooks, service: LimitResumeService): () => void;
export function registerReportHooks(server: PolicyHooks, observer: ReportUpObserver): () => void;
