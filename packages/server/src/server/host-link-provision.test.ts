import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { prepare, apply, provisioningError } from "../../../../scripts/provision-host-link.js";

import { windowsAclIsSafe } from "./plugins/trusted-ownership.js";
vi.mock("./windows-private-file.js", async (original) => ({
  ...(await original<typeof import("./windows-private-file.js")>()),
  assertWindowsPrivateFilesSettled: vi.fn(),
}));
vi.mock("./plugins/trusted-ownership.js", async (original) => ({
  ...(await original<typeof import("./plugins/trusted-ownership.js")>()),
  windowsAclIsSafe: vi.fn(() => true),
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const plan = {
  sourceServerId: "source",
  targetServerId: "target",
  leadId: "lead",
  linkId: "pc",
  url: "https://pc.example.test",
  expiresAt: 2000000000000,
  workspace: "job",
  directory: "D:\\jobs",
  profile: "haiku",
  maxWorkers: 1,
  worker: {
    provider: "claude" as const,
    model: "claude-haiku-5-5",
    modeId: "bypassPermissions",
    parents: ["claude:bypassPermissions"],
  },
};
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "provision-host-link-"));
  roots.push(root);
  const output = path.join(root, "pair");
  prepare(plan, output);
  const read = (name: string) =>
    JSON.parse(readFileSync(path.join(output, `${name}.json`), "utf8"));
  return { root, output, source: read("source"), target: read("target") };
}
test.skipIf(process.platform === "win32")(
  "prepares matching random credentials and preserves existing grants",
  () => {
    const f = fixture();
    expect(f.source.outgoing[0].token).toMatch(/^hlink1\.[A-Za-z0-9_-]{43}$/);
    expect(f.source.outgoing[0].token).toBe(f.target.incoming[0].token);
    expect(f.source.chats[0].token).toMatch(/^hchat1\.[A-Za-z0-9_-]{43}$/);
    expect(f.source.outgoing[0].token.slice(7)).not.toBe(f.source.chats[0].token.slice(7));
    expect(statSync(f.output).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(f.output, "target.json")).mode & 0o777).toBe(0o600);
    const home = path.join(f.root, "home");
    apply(home, f.source);
    const file = path.join(home, "host-links.json");
    const before = readFileSync(file, "utf8");
    expect(() => apply(home, f.source)).toThrow("The link already exists");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => prepare(plan, f.output)).toThrow();
    const other = fixture();
    expect(other.source.outgoing[0].token).not.toBe(f.source.outgoing[0].token);
    other.source.outgoing[0].id = "second";
    other.source.chats[0].links = ["second"];
    other.source.routes = {};
    apply(home, other.source);
    const merged = JSON.parse(readFileSync(file, "utf8"));
    expect(merged.chats[0].token).toBe(f.source.chats[0].token);
    expect(merged.chats[0].links).toEqual(["pc", "second"]);
    expect(merged.routes).toEqual({ standard: "pc" });
  },
);
test.skipIf(process.platform === "win32")(
  "refuses invalid grants and a public destination file",
  () => {
    const f = fixture();
    const home = path.join(f.root, "home");
    apply(home, f.source);
    const file = path.join(home, "host-links.json");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, before, { mode: 0o600 });
    expect(() =>
      apply(home, {
        ...f.target,
        machine: "mac",
        incoming: [{ ...f.target.incoming[0], token: "invalid" }],
      }),
    ).toThrow("Host-link configuration is invalid");
    expect(readFileSync(file, "utf8")).toBe(before);
    chmodSync(file, 0o644);
    expect(() => apply(home, { ...f.source, outgoing: [], chats: [] })).toThrow(
      "A private owner file is required.",
    );
    expect(readFileSync(file, "utf8")).toBe(before);
  },
);

test("provisioning error types exclude paths and credentials", () => {
  expect(
    provisioningError(new Error("The link already exists. Reconcile the retained configuration.")),
  ).toBe("link already exists");
  expect(provisioningError(new Error("Host-link configuration is invalid."))).toBe(
    "invalid config or input",
  );
  expect(provisioningError(new Error("private-path synthetic-secret"))).toBe(
    "invalid config or input",
  );
  expect(provisioningError(Object.assign(new Error("private-path"), { code: "ENOENT" }))).toBe(
    "input not found",
  );
});

test.skipIf(process.platform === "win32")(
  "provisioning refuses an existing Windows file with an unsafe ACL",
  () => {
    const f = fixture();
    const home = path.join(f.root, "home");
    apply(home, f.source);
    const platform = process.platform;
    vi.mocked(windowsAclIsSafe).mockReturnValue(false);
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(() => apply(home, { ...f.source, outgoing: [], chats: [] })).toThrow(
        "A private owner file is required.",
      );
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
      vi.mocked(windowsAclIsSafe).mockReturnValue(true);
    }
  },
);
