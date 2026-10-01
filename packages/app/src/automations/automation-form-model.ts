import type { Automation, AutomationInput } from "@getpaseo/protocol/messages";
import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";

// The automation builder's form model ("When X, do Y"). Plain TypeScript, no React: the sheet renders state and
// dispatches commands. Built once per open (docs/forms.md); edit mode seeds every value and display from the record.

export type TriggerKind = AutomationInput["trigger"]["kind"];
export type ActionKind = AutomationInput["action"]["kind"];
export type SessionEvent = Extract<AutomationInput["trigger"], { kind: "session" }>["event"];
export type PullRequestEvent = "opened" | "updated";

/** A template is an agent profile, or a provider with its default settings. */
export type TemplateChoice =
  | { kind: "profile"; id: string; provider: string }
  | { kind: "provider"; provider: string };

export interface AutomationFormState {
  name: string;
  enabled: boolean;
  triggerKind: TriggerKind;
  cadence: ScheduleCadence;
  pullRequestProjectId: string | null;
  pullRequestEvents: PullRequestEvent[];
  sessionEvent: SessionEvent;
  /** null: sessions in any project. */
  sessionProjectId: string | null;
  actionKind: ActionKind;
  projectId: string | null;
  template: TemplateChoice | null;
  prompt: string;
  agentId: string | null;
  noteText: string;
  postToGithub: boolean;
  /** The session may run without asking for permission. Off unless the person turns it on. */
  allowUnattended: boolean;
  /** Labels captured when a value was chosen, so list churn never blanks a selection. */
  displays: Partial<
    Record<"pullRequestProject" | "sessionProject" | "project" | "template" | "session", string>
  >;
  /** Posting a note to GitHub only exists for a pull request trigger. */
  canPostToGithub: boolean;
  canSubmit: boolean;
}

export interface AutomationFormSnapshot {
  automation?: Automation;
  /** Display names for the record's ids, from the latest list. */
  names?: {
    project?: (id: string) => string | undefined;
    session?: (id: string) => string | undefined;
    template?: (id: string) => string | undefined;
    /** The label for a provider with its default settings. */
    providerDefaults?: (provider: string) => string;
  };
}

const DEFAULT_CADENCE: ScheduleCadence = { type: "every", everyMs: 60 * 60 * 1000 };

type Base = Omit<AutomationFormState, "canPostToGithub" | "canSubmit">;

function blank(): Base {
  return {
    name: "",
    enabled: true,
    triggerKind: "pull_request",
    cadence: DEFAULT_CADENCE,
    pullRequestProjectId: null,
    pullRequestEvents: ["opened"],
    sessionEvent: "finished",
    sessionProjectId: null,
    actionKind: "start_session",
    projectId: null,
    template: null,
    prompt: "",
    agentId: null,
    noteText: "",
    postToGithub: false,
    allowUnattended: false,
    displays: {},
  };
}

function seedTrigger(base: Base, trigger: Automation["trigger"], snapshot: AutomationFormSnapshot) {
  base.triggerKind = trigger.kind;
  if (trigger.kind === "schedule") base.cadence = trigger.cadence;
  if (trigger.kind === "pull_request") {
    base.pullRequestProjectId = trigger.projectId;
    base.pullRequestEvents = [...trigger.events];
    base.displays.pullRequestProject = snapshot.names?.project?.(trigger.projectId);
  }
  if (trigger.kind === "session") {
    base.sessionEvent = trigger.event;
    base.sessionProjectId = trigger.projectId ?? null;
    if (trigger.projectId)
      base.displays.sessionProject = snapshot.names?.project?.(trigger.projectId);
  }
}

function seedAction(base: Base, action: Automation["action"], snapshot: AutomationFormSnapshot) {
  base.actionKind = action.kind;
  if (action.kind === "start_session") {
    base.projectId = action.projectId;
    base.prompt = action.prompt;
    base.allowUnattended = action.allowUnattended === true;
    base.displays.project = snapshot.names?.project?.(action.projectId);
    base.template = action.profileId
      ? { kind: "profile", id: action.profileId, provider: action.provider }
      : { kind: "provider", provider: action.provider };
    const defaults = snapshot.names?.providerDefaults?.(action.provider) ?? action.provider;
    base.displays.template = action.profileId
      ? (snapshot.names?.template?.(action.profileId) ?? defaults)
      : defaults;
  }
  if (action.kind === "message_session") {
    base.agentId = action.agentId;
    base.prompt = action.prompt;
    base.displays.session = snapshot.names?.session?.(action.agentId);
  }
  if (action.kind === "note") {
    base.noteText = action.text;
    base.postToGithub = action.postToGithub;
  }
}

function derive(base: Base): AutomationFormState {
  const canPostToGithub = base.triggerKind === "pull_request" && base.actionKind === "note";
  const state = { ...base, canPostToGithub, canSubmit: false };
  state.canSubmit = toAutomationInput(state) !== null;
  return state;
}

function triggerOf(s: AutomationFormState): AutomationInput["trigger"] | null {
  if (s.triggerKind === "schedule") return { kind: "schedule", cadence: s.cadence };
  if (s.triggerKind === "pull_request") {
    if (!s.pullRequestProjectId || s.pullRequestEvents.length === 0) return null;
    return { kind: "pull_request", projectId: s.pullRequestProjectId, events: s.pullRequestEvents };
  }
  return {
    kind: "session",
    event: s.sessionEvent,
    ...(s.sessionProjectId ? { projectId: s.sessionProjectId } : {}),
  };
}

function actionOf(s: AutomationFormState): AutomationInput["action"] | null {
  const prompt = s.prompt.trim();
  if (s.actionKind === "start_session") {
    if (!s.projectId || !s.template || !prompt) return null;
    const template =
      s.template.kind === "profile"
        ? { profileId: s.template.id, provider: s.template.provider }
        : { provider: s.template.provider };
    return {
      kind: "start_session",
      projectId: s.projectId,
      prompt,
      ...template,
      ...(s.allowUnattended ? { allowUnattended: true } : {}),
    };
  }
  if (s.actionKind === "message_session") {
    if (!s.agentId || !prompt) return null;
    return { kind: "message_session", agentId: s.agentId, prompt };
  }
  const text = s.noteText.trim();
  if (!text) return null;
  return { kind: "note", text, postToGithub: s.canPostToGithub && s.postToGithub };
}

/** The RPC input for the current state, or null while something required is missing. */
export function toAutomationInput(s: AutomationFormState): AutomationInput | null {
  const name = s.name.trim();
  const trigger = triggerOf(s);
  const action = actionOf(s);
  if (!name || !trigger || !action) return null;
  return { name, enabled: s.enabled, trigger, action };
}

export interface AutomationFormModel {
  getState(): AutomationFormState;
  subscribe(listener: () => void): () => void;
  setName(value: string): void;
  setEnabled(value: boolean): void;
  setTriggerKind(value: TriggerKind): void;
  setCadence(value: ScheduleCadence): void;
  setPullRequestProject(value: string, display: string): void;
  togglePullRequestEvent(value: PullRequestEvent): void;
  setSessionEvent(value: SessionEvent): void;
  setSessionProject(value: string | null, display: string): void;
  setActionKind(value: ActionKind): void;
  setProject(value: string, display: string): void;
  setTemplate(value: TemplateChoice, display: string): void;
  setPrompt(value: string): void;
  setSession(value: string, display: string): void;
  setNoteText(value: string): void;
  setPostToGithub(value: boolean): void;
  setAllowUnattended(value: boolean): void;
}

export function openAutomationForm(snapshot: AutomationFormSnapshot): AutomationFormModel {
  const base = blank();
  if (snapshot.automation) {
    base.name = snapshot.automation.name;
    base.enabled = snapshot.automation.enabled;
    seedTrigger(base, snapshot.automation.trigger, snapshot);
    seedAction(base, snapshot.automation.action, snapshot);
  }
  let state = derive(base);
  const listeners = new Set<() => void>();
  const update = (patch: Partial<Base>) => {
    state = derive({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const withDisplay = (key: keyof Base["displays"], display: string) => ({
    ...state.displays,
    [key]: display,
  });
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setName: (name) => update({ name }),
    setEnabled: (enabled) => update({ enabled }),
    setTriggerKind: (triggerKind) => update({ triggerKind }),
    setCadence: (cadence) => update({ cadence }),
    setPullRequestProject: (value, display) =>
      update({ pullRequestProjectId: value, displays: withDisplay("pullRequestProject", display) }),
    togglePullRequestEvent(value) {
      const has = state.pullRequestEvents.includes(value);
      update({
        pullRequestEvents: has
          ? state.pullRequestEvents.filter((e) => e !== value)
          : [...state.pullRequestEvents, value],
      });
    },
    setSessionEvent: (sessionEvent) => update({ sessionEvent }),
    setSessionProject: (value, display) =>
      update({ sessionProjectId: value, displays: withDisplay("sessionProject", display) }),
    setActionKind: (actionKind) => update({ actionKind }),
    setProject: (value, display) =>
      update({ projectId: value, displays: withDisplay("project", display) }),
    setTemplate: (template, display) =>
      update({ template, displays: withDisplay("template", display) }),
    setPrompt: (prompt) => update({ prompt }),
    setSession: (value, display) =>
      update({ agentId: value, displays: withDisplay("session", display) }),
    setNoteText: (noteText) => update({ noteText }),
    setPostToGithub: (postToGithub) => update({ postToGithub }),
    setAllowUnattended: (allowUnattended) => update({ allowUnattended }),
  };
}
