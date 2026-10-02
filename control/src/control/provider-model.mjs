import { sessionDefaults } from "./provider-mode.mjs";
// Bare portable families follow the installed provider's advertised default.
// Explicit model selections are preserved so the provider can validate them.
export async function resolveProviderModel(client, selection, cwd) {
  if (selection.includes("/")) return selection;
  const inventory = await client.providers.listModels(selection, { cwd });
  if (inventory.provider !== selection || inventory.error || !Array.isArray(inventory.models))
    throw Error(
      `Cannot resolve ${selection} default model: ${inventory.error || "provider inventory unavailable"}`,
    );
  const defaults = inventory.models.filter(
    (model) =>
      model.isDefault === true &&
      model.provider === selection &&
      model.isSelectable !== false &&
      typeof model.id === "string" &&
      model.id.trim(),
  );
  if (defaults.length !== 1)
    throw Error(
      `Set providers.${selection} to an explicit provider/model; inventory has no unique default`,
    );
  return `${selection}/${defaults[0].id}`;
}

// DESIGN-NEXT-BUILD A4: never launch a model / effort pair the installed provider does not offer. Only values that a
// role default or an explicit override chose are checked (a creation with neither makes no extra call and is exactly as
// before). A role value the provider does not offer falls back one level -- to what the same creation would have chosen
// without the role -- and the fallback is recorded; an explicit value is refused before anything is created.
const CHECKED = new Set(["role", "override"]);
export async function checkCapability(client, provider, chosen, cwd, withoutRole) {
  const checked = (f) => CHECKED.has(chosen.source?.[f]);
  if (!checked("model") && !checked("thinkingOptionId")) return { chosen, fallback: [] };
  let inventory;
  try {
    inventory = await client.providers.listModels(provider, { cwd });
  } catch (e) {
    inventory = { error: e?.message ?? "unavailable" };
  }
  const models =
    inventory &&
    !inventory.error &&
    inventory.provider === provider &&
    Array.isArray(inventory.models)
      ? inventory.models.filter(
          (m) =>
            m?.provider === provider &&
            m.isSelectable !== false &&
            typeof m.id === "string" &&
            m.id,
        )
      : null;
  let next = chosen,
    lower;
  const fallback = [];
  const below = () => (lower ??= withoutRole());
  const refuse = (what, reason) => {
    throw Error(
      `The installed ${provider} provider does not offer ${what} (${reason}); nothing was created`,
    );
  };
  const drop = (field, reason) => {
    const l = below();
    fallback.push({ field, requested: next[field], used: l[field], reason });
    next = {
      ...next,
      [field]: l[field],
      source: { ...next.source, [field]: l.source[field] },
      ...(field === "model" ? { modelFollowsProviderDefault: !l.model.includes("/") } : {}),
    };
  };
  const modelId = (selection) =>
    selection.includes("/")
      ? selection.slice(selection.indexOf("/") + 1)
      : models?.find((m) => m.isDefault === true)?.id;
  if (!models) {
    for (const f of ["model", "thinkingOptionId"])
      if (CHECKED.has(next.source?.[f])) {
        if (next.source[f] === "override")
          refuse(
            f === "model" ? next.model : `${next.thinkingOptionId} effort`,
            "its model list is unavailable",
          );
        drop(f, "catalog-unavailable");
      }
    return { chosen: next, fallback };
  }
  if (CHECKED.has(next.source?.model) && !models.some((m) => m.id === modelId(next.model))) {
    if (next.source.model === "override") refuse(next.model, "model-not-offered");
    drop("model", "model-not-offered");
  }
  if (CHECKED.has(next.source?.thinkingOptionId)) {
    const entry = models.find((m) => m.id === modelId(next.model));
    const offered = Array.isArray(entry?.thinkingOptions)
      ? entry.thinkingOptions.map((o) => o?.id).filter(Boolean)
      : [];
    if (offered.length && !offered.includes(next.thinkingOptionId)) {
      if (next.source.thinkingOptionId === "override")
        refuse(`${next.thinkingOptionId} effort for ${next.model}`, "effort-not-offered");
      const l = below(),
        used = offered.includes(l.thinkingOptionId)
          ? l.thinkingOptionId
          : offered.includes(entry.defaultThinkingOptionId)
            ? entry.defaultThinkingOptionId
            : offered[0];
      fallback.push({
        field: "thinkingOptionId",
        requested: next.thinkingOptionId,
        used,
        reason: "effort-not-offered",
      });
      next = {
        ...next,
        thinkingOptionId: used,
        source: {
          ...next.source,
          thinkingOptionId:
            used === l.thinkingOptionId ? l.source.thinkingOptionId : "model-default",
        },
      };
    }
  }
  return { chosen: next, fallback };
}

// Update-7 W3: an explicit model / effort is checked against the installed provider's list BEFORE a create reserves,
// spends or journals anything, so an unknown one is a plain refusal rather than an uncertain delivery. The same
// checkCapability refusal, with nothing but the override to check; no explicit value makes no provider call.
export async function checkOverride(client, provider, defaults, cwd) {
  if (!defaults || (defaults.model === undefined && defaults.thinkingOptionId === undefined))
    return;
  await checkCapability(client, provider, sessionDefaults(provider, defaults), cwd, () =>
    sessionDefaults(provider),
  );
}

// Update-7 W3 (gap a): does this host offer the provider at all (a model list with at least one selectable model)?
export async function checkProvider(client, provider, cwd) {
  let inventory;
  try {
    inventory = await client.providers.listModels(provider, { cwd });
  } catch (e) {
    inventory = { error: e?.message ?? "unavailable" };
  }
  const ok =
    inventory &&
    !inventory.error &&
    inventory.provider === provider &&
    Array.isArray(inventory.models) &&
    inventory.models.some(
      (m) =>
        m?.provider === provider && m.isSelectable !== false && typeof m.id === "string" && m.id,
    );
  if (!ok) throw Error(`The installed ${provider} provider is not available`);
}
