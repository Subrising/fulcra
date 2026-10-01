import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  canonicalTrustedPayload,
  normalizeTrustedPromptOptions,
} from "./trusted-input.js";

test("canonical bytes preserve Unicode, arrays and representation and sort UTF-16 keys", () => {
  expect(canonicalJson({ z: -0, a: ["é", "\n", 1e30] })).toBe('{"a":["é","\\n",1e+30],"z":0}');
  expect(canonicalJson({ "\uffff": 1, "😀": 2 })).toBe('{"😀":2,"￿":1}');
  const payload = {
    agentId: "11111111-1111-4111-8111-111111111111",
    kind: "prompt" as const,
    messageId: null,
    payload: { type: "prompt" as const, prompt: "hello", options: normalizeTrustedPromptOptions() },
  };
  const bytes = canonicalTrustedPayload(payload);
  expect(bytes).toBe(
    '{"agentId":"11111111-1111-4111-8111-111111111111","kind":"prompt","messageId":null,"payload":{"options":{"activeTurnBehavior":null,"clearPendingPermissions":false,"expectedTurnId":null,"maxThinkingTokens":null,"outputSchema":null,"replaceRunning":null,"resumeFrom":null,"sessionMode":null,"unarchive":null},"prompt":"hello","type":"prompt"},"v":1}',
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "d06fa8846e70af3764b4ee2b3a7a3255288a9a132a370874757a53582b6b2c7c",
  );
});
test("rejects values whose JSON would lose facts without invoking accessors", () => {
  let read = false;
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = 1;
  const accessor = {
    get x() {
      read = true;
      return 1;
    },
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    Symbol(),
    () => 1,
    new Date(),
    sparse,
    { x: undefined },
    accessor,
    cycle,
  ])
    expect(() => canonicalJson(value)).toThrow();
  expect(read).toBe(false);
});
test("command discriminators cannot alias and unknown arguments fail", () => {
  const input = { agentId: "agent", kind: "configure" as const, messageId: null };
  expect(() =>
    canonicalTrustedPayload({
      ...input,
      payload: { type: "command", command: "set-mode", arguments: { modelId: "x" } },
    }),
  ).toThrow();
  expect(() => normalizeTrustedPromptOptions({ invented: true } as never)).toThrow();
});

test("native parent adoption canonical schema binds every identity and old-parent assertion", () => {
  const arguments_ = {
    parentAgentId: "parent",
    expectedParentAgentId: null,
    childNativeSessionId: "child-native",
    parentNativeSessionId: "parent-native",
  };
  const canonical = (args: typeof arguments_) =>
    canonicalTrustedPayload({
      agentId: "child",
      kind: "configure",
      messageId: null,
      payload: { type: "command", command: "adopt-parent", arguments: args },
    });
  expect(canonical(arguments_)).toContain('"command":"adopt-parent"');
  expect(canonical({ ...arguments_, expectedParentAgentId: "old" } as never)).toContain(
    '"expectedParentAgentId":"old"',
  );
  for (const args of [
    { ...arguments_, invented: true },
    { ...arguments_, parentAgentId: 7 },
    { ...arguments_, expectedParentAgentId: false },
    { parentAgentId: "parent" },
  ])
    expect(() => canonical(args as never)).toThrow();
});
