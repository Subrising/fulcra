import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { parseControllerCommand } from "./shared/command-parser.mjs";

// Exercise the actual entry-point mappings, contracts, management context and strict parser.
// Only unrelated services are replaced; no controller, grant store or installed host is invoked.
test("OG1 registered content grant set/list forward strict owner inputs and retain refusal gates", async (t) => {
  const entry = new URL("./index.server.ts", import.meta.url).href;
  const intercom = new URL("./shared/intercom.ts", import.meta.url).href;
  const contract = new URL("./shared/rpc-contract.ts", import.meta.url).href;
  const management = new URL("./server/management-context.mjs", import.meta.url).href;
  const source = stripTypeScriptTypes(await fs.readFile(new URL(entry), "utf8"));
  const modules = new Map();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    if (["./shared/intercom", "./server/management-context.mjs"].includes(match[2])) continue;
    const names = match[1]
      .split(",")
      .map((x) => x.trim().split(/\s+as\s+/)[0])
      .filter(Boolean);
    const prelude =
      modules.get(match[2]) ?? "const noop = new Proxy(function(){return noop}, {get:()=>noop});\n";
    modules.set(
      match[2],
      prelude +
        names
          .map((name) => {
            let value = "noop";
            if (name.endsWith("Rpc")) {
              value = `{name:${JSON.stringify(name)}}`;
            } else if (name === "NotConfigured") {
              value = "class extends Error {}";
            } else if (name === "READ_DEADLINE_MS") {
              value = "1000";
            }
            return `export const ${name} = ${value};`;
          })
          .join("\n"),
    );
  }
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === entry) {
        if (specifier === "./shared/intercom") return { url: intercom, shortCircuit: true };
        if (specifier === "./server/management-context.mjs")
          return { url: management, shortCircuit: true };
        if (modules.has(specifier))
          return {
            url: `data:text/javascript,${encodeURIComponent(modules.get(specifier))}`,
            shortCircuit: true,
          };
      }
      if (context.parentURL === intercom && specifier === "./rpc-contract")
        return { url: contract, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if ([entry, intercom, contract].includes(url)) {
        return {
          format: "module",
          source: stripTypeScriptTypes(requireSource(url)),
          shortCircuit: true,
        };
      }
      return next(url, context);
    },
  });
  // Load hooks are synchronous; capture these exact committed sources before importing.
  const sources = new Map([
    [entry, source],
    [intercom, await fs.readFile(new URL(intercom), "utf8")],
    [contract, await fs.readFile(new URL(contract), "utf8")],
  ]);
  function requireSource(url) {
    return sources.get(url);
  }
  t.after(() => hooks.deregister());
  const { default: contribute } = await import(entry);
  const handlers = new Map();
  const dispose = contribute({
    handle: (rpc, handler, options) => handlers.set(rpc.name, { rpc, handler, options }),
  });
  t.after(dispose);
  const id = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
  const selection = {
    identity: { agentId: id(1), instanceId: id(2), sessionId: "native-fixture", boot: id(3) },
    expectedEpoch: id(4),
    scope: { projectId: id(5), taskId: id(6) },
  };
  const setInput = {
    ...selection,
    messageId: id(7),
    grantId: id(8),
    artifactIds: [id(9)],
    byteBudget: 8192,
    expiresAt: 3600000,
    expectedGrantRevision: null,
    enabled: true,
  };
  const commands = [];
  const owner = {
    management: {
      invoke: async (command) => {
        commands.push(command);
        return { grants: [] };
      },
    },
  };
  for (const [name, method, input] of [
    ["organization.intercom.artifacts.content.set", "artifact-content-owner-set", setInput],
    ["organization.intercom.artifacts.content.list", "artifact-content-owner-list", selection],
  ]) {
    const route = handlers.get(name);
    assert.ok(route);
    assert.equal(route.options, undefined, "owner route must not become delegated handleRead");
    assert.deepEqual(await route.handler(route.rpc.input.parse(input), owner), { grants: [] });
    assert.deepEqual(commands.at(-1), parseControllerCommand({ method, input }));
    for (const context of [
      undefined,
      {},
      { management: { ...owner.management, readOnly: true } },
    ]) {
      const before = commands.length;
      await assert.rejects(async () => route.handler(input, context), /Management unavailable/);
      assert.equal(commands.length, before, "refused invocation must not reach grant dispatch");
    }
    const before = commands.length;
    await assert.rejects(async () => route.handler({ ...input, forgedOwner: true }, owner));
    assert.equal(commands.length, before, "real management parser must refuse extra fields");
  }
  assert.equal(commands.length, 2);
});
