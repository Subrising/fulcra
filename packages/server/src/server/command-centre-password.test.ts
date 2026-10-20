import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isBearerTokenValidAsync } from "./auth.js";
import {
  COMMAND_CENTRE_PASSWORD_FILE_NAME,
  readCommandCentrePasswordFile,
  resolveCommandCentreAuth,
} from "./command-centre-password.js";

const SECRET = "fake-only-shared-secret-0123456789";
let dir: string;
let file: string;

function writeSecret(content: string) {
  writeFileSync(file, content, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cc-password-"));
  file = path.join(dir, COMMAND_CENTRE_PASSWORD_FILE_NAME);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readCommandCentrePasswordFile", () => {
  test("returns the trimmed password of a valid file", () => {
    writeSecret(`${SECRET}\r\n`);
    expect(readCommandCentrePasswordFile(file)).toBe(SECRET);
  });

  test("a missing file is null only when allowed", () => {
    expect(readCommandCentrePasswordFile(file, { allowMissing: true })).toBeNull();
    expect(() => readCommandCentrePasswordFile(file)).toThrow(/unreadable/);
  });

  test.each([
    ["empty", "", /empty/],
    ["whitespace", "  \n\t\n", /empty/],
    ["too short", "short-secret", /shorter than 16/],
    ["inner whitespace", "fake-only secret-0123456789", /whitespace/],
    ["too long", "x".repeat(1025), /too long/],
  ])("refuses a %s file and never shows its content", (_name, content, reason) => {
    writeSecret(content);
    let message = "";
    try {
      readCommandCentrePasswordFile(file, { allowMissing: true });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(reason);
    expect(message).toContain(file);
    if (content.trim()) expect(message).not.toContain(content.trim());
  });

  test("refuses a directory", () => {
    mkdirSync(file);
    expect(() => readCommandCentrePasswordFile(file, { allowMissing: true })).toThrow(/not a file/);
  });

  test.skipIf(process.platform === "win32")("refuses a file other users can read", () => {
    writeSecret(SECRET);
    chmodSync(file, 0o644);
    expect(() => readCommandCentrePasswordFile(file)).toThrow(/readable by other users/);
    chmodSync(file, 0o000);
    // Root can read any mode.
    if (process.getuid?.() !== 0)
      expect(() => readCommandCentrePasswordFile(file)).toThrow(/unreadable/);
  });
});

describe("resolveCommandCentreAuth", () => {
  test("a password file gives the daemon a hash of that password", async () => {
    writeSecret(SECRET);
    const auth = resolveCommandCentreAuth({}, { passwordFile: file });
    expect(auth.password).not.toContain(SECRET);
    expect(await isBearerTokenValidAsync({ password: auth.password, token: SECRET })).toBe(true);
  });

  test("a bad password file refuses the start, with no fallback to no auth", () => {
    writeSecret("   ");
    expect(() => resolveCommandCentreAuth({}, { passwordFile: file })).toThrow(/empty/);
    expect(() => resolveCommandCentreAuth({}, { passwordFile: path.join(dir, "absent") })).toThrow(
      /unreadable/,
    );
  });

  test("a password file and a configured password conflict", () => {
    writeSecret(SECRET);
    expect(() =>
      resolveCommandCentreAuth({ auth: { password: "configured" } }, { passwordFile: file }),
    ).toThrow(/Set only one/);
  });

  test("without a file the app hash and configured auth behave as before", () => {
    const hash = `$2b$12$${"a".repeat(53)}`;
    expect(resolveCommandCentreAuth({}, { generatedAuthHash: hash })).toEqual({ password: hash });
    expect(
      resolveCommandCentreAuth({ auth: { password: "configured" } }, { generatedAuthHash: hash }),
    ).toEqual({ password: "configured" });
    expect(() => resolveCommandCentreAuth({}, { generatedAuthHash: "not-a-hash" })).toThrow(
      "Command Centre requires daemon authentication",
    );
  });
});
