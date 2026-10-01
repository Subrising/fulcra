import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { BeforeSendResponse, OnBeforeSendHeadersListenerDetails, WebContents } from "electron";
import { hashDaemonPassword, isBearerTokenValidAsync } from "@getpaseo/server/auth";
import { daemonAuthorizationHeader } from "@getpaseo/protocol/daemon-credential";
import { ownedDaemonHeaders } from "./command-centre-headers.js";
import {
  CONTROLLER_SECRET_FILE,
  localServiceOwnerCredential,
  type LocalServiceCredentialDeps,
} from "./local-service-credential.js";

// L39. Synthetic secrets only.
const SECRET = "synthetic-controller-secret with spaces, commas/slashes and ü";
const HASH = hashDaemonPassword(SECRET);
const URL = "ws://127.0.0.1:6791/ws";
const uid = process.getuid?.() ?? -1;
let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "l39-home-"));
  await writeFile(path.join(home, CONTROLLER_SECRET_FILE), `${SECRET}\n`, { mode: 0o600 });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A launchd-style service of this home: running, configured password = hash of controller.secret. */
function deps(patch: Partial<LocalServiceCredentialDeps> = {}): LocalServiceCredentialDeps {
  return {
    home,
    readInstance: async (h) => (h === home ? { pid: 4242, listen: "127.0.0.1:6791" } : null),
    endpointOf: (_h, instance) => `ws://${instance.listen}/ws`,
    configuredPasswordHash: (h) => (h === home ? HASH : undefined),
    matches: (secret, hash) => isBearerTokenValidAsync({ password: hash, token: secret }),
    uid,
    ...patch,
  };
}

test("the Mac's own window gets owner access to this home's launchd-style service", async () => {
  expect(await localServiceOwnerCredential(URL, deps())).toBe(SECRET);
});

test("never for a remote target, another port, another home or no running service", async () => {
  for (const url of [
    "ws://mac.local:6791/ws",
    "ws://192.168.1.10:6791/ws",
    "wss://127.0.0.1:6791/ws",
    "ws://127.0.0.1:6792/ws",
    "ws://localhost:6791/ws",
  ])
    expect(await localServiceOwnerCredential(url, deps())).toBeUndefined();
  const otherHome = await mkdtemp(path.join(tmpdir(), "l39-other-"));
  try {
    // Another home: its daemon record, its (absent) secret and password, never this home's.
    expect(await localServiceOwnerCredential(URL, deps({ home: otherHome }))).toBeUndefined();
  } finally {
    await rm(otherHome, { recursive: true, force: true });
  }
  expect(
    await localServiceOwnerCredential(URL, deps({ readInstance: async () => null })),
  ).toBeUndefined();
});

test("never unless controller.secret is this service's own password, in a private file of this user", async () => {
  // No configured password: nothing to match, nothing sent.
  expect(
    await localServiceOwnerCredential(URL, deps({ configuredPasswordHash: () => undefined })),
  ).toBeUndefined();
  // A secret that is not this service's password (e.g. another home's).
  expect(
    await localServiceOwnerCredential(
      URL,
      deps({ configuredPasswordHash: () => hashDaemonPassword("a different synthetic secret") }),
    ),
  ).toBeUndefined();
  // Readable by others.
  await chmod(path.join(home, CONTROLLER_SECRET_FILE), 0o644);
  expect(await localServiceOwnerCredential(URL, deps())).toBeUndefined();
  await chmod(path.join(home, CONTROLLER_SECRET_FILE), 0o600);
  // Owned by someone else.
  expect(await localServiceOwnerCredential(URL, deps({ uid: uid + 1 }))).toBeUndefined();
  // A link to a secret elsewhere.
  await rm(path.join(home, CONTROLLER_SECRET_FILE));
  const elsewhere = path.join(tmpdir(), `l39-target-${process.pid}`);
  await writeFile(elsewhere, SECRET, { mode: 0o600 });
  await symlink(elsewhere, path.join(home, CONTROLLER_SECRET_FILE));
  try {
    expect(await localServiceOwnerCredential(URL, deps())).toBeUndefined();
  } finally {
    await rm(elsewhere, { force: true });
  }
});

test("never when the service changed during the checks", async () => {
  let calls = 0;
  const readInstance = async () => ({ pid: calls++ === 0 ? 4242 : 5151, listen: "127.0.0.1:6791" });
  expect(await localServiceOwnerCredential(URL, deps({ readInstance }))).toBeUndefined();
});

test("the renderer never sees it: only the window's own main-frame socket gets the header, in the main process", async () => {
  const frame = { url: "paseo://app/index.html" };
  const sender = { id: 1, mainFrame: frame, isDestroyed: () => false } as unknown as WebContents;
  const handler = ownedDaemonHeaders(new Set([sender]), (url) =>
    localServiceOwnerCredential(url, deps()),
  );
  const base = {
    url: URL,
    webContents: sender,
    webContentsId: 1,
    frame,
    resourceType: "webSocket",
    requestHeaders: {},
  } as unknown as OnBeforeSendHeadersListenerDetails;
  const run = (patch: Partial<OnBeforeSendHeadersListenerDetails> = {}) =>
    new Promise<BeforeSendResponse>((done) => handler({ ...base, ...patch }, done));
  const granted = await run();
  expect(granted.requestHeaders).toEqual({ Authorization: daemonAuthorizationHeader(SECRET) });
  // The renderer's own request object is untouched; the header exists only in the network layer.
  expect(base.requestHeaders).toEqual({});
  const subframe = { url: "paseo://app/index.html" };
  for (const patch of [
    { frame: subframe },
    { resourceType: "xhr" },
    { frame: { url: "https://evil.invalid/" } },
  ] as Partial<OnBeforeSendHeadersListenerDetails>[]) {
    const response = await run(patch);
    expect(JSON.stringify(response)).not.toContain(daemonAuthorizationHeader(SECRET).slice(7));
  }
});

test("a verified password match is reused; a changed secret or password is checked again", async () => {
  // A fresh hash (new salt), so no earlier test's result applies.
  const hash = hashDaemonPassword(SECRET);
  let checks = 0;
  const counted = (patch: Partial<LocalServiceCredentialDeps> = {}) =>
    deps({
      configuredPasswordHash: () => hash,
      matches: async (secret, candidateHash) => {
        checks += 1;
        return isBearerTokenValidAsync({ password: candidateHash, token: secret });
      },
      ...patch,
    });
  expect(await localServiceOwnerCredential(URL, counted())).toBe(SECRET);
  const first = checks;
  expect(first).toBeGreaterThan(0);
  expect(await localServiceOwnerCredential(URL, counted())).toBe(SECRET);
  expect(checks).toBe(first);
  // A different file content is verified again (and refused).
  await writeFile(path.join(home, CONTROLLER_SECRET_FILE), "another synthetic secret", {
    mode: 0o600,
  });
  expect(await localServiceOwnerCredential(URL, counted())).toBeUndefined();
  expect(checks).toBe(first + 1);
  // A different configured password is verified again.
  const otherHash = hashDaemonPassword("another synthetic secret");
  expect(
    await localServiceOwnerCredential(URL, counted({ configuredPasswordHash: () => otherHash })),
  ).toBe("another synthetic secret");
  expect(checks).toBe(first + 2);
});
