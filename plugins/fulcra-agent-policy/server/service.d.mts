import {
  INTERRUPTED_RESUME_PROMPT,
  LIMIT_RESUME_AT_LABEL,
  LIMIT_RESUME_OPT_OUT_LABEL,
  NETWORK_RESUME_PROMPT,
} from "@getpaseo/protocol/limit-resume";
export declare const RESUME_PROMPT: string;
export { LIMIT_RESUME_AT_LABEL, LIMIT_RESUME_OPT_OUT_LABEL };
export declare const STAGGER_MS = 3000;
export declare const MAX_JITTER_MS = 60000;
/** Ownership is checked directly; no competing-owner handoff delay is needed. */
export declare const HANDOFF_MS = 0;
export declare const MAX_CHAIN = 4;
export declare const NETWORK_BACKOFF_MS: number[];
export declare const LOOKUP_RETRY_MS: number[];
export { NETWORK_RESUME_PROMPT, INTERRUPTED_RESUME_PROMPT };
/** After a daemon restart: lets providers, relay and the account pool come back before sessions are woken. */
export declare const INTERRUPTED_SETTLE_MS = 45000;
export interface LimitResumeAgent {
  labels: Record<string, string>;
  archived: boolean;
  /** A turn is already running or starting. */
  busy: boolean;
  unscopedResumeAllowed: boolean;
  binding: string | null;
  /** Read from storage only: the session is not loaded, so ownership and binding are not known yet. */
  stored?: true;
}
export interface LimitResumeDeps {
  paseoHome: string;
  writeQueue: (file: string, text: string) => void;
  isEnabled: () => boolean;
  getAgent: (agentId: string, forResume?: boolean) => Promise<LimitResumeAgent | null>;
  captureBinding: (agentId: string) => string | null;
  /** The final assistant message of the session's last turn (the Claude CLI reports its limit this way). */
  getLastAssistantMessage: (agentId: string) => Promise<string | null>;
  /** Writes (or, with null, clears) the label the app shows as "Paused: usage limit, resumes at HH:MM". */
  setMarker: (
    agentId: string,
    resumeAtIso: string | null,
    reason?: "network" | "usage" | "interrupted",
  ) => Promise<void>;
  /**
   * Starts the resume turn with repeatable refusal-only `stillWanted` checks after all preparation awaits.
   * `consume` is called once at the actual synchronous provider handoff, never an earlier manager gate.
   * Neither callback grants input authority. A stopped service must retain an unconsumed entry.
   */
  sendResume: (
    agentId: string,
    prompt: string,
    stillWanted: () => boolean,
    consume: () => void,
    originalBinding: string,
  ) => Promise<void>;
  onError: (error: unknown) => void;
  /** Says why a due resume was dropped without a turn (operators read this in the daemon log). */
  onSkip?: (agentId: string, reason: string) => void;
  now?: () => number;
  random?: () => number;
}
export interface LimitResumeEvent {
  type: string;
  agentId?: string;
  event?: {
    type?: string;
    error?: unknown;
    code?: unknown;
    diagnostic?: unknown;
    lastAssistant?: string | null;
    turnId?: unknown;
    item?: {
      type?: unknown;
    };
  };
}
export declare function limitResumeFilePath(paseoHome: string): string;
export declare class LimitResumeService {
  private readonly deps;
  private readonly file;
  private readonly now;
  private readonly random;
  private queue;
  private readonly epochs;
  private chain;
  private timer;
  private nextSlotAt;
  private ticking;
  private stopped;
  private startedAt;
  private unsubscribe;
  constructor(deps: LimitResumeDeps);
  start(): void;
  stop(): void;
  /** Release the daemon event listener together with the timer on shutdown. */
  onStop(unsubscribe: () => void): void;
  /** What the app reads: the pending resume time for a session, or null. */
  pendingResumeAt(agentId: string): number | null;
  private epochOf;
  /** Runs `fn` after everything queued before it, whatever happens to earlier work. */
  private locked;
  onAgentEvent(input: LimitResumeEvent): Promise<void>;
  private admit;
  private admissionAgent;
  private nextAttempt;
  private schedule;
  /** Keeps the running turn's binding on disk, so a restart in the middle of it can be resumed safely. */
  private recordRunning;
  private clearRunning;
  /**
   * Queues, once each, the sessions whose turn was still running when the previous daemon stopped: a record from
   * before this boot means the service stopped (or the process died) before that turn ended. This covers a graceful
   * restart, which saves the cut-off turn as stopped, as well as a crash. `bootId` names this boot.
   */
  enqueueInterrupted(bootId: string): Promise<void>;
  private admitInterrupted;
  private clearStaleMarker;
  /** Drops a pending resume (the person resumed, opted out, or something else started a turn). */
  cancel(agentId: string): Promise<void>;
  private save;
  private arm;
  private tick;
  private fire;
}
