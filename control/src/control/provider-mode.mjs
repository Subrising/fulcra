import { portable } from "../portable-config.mjs";
import { installationConfig } from "./installation-settings.mjs";
import { SESSION_ROLES } from "../config.mjs";
import {
  readRoleDefaults,
  configuredRoleProvider,
  chosenModes,
  DEFAULT_ROLES,
  SEED,
} from "../../orca-organization/server/role-defaults-store.mjs";
// Update-7: the persisted role defaults (Settings -> Accounts & Defaults; their own file, L44) over the shared config's
// defaults.roles. A role entry for one provider: { model?, thinkingOptionId? } with only the values set.
function storedRoleEntry(config, role, provider, configuredRoles) {
  try {
    if (!config?.home) return undefined;
    const e = readRoleDefaults(config.home, configuredRoles ?? null).roles?.[role]?.[provider];
    if (!e) return undefined;
    const out = {};
    if (e.model) out.model = e.model;
    if (e.thinkingOptionId) out.thinkingOptionId = e.thinkingOptionId;
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}
// One capability-aware selector for every creation path, so they cannot drift apart. The facts below are
// read from the pinned runtime's own AGENT_PROVIDER_DEFINITIONS, not invented:
//
//   claude  plan | default | acceptEdits | auto | bypassPermissions      product default: auto
//   codex   auto | auto-review | full-access                             product default: auto-review
//
// Claude's `auto` is the classifier mode: "Uses a model classifier to review permission prompts
// automatically". It is NOT bypassPermissions, which the runtime itself marks dangerous and unattended.
// Codex has no classifier mode. Its closest SUPPORTED automatic policy is `auto-review`, which keeps the
// same workspace-write permissions as its default and routes eligible on-request approvals through the
// auto-reviewer subagent. `full-access` is refused here: it would broaden filesystem and network access to
// imitate another provider, which is a security change dressed as a mode change.
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
// Validation walks OWN properties (Object.entries), so every read of a configured value must too.
// They disagreed: configuredDefaults validated `modes` with Object.entries while sessionDefaults read
// `configured.modes?.[provider]` through the prototype chain, so a polluted Object.prototype supplied a
// mode validation had never seen and REFUSED was bypassed outright. Own-only reads make the set of values
// that can be used exactly the set that was checked.
const own = (o, key) =>
  o !== null && typeof o === "object" && Object.hasOwn(o, key) ? o[key] : undefined;
// Refused for their own stated reason rather than incidentally. The unknown-key allowlist below already
// rejects these, because JSON.parse makes `__proto__` an own property -- but that is a property of the
// allowlist's current shape, and widening it later must not quietly remove this.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function assertSafeKeys(value, where) {
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key))
      throw Error(
        `Refused key ${key} in ${where}: session defaults may not name prototype members`,
      );
  }
}
const ASK_TOOL = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// An ask list can only ADD prompts, so unlike a mode it needs no refusal list. What it needs is to be
// visible, because it is configured ALONGSIDE the mode rather than instead of it: a session can carry an
// automatic mode and an ask list at the same time, which is what a stale pin from an older creation looks
// like when someone reads only the mode.
//
// Deliberately NOT a claim about precedence. The claude adapter validates settings.permissions.ask as a
// schema and merges it forward; nothing available here decides whether an ask rule or the classifier wins
// at prompt time -- that lives inside Claude Code, which is neither in this repository nor in the adapter.
// State the configuration, not the runtime.
function validateAsk(value, where) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 64) throw Error(`Invalid ask list in ${where}`);
  if (value.some((tool) => typeof tool !== "string" || !ASK_TOOL.test(tool)))
    throw Error(`Invalid tool name in ${where} ask list`);
  if (new Set(value).size !== value.length) throw Error(`Duplicate tool in ${where} ask list`);
  return value;
}
// N2-def: the pins are emitted explicitly and derived from the chosen mode, not hardcoded, so they stay
// consistent if a deliberate override selects a different supported mode. The values mirror the codex
// adapter's own MODE_PRESETS table (codex-app-server-agent.js), and the test extracts that table from the
// adapter source and asserts the match -- so this cannot drift from the adapter by transcription.
export const CODEX_MODE_OPTIONS = {
  "read-only": { approval_policy: "on-request", sandbox_mode: "read-only" },
  auto: { approval_policy: "on-request", sandbox_mode: "workspace-write" },
  "auto-review": { approval_policy: "on-request", sandbox_mode: "workspace-write" },
  "full-access": { approval_policy: "never", sandbox_mode: "danger-full-access" },
};
// A model SELECTION, in the two-valued shape resolveProviderModel (provider-model.mjs) reads: a bare
// family means "ask the installed provider for the model it advertises as its default and use that", and
// anything containing a slash is an explicit pin passed through untouched for the provider to validate.
//
// claude is deliberately BARE. The creation path used to inline 'claude/claude-opus-5', which is an
// explicit pin, so resolveProviderModel returned it verbatim and the host's own isDefault -- the thing an
// operator configures in config.json agents.providers.claude.additionalModels -- was never consulted.
// Every controller-created session came up on whatever that literal named, no matter what the host
// advertised. A bare family is the only value that tracks the host instead of freezing a release.
//
// codex keeps an explicit pin, and the asymmetry is the honest part rather than an oversight: this
// controller has verified that claude's inventory carries exactly one isDefault, and has NOT verified the
// same for codex. resolveProviderModel throws when the default is not unique, so making codex bare would
// trade a stale-but-working pin for a creation path that can fail. An installation that wants codex to
// follow its host sets `defaults.models.codex` to 'codex'.
const DEFAULT_MODELS = { claude: "claude", codex: "codex/gpt-6-astra" };
// The default thinking level, per provider, because the right answer is not the same for both.
//
// claude is 'medium', and this is a deliberate reversal of an earlier deliberate change. The owner's
// instruction is that a session should come up Opus 5.5 / Medium / Auto with no action, and that High is
// what a task ASKS FOR when it needs it rather than what everything pays for by default. A universal
// 'high' made every routine worker session cost and think like a hard one. High stays selectable at every
// layer above this: a per-spawn override, an installation setting, or the app's own effort control.
//
// codex keeps 'high'. Its effort scale is not claude's and nothing in this task measured it, so aligning
// it here would be a cost and behaviour change nobody asked for, dressed as consistency.
const DEFAULT_THINKING_BY_PROVIDER = { claude: "medium", codex: "high" };
export const CAPABILITIES = {
  claude: {
    automaticModeId: "auto",
    kind: "classifier",
    defaultModel: DEFAULT_MODELS.claude,
    defaultThinkingOptionId: DEFAULT_THINKING_BY_PROVIDER.claude,
    detail:
      "Auto mode routes permission prompts through a model classifier. It is not bypassPermissions and does not skip prompts.",
  },
  codex: {
    automaticModeId: "full-access",
    kind: "full-access",
    defaultModel: DEFAULT_MODELS.codex,
    defaultThinkingOptionId: DEFAULT_THINKING_BY_PROVIDER.codex,
    detail:
      "Codex has no classifier mode. New Codex sessions default to full-access (the owner's instruction): no approval prompts, no sandbox. auto-review (workspace-write, eligible approvals routed through the auto-reviewer subagent) and auto stay selectable.",
  },
};
// Bounded the same way the ask list is: a selection reaches an exec line, so it may not carry shell or
// path structure. The family must match the provider it is configured under, because a selection that
// names another provider's family would be resolved by that provider's inventory or rejected far away
// from the file that set it.
const MODEL_SELECTION = /^[a-z][a-z0-9-]{0,31}(\/[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63})?$/;
function validateModel(value, provider, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !MODEL_SELECTION.test(value))
    throw Error(`Invalid model selection in ${where}`);
  if (value.split("/")[0] !== provider)
    throw Error(`Model selection in ${where} must name the ${provider} family`);
  return value;
}
// Update-7 W3: the model / effort a tool call names (manager_create_worker, role_start_session, the management create),
// as the per-spawn override sessionDefaults reads. A bare id is this provider's; a prefixed one must be. Anything left
// out is filled by the role default at creation. Whether the provider actually lists it is checkOverride's question.
export function explicitSelection(provider, { model, effort } = {}) {
  const out = {};
  if (model !== undefined) {
    const id = typeof model === "string" ? model.trim() : "";
    const full = id.includes("/") ? id : `${provider}/${id}`;
    if (!id || !MODEL_SELECTION.test(full) || !full.includes("/"))
      throw Error(`${String(model).slice(0, 80)} is not a model name`);
    if (full.split("/")[0] !== provider) throw Error(`${full} is not a ${provider} model`);
    out.model = full;
  }
  if (effort !== undefined) {
    if (!THINKING.includes(effort))
      throw Error(`${String(effort).slice(0, 40)} is not an effort (${THINKING.join(", ")})`);
    out.thinkingOptionId = effort;
  }
  return Object.keys(out).length ? out : undefined;
}
// Update-7 W3 (owner, 01:29Z: "the default should be auto-mode/full-access"): Codex full-access is no longer refused; it
// is the default for new Codex sessions. Claude's bypassPermissions stays refused: Claude's automatic mode is `auto`
// (the classifier), so bypass is never needed to avoid prompts. Fulcra's own approval layer (W2) keeps escalating the
// dangerous classes.
export const REFUSED = { claude: ["bypassPermissions"], codex: [] };
// The runtime's unattended modes the owner has explicitly approved as selectable (and default). Every OTHER unattended
// mode must be refused; provider-mode.test.mjs asserts REFUSED + this equals the runtime's unattended set exactly.
export const OWNER_APPROVED_UNATTENDED = Object.freeze({
  claude: Object.freeze([]),
  codex: Object.freeze(["full-access"]),
});
// The provider's own mode ids, from the same AGENT_PROVIDER_DEFINITIONS the comment at the top of this
// file quotes. REFUSED is a denylist and cannot answer "is this a mode at all": codex is saved from an
// invented mode only incidentally, because an unknown one has no sandbox and approval pins to look up,
// while claude deliberately emits no options and so had nothing to fail on. A typo in a settings file --
// `autoo` -- was accepted and handed to session creation as a mode.
//
// A COPY, deliberately. This module must work on an installation that does not have the adapter, so it
// cannot read the definitions at runtime. provider-mode.test.mjs asserts this equals the adapter's own
// list, so a runtime that adds or renames a mode fails that test rather than diverging quietly. That test
// SKIPS where the adapter is absent, so on a portable installation this table is enforced but unverified
// -- the honest limit of the copy, and the reason the assertion exists at all.
// Codex is the INTERSECTION of the adapter's two sources, and bounding it by the pins alone -- which is
// what this said before -- over-admitted a mode that does not exist. The two sources answer different
// questions: AGENT_PROVIDER_DEFINITIONS answers "is this id a mode the provider accepts at all", and
// MODE_PRESETS answers "what options to send once a mode is chosen". Neither is authoritative alone.
//
// `read-only` is a MODE_PRESETS key with NO definition entry -- a preset, not a selectable mode -- so pins
// alone admit it and the provider would not. `full-access` is in BOTH adapter sources; its absence from
// CODEX_MODE_OPTIONS above is our own policy, not a disagreement in the adapter. The test asserts this
// list equals definitions-intersect-pins, so a change in either source fails there rather than freezing
// today's disagreement as though it were correct.
export const SUPPORTED_MODES = {
  claude: ["plan", "default", "acceptEdits", "auto", "bypassPermissions"],
  codex: ["auto", "auto-review", "full-access"],
};
// What an operator may actually choose: supported by the provider and not refused here. Naming the full
// supported set in an error would tell them bypassPermissions is available when this controller refuses it.
export const selectableModes = (provider) =>
  (own(SUPPORTED_MODES, provider) ?? []).filter((m) => !own(REFUSED, provider)?.includes(m));
// Checked AFTER the refusal at every site, so a refused-but-real mode keeps its own explanation.
function assertSupported(provider, modeId) {
  if (own(SUPPORTED_MODES, provider)?.includes(modeId)) return;
  throw Error(
    `Unsupported mode for ${provider}: ${modeId}. Selectable modes are ${selectableModes(provider).join(", ")}`,
  );
}
// The fallback for a provider whose capability names no default of its own. It is NOT the answer for
// claude or codex any more -- both name one (DEFAULT_THINKING_BY_PROVIDER) -- and a single universal
// value was the thing that made every claude session 'high'. Kept, and kept exported, because a provider
// added later still needs a defined answer before anyone has measured what it should be.
export const DEFAULT_THINKING = "high";
// Optional, so an installation that sets nothing keeps the product defaults above.
//
// Deliberately whole-file, not per-provider: the entire `modes` map is validated before any provider
// is selected, so a config naming a refused mode for claude also refuses a codex spawn. That is chosen,
// not incidental -- a settings file that asks for a refused mode is a file an operator must fix, and
// letting the providers it does not name spawn normally would leave the dangerous entry sitting there
// unnoticed. Do not 'fix' this into a per-provider check.
//
// Shared by the portable config.json and by session-defaults.json, so the messages below name neither.
// installationConfig attaches the actual file path when the settings came from a file.
export function configuredDefaults(config = portable) {
  const d = config?.defaults;
  if (d === undefined) return {};
  assertSafeKeys(d, "session defaults");
  assertSafeKeys(d?.modes, "session mode defaults");
  assertSafeKeys(d?.ask, "session ask defaults");
  assertSafeKeys(d?.models, "session model defaults");
  // assertSafeKeys above refuses prototype members by name, so nothing here rides on rejecting unknown keys.
  // L44: keys this build does not know (a newer build's settings) are ignored, as config.mjs does; the ones it reads
  // below are validated as before.
  if (!d || typeof d !== "object" || Array.isArray(d)) throw Error("Invalid session defaults");
  if (d.thinkingOptionId !== undefined && !THINKING.includes(d.thinkingOptionId))
    throw Error("Unsupported thinking option in session defaults");
  if (d.modes !== undefined) {
    if (!d.modes || typeof d.modes !== "object" || Array.isArray(d.modes))
      throw Error("Invalid session mode defaults");
    for (const [provider, modeId] of Object.entries(d.modes)) {
      if (!Object.hasOwn(CAPABILITIES, provider))
        throw Error(`Unknown provider in portable session mode defaults: ${provider}`);
      if (typeof modeId !== "string" || !modeId)
        throw Error("Invalid mode in portable session mode defaults");
      // An installation may choose a different supported mode, but never one this controller refuses.
      if (REFUSED[provider].includes(modeId))
        throw Error(
          `Refused mode for ${provider}: ${modeId} broadens access rather than automating approval`,
        );
      assertSupported(provider, modeId);
    }
  }
  if (d.ask !== undefined) {
    if (!d.ask || typeof d.ask !== "object" || Array.isArray(d.ask))
      throw Error("Invalid ask defaults in session defaults");
    for (const [provider, list] of Object.entries(d.ask)) {
      if (!Object.hasOwn(CAPABILITIES, provider))
        throw Error(`Unknown provider in session ask defaults: ${provider}`);
      // Codex has no ask list -- its approval policy IS its mode -- so accepting one would record a
      // setting that is silently dropped at creation.
      if (provider !== "claude")
        throw Error(`${provider} has no ask list; its approval policy is its mode`);
      validateAsk(list, "session ask defaults");
    }
  }
  // Whole-file, for the same reason `modes` is: a selection this controller cannot parse is a file an
  // operator must fix, and letting the providers it does not name spawn normally leaves the broken entry
  // sitting there unnoticed until the provider it does name is next created.
  if (d.models !== undefined) {
    if (!d.models || typeof d.models !== "object" || Array.isArray(d.models))
      throw Error("Invalid model defaults in session defaults");
    for (const [provider, selection] of Object.entries(d.models)) {
      if (!Object.hasOwn(CAPABILITIES, provider))
        throw Error(`Unknown provider in session model defaults: ${provider}`);
      validateModel(selection, provider, "session model defaults");
    }
  }
  // DESIGN-NEXT-BUILD A2: role defaults, whole-file for the same reason as `modes` and `models`.
  if (d.roles !== undefined) {
    assertSafeKeys(d.roles, "session role defaults");
    if (!d.roles || typeof d.roles !== "object" || Array.isArray(d.roles))
      throw Error("Invalid role defaults in session defaults");
    for (const [role, entry] of Object.entries(d.roles)) {
      if (!SESSION_ROLES.includes(role))
        throw Error(`Unknown role in session role defaults: ${role}`);
      assertSafeKeys(entry, `session role defaults ${role}`);
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        Object.keys(entry).some((k) => !["provider", "claude", "codex"].includes(k))
      )
        throw Error(`Invalid role defaults for ${role}`);
      if (entry.provider !== undefined && !Object.hasOwn(CAPABILITIES, entry.provider))
        throw Error(`Unknown provider in role defaults for ${role}: ${entry.provider}`);
      for (const provider of Object.keys(CAPABILITIES)) {
        const x = own(entry, provider);
        if (x === undefined) continue;
        assertSafeKeys(x, `session role defaults ${role}.${provider}`);
        if (
          !x ||
          typeof x !== "object" ||
          Array.isArray(x) ||
          Object.keys(x).some((k) => !["model", "thinkingOptionId", "modeId"].includes(k))
        )
          throw Error(`Invalid role defaults for ${role}.${provider}`);
        validateModel(own(x, "model"), provider, `role defaults for ${role}`);
        if (own(x, "thinkingOptionId") !== undefined && !THINKING.includes(x.thinkingOptionId))
          throw Error(`Unsupported thinking option in role defaults for ${role}.${provider}`);
        const modeId = own(x, "modeId");
        if (modeId !== undefined) {
          if (REFUSED[provider].includes(modeId))
            throw Error(
              `Refused mode for ${provider}: ${modeId} broadens access rather than automating approval`,
            );
          assertSupported(provider, modeId);
        }
      }
    }
  }
  return d;
}
// Update-7 W3 (gap a): the role default's provider (the seed Settings shows before any choice), used when a create names
// no provider and none was chosen for the role. The controller checks this host offers it before anything is reserved.
export function roleDefaultProvider(role) {
  return role && DEFAULT_ROLES.includes(role) ? (SEED[role]?.provider ?? null) : null;
}
// DESIGN-NEXT-BUILD A3 (prime Q1): the provider a role prefers, used only when the caller names none.
export function roleProvider(role, config = installationConfig()) {
  if (role === undefined || role === null) return null;
  if (!DEFAULT_ROLES.includes(role)) throw Error(`Unknown session role ${role}`);
  try {
    if (config?.home) {
      const p = configuredRoleProvider(config.home, configuredDefaults(config).roles ?? null, role);
      if (p) return p;
    }
  } catch {}
  return own(own(configuredDefaults(config).roles, role), "provider") ?? null;
}
// The single answer every creation path uses. `override` carries a deliberate caller choice, which wins. `role`
// (DESIGN-NEXT-BUILD A2) says what the session is for; its configured entry for this provider sits between the
// override and the installation setting. No role, or no entry for this provider, is exactly the previous answer.
export function sessionDefaults(
  provider,
  override = {},
  config = installationConfig(),
  role = null,
) {
  // Own key, not a raw index. CAPABILITIES['__proto__'] is Object.prototype and CAPABILITIES['constructor']
  // is the Object constructor -- both truthy, so a prototype-named provider passed this check and then died
  // at REFUSED[provider].includes with a message telling an operator nothing.
  const capability = own(CAPABILITIES, provider);
  if (!capability) throw Error(`No automatic mode is known for provider ${provider}`);
  // The override is caller-supplied and read the same way: own properties only. It reaches here from an
  // operator RPC, so it is exactly as exposed to a polluted prototype as the installation config is.
  const overrideMode = own(override, "modeId"),
    overrideThinking = own(override, "thinkingOptionId"),
    overrideAsk = own(override, "ask"),
    overrideModel = own(override, "model");
  if (REFUSED[provider].includes(overrideMode))
    throw Error(
      `Refused mode for ${provider}: ${overrideMode} broadens access rather than automating approval`,
    );
  // Name the file the operator edited. A portable installation keeps its settings in config.json, so the
  // two sources report the two real paths rather than one generic message.
  const origin = config?.path ?? (config?.home ? config.home + "/config.json" : null);
  let configured;
  try {
    configured = configuredDefaults(config);
  } catch (e) {
    throw origin ? Error(`Unusable session defaults at ${origin}: ${e.message}`) : e;
  }
  const configuredMode = own(configured.modes, provider),
    configuredThinking = own(configured, "thinkingOptionId");
  const configuredModel = own(configured.models, provider) ?? null;
  if (role !== null && role !== undefined && !DEFAULT_ROLES.includes(role))
    throw Error(`Unknown session role ${role}`);
  const roleEntry = role
    ? (storedRoleEntry(config, role, provider, configured.roles) ??
      own(own(configured.roles, role), provider))
    : undefined;
  const roleModel = own(roleEntry, "model") ?? null,
    roleMode = own(roleEntry, "modeId"),
    roleThinking = own(roleEntry, "thinkingOptionId");
  // Validated here too, not only in configuredDefaults: the override arrives from an operator RPC and has
  // never been through the file validator, and the product default is the one value that must be a
  // selection this controller would itself accept.
  const model =
    validateModel(overrideModel, provider, "the per-spawn override") ??
    roleModel ??
    configuredModel ??
    validateModel(capability.defaultModel, provider, `the ${provider} product default`);
  // Update-7 W3: a mode chosen in Settings (the Fulcra-owned store) sits above the shared config's defaults.modes.
  let settingsMode;
  try {
    settingsMode = config?.home ? own(chosenModes(config.home), provider) : undefined;
  } catch {
    settingsMode = undefined;
  }
  const modeId =
    overrideMode ?? roleMode ?? settingsMode ?? configuredMode ?? capability.automaticModeId;
  const thinkingOptionId =
    overrideThinking ??
    roleThinking ??
    configuredThinking ??
    capability.defaultThinkingOptionId ??
    DEFAULT_THINKING;
  if (!THINKING.includes(thinkingOptionId))
    throw Error(`Unsupported thinking option ${thinkingOptionId}`);
  // The refusal applied to whatever was finally chosen, not only to the places a value can come from
  // today. Every other check above guards one source; this one guards the answer.
  if (REFUSED[provider].includes(modeId))
    throw Error(
      `Refused mode for ${provider}: ${modeId} broadens access rather than automating approval`,
    );
  // Guards the answer, so the override and the product default are covered without a third site.
  assertSupported(provider, modeId);
  // Claude emits no options by default: the old hardcoded ask Write/Edit pin was the opposite of automatic
  // approval and dropping it was the intent. An installation or a caller may still ask for one back, which
  // is a deliberate, recorded choice rather than an invisible inherited pin.
  const askOverride = validateAsk(overrideAsk, "the per-spawn override");
  if (provider !== "claude" && askOverride)
    throw Error(`${provider} has no ask list; its approval policy is its mode`);
  const configuredAsk = own(configured.ask, provider) ?? null;
  const resolved = askOverride ?? configuredAsk;
  // An explicitly empty list means "no ask pin"; it keeps its provenance but emits no options.
  const ask = provider === "claude" && resolved?.length ? resolved : null;
  // Same reason, and this one silently discarded a guarantee rather than failing: a raw index gave
  // '__proto__' Object.prototype and 'constructor' the Object constructor FUNCTION, both truthy, so the
  // refusal below never fired and a codex session spawned carrying no sandbox_mode or approval_policy at
  // all -- JSON.stringify drops a function, so nothing downstream could see it either.
  //
  // Validated against the known modes rather than by rejecting inherited names: a denylist would encode
  // today's object model into a security check, and 'prototype' already showed the list is not the point
  // (an object literal inherits __proto__ and constructor but has no prototype). Anything not in the table
  // refuses, exactly as an ordinary unknown mode does.
  const options =
    provider === "codex"
      ? own(CODEX_MODE_OPTIONS, modeId)
      : ask
        ? { settings: { permissions: { ask } } }
        : undefined;
  // Backstop, now unreachable: assertSupported bounds codex by these very keys. Kept for the day someone
  // makes SUPPORTED_MODES.codex explicit again and the two tables can drift apart.
  if (provider === "codex" && !options)
    throw Error(`No sandbox and approval pins are known for codex mode ${modeId}`);
  return {
    modeId,
    thinkingOptionId,
    model,
    ...(options ? { options } : {}),
    ask,
    // True when the selection names no model, i.e. the session will take whatever the installed provider
    // advertises as its default. Reported rather than inferred from the absence of a slash, because a
    // caller reading `model: 'claude'` should not have to know that parsing rule to see what it means.
    modelFollowsProviderDefault: !model.includes("/"),
    // What was actually chosen and why, so a caller reads the effective setting rather than inferring it.
    source: {
      modeId: overrideMode
        ? "override"
        : roleMode
          ? "role"
          : settingsMode || configuredMode
            ? "installation"
            : "product-default",
      thinkingOptionId: overrideThinking
        ? "override"
        : roleThinking
          ? "role"
          : configuredThinking
            ? "installation"
            : "product-default",
      ask: askOverride ? "override" : configuredAsk ? "installation" : "product-default",
      model: overrideModel
        ? "override"
        : roleModel
          ? "role"
          : configuredModel
            ? "installation"
            : "product-default",
    },
    role: role ?? null,
    // True when an ask list is configured together with the provider's automatic mode. The name says only
    // that, because only that is known here: which of the two wins at prompt time is decided inside
    // Claude Code, not in this repository and not in the provider adapter. An earlier name claimed the
    // runtime behaviour while the documentation claimed the configuration; the name is what a caller
    // reads, so it is the one that had to be right.
    askConfiguredWithAutomatic: Boolean(ask) && modeId === capability.automaticModeId,
    automatic: modeId === capability.automaticModeId,
    kind: capability.kind,
    detail: capability.detail,
  };
}
