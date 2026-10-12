import path from "node:path";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";
import { loadAgentPolicy } from "./policy.js";
import type { LimitResumeDeps as PolicyDeps } from "../../../../../plugins/fulcra-agent-policy/server/service.mjs";
export type {
  LimitResumeAgent,
  LimitResumeEvent,
} from "../../../../../plugins/fulcra-agent-policy/server/service.mjs";
export type LimitResumeDeps = Omit<PolicyDeps, "writeQueue">;
const policy = loadAgentPolicy("service");
export const {
  RESUME_PROMPT,
  LIMIT_RESUME_AT_LABEL,
  LIMIT_RESUME_OPT_OUT_LABEL,
  STAGGER_MS,
  MAX_JITTER_MS,
  HANDOFF_MS,
  MAX_CHAIN,
  NETWORK_BACKOFF_MS,
  NETWORK_RESUME_PROMPT,
  INTERRUPTED_RESUME_PROMPT,
  INTERRUPTED_SETTLE_MS,
  limitResumeFilePath,
} = policy;

/** Host-private queue writes and final provider checks stay outside the observation plugin. */
export class LimitResumeService extends policy.LimitResumeService {
  constructor(deps: LimitResumeDeps) {
    const file = policy.limitResumeFilePath(deps.paseoHome);
    super({
      ...deps,
      writeQueue: (target, text) => {
        if (target !== file) throw new Error("Recovery queue path changed");
        ensurePrivateDirectory(path.dirname(file));
        writePrivateFileAtomicSync(file, text);
      },
    });
  }
}
