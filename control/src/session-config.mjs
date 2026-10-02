import { memoryConfig } from "./runtime.mjs";
import { canonicalMemoryConfig } from "./canonical-memory-route.mjs";
import { sessionDefaults } from "./control/provider-mode.mjs";

// This path used to pin thinkingOptionId 'medium' and its own approval options inline -- the exact
// pattern sessionDefaults replaced, and the reason provider-mode.mjs's "every creation path" comment
// was a claim rather than a fact. `defaults` carries a deliberate caller choice and still wins.
// Thinking came from this path's own inline 'medium', then from a universal DEFAULT_THINKING ('high')
// when it was centralised -- a deliberate behaviour and cost change at the time. It is now per provider
// again and claude is back on 'medium', which is the owner's stated default: a session comes up Medium
// and a task that needs High asks for it. Also deliberate, and also not a side effect of centralising.
export function sessionConfig(provider, defaults = {}) {
  const family = provider.split("/")[0];
  // Kept first, and the reason is narrower than it looks. For a known family with no override,
  // sessionDefaults cannot throw, so either order surfaces a corrupt pin. The load-bearing case is a
  // known family with a REFUSED override and a corrupt pin: this order reports the pin fault, the
  // reverse reports the override and hides it. An unknown family yields the route error either way,
  // because canonicalMemoryConfig checks the family before it verifies the deployment.
  canonicalMemoryConfig(family);
  const chosen = sessionDefaults(family, defaults);
  return {
    provider,
    modeId: chosen.modeId,
    thinkingOptionId: chosen.thinkingOptionId,
    ...(chosen.options ? { options: chosen.options } : {}),
    mcpServers: memoryConfig(),
    toolPolicy: {
      preapproved: ["shared_memory_read", "shared_memory_search"].map((tool) => ({
        kind: "mcp",
        server: "shared-memory",
        tool,
      })),
    },
    systemPrompt:
      "You are a persistent independent Orca trial worker working on an operator-assigned task. Work only on the assigned synthetic non-Git task in your directory. Preserve existing native configuration. Do not contact other sessions, create agents, schedules or publish anything. Shared memory can search current decisions by default; request history or all explicitly for earlier evidence, then read exact sources with expectedSha256. Corpus labels describe location, not authority or freshness. Do not include unrelated personal or workplace context in outputs.",
  };
}
