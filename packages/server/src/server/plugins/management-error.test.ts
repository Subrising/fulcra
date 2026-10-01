import { expect, test } from "vitest";
import { managementFailure } from "./management-error.js";
test("IR-6/10 preserves read failures and write uncertainty without serializing internal details", () => {
  for (const code of ["uncertain", "unavailable", "invalid", "expired", "unauthorised"]) {
    const result = managementFailure(Object.assign(Error("private details"), { code }));
    expect(result.code).toBe(code);
    expect(result.error).not.toContain("private details");
    if (code === "unavailable") expect(result.error).not.toMatch(/refused/);
  }
  expect(managementFailure(Error("pre-dispatch refusal")).code).toBe("refused");
});

import { ControllerFrameError, parseControllerReply } from "./controller-frames.js";
test("owned invalid refusal preserves only its validated public message", () => {
  const reply = parseControllerReply({
    id: "test",
    epoch: "11111111-1111-4111-8111-111111111111",
    ok: false,
    code: "invalid",
    message: "Unresolved work must be reconciled before leadership transfer",
  });
  if (reply.ok) throw Error("expected refusal");
  const failure = new ControllerFrameError(reply.code, reply.message);
  expect(managementFailure(failure).error).toBe(reply.message);
  expect(
    managementFailure(
      Object.assign(Error("private details"), { code: "invalid", publicMessage: "spoofed" }),
    ).error,
  ).toBe("Management invalid");
  expect(managementFailure(new ControllerFrameError("uncertain", "private details")).error).toBe(
    "Management outcome uncertain; do not replay",
  );
});
