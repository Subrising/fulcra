// Test-only native stores. Never select or change a default Keychain or its search list.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createKeychain, createWindowsKeychain } from "./accounts.mjs";

export function scratchKeychain(root) {
  if (process.platform === "win32")
    return { store: createWindowsKeychain({ dir: path.join(root, "accounts/secrets") }), env: {} };
  if (process.platform !== "darwin") throw Error("Native credential test needs macOS or Windows");
  const searchList = () =>
    execFileSync("/usr/bin/security", ["list-keychains", "-d", "user"], {
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin" },
    });
  const before = searchList();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const keychain = path.join(root, "scratch.keychain-db");
  const swift = path.join(root, "create.swift");
  fs.writeFileSync(
    swift,
    `import Foundation
import Security
var kc: SecKeychain?
let p = "scratch-fixture"
let status = p.withCString { SecKeychainCreate(CommandLine.arguments[1], UInt32(p.utf8.count), $0, false, nil, &kc) }
if status != errSecSuccess { exit(1) }
`,
    { mode: 0o600 },
  );
  execFileSync("/usr/bin/swift", [swift, keychain], {
    env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 60000,
  });
  if (searchList() !== before) throw Error("Scratch Keychain changed the search list");
  return {
    store: createKeychain({ keychain, security: "/usr/bin/security" }),
    env: { FULCRA_ACCOUNTS_KEYCHAIN: keychain },
  };
}
