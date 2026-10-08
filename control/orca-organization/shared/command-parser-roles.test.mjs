// FULCRA(light-role): the plugin's create path carries every role the controller accepts.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseControllerCommand } from "./command-parser.mjs";
import { DEFAULT_ROLES } from "../server/role-defaults-store.mjs";

const create = (role) => ({
  messageId: randomUUID(),
  taskId: randomUUID(),
  provider: "claude",
  title: "Summarise the build",
  role,
});

test("create and management-prepare accept every controller role, and refuse an unknown one", () => {
  for (const role of DEFAULT_ROLES) {
    assert.equal(parseControllerCommand({ method: "create", input: create(role) }).input.role, role);
    const { messageId, ...body } = create(role);
    const prepared = parseControllerCommand({
      method: "management-prepare",
      input: { kind: "create", messageId, body },
    });
    assert.equal(prepared.input.body.role, role);
  }
  assert.throws(() => parseControllerCommand({ method: "create", input: create("reviewer") }));
});
