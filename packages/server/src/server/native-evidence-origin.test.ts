import { expect, test, vi } from "vitest";
import {
  beginNativeEvidence,
  publishNativeEvidence,
  registerNativeEvidenceSink,
  nativeEvidenceDigest,
} from "./native-evidence-origin.js";
const completion = {
  id: "completion",
  threadId: "thread",
  turnId: "turn",
  kind: "command_result" as const,
  bodyHash: nativeEvidenceDigest({ native: "ack" }),
};
const fact = { kind: "command_result", basis: "native_provider_ack", exitCode: 0 };
test("native evidence private origin denies forged handle and duplicate/conflicting completion", async () => {
  const provider = {};
  const publish = vi.fn(async () => {});
  const prepare = vi.fn(async () => true);
  registerNativeEvidenceSink(provider, () => ({ prepare, publish, requireCurrent: () => {} }));
  expect(() => publishNativeEvidence({}, fact)).toThrow("Private");
  const handle = await beginNativeEvidence(provider, completion, () => {});
  expect(handle).toBeDefined();
  await publishNativeEvidence(handle!, fact);
  expect(() => publishNativeEvidence(handle!, fact)).toThrow("Private");
  await expect(beginNativeEvidence(provider, completion, () => {})).rejects.toThrow(
    "already observed",
  );
  await expect(
    beginNativeEvidence(
      provider,
      { ...completion, bodyHash: nativeEvidenceDigest({ changed: true }) },
      () => {},
    ),
  ).rejects.toThrow("conflict");
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});
test("native evidence rechecks provider after held durable preparation and never retries refusal", async () => {
  let finish!: () => void;
  let current = true;
  const provider = {};
  const publish = vi.fn(async () => {});
  registerNativeEvidenceSink(provider, () => ({
    prepare: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return true;
    },
    requireCurrent: () => {},
    publish,
  }));
  const attempt = beginNativeEvidence(provider, completion, () => {
    if (!current) throw new Error("replaced");
  });
  current = false;
  finish();
  await expect(attempt).rejects.toThrow("replaced");
  current = true;
  await expect(beginNativeEvidence(provider, completion, () => {})).rejects.toThrow(
    "already observed",
  );
  expect(publish).not.toHaveBeenCalled();
});
test("native evidence prior durable attempt refuses effect and unregistered provider has no origin", async () => {
  const provider = {};
  registerNativeEvidenceSink(provider, () => ({
    requireCurrent: () => {},
    prepare: async () => false,
    publish: async () => {
      throw new Error("effect");
    },
  }));
  await expect(beginNativeEvidence(provider, completion, () => {})).rejects.toThrow(
    "already attempted",
  );
  expect(await beginNativeEvidence({}, completion, () => {})).toBeUndefined();
});
