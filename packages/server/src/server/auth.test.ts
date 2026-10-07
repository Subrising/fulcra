import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractHttpBearerToken,
  extractWsBearerProtocol,
  extractWsBearerToken,
  hashDaemonPassword,
  isAgentMcpRequestAuthorized,
  isBearerTokenValidAsync,
<<<<<<< HEAD
  selectDaemonProtocol,
  shouldBypassBearerAuth,
} from "./auth.js";
import {
  DAEMON_PLAIN_PROTOCOL,
  daemonAuthorizationHeader,
  daemonAuthProtocols,
} from "@getpaseo/protocol/daemon-credential";
=======
  shouldBypassBearerAuth,
} from "./auth.js";
>>>>>>> refs/tags/v0.10.3
import { resolveSessionAdmission } from "./session-admission-auth.js";
import {
  deleteLocalCredential,
  readLocalCredentialForTarget,
  writeLocalCredential,
} from "./local-credential.js";

const CORRECT_PASSWORD_HASH = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";

describe("daemon bearer validator", () => {
  test("allows any token when no password is configured", async () => {
    expect(await isBearerTokenValidAsync({ password: undefined, token: null })).toBe(true);
    expect(await isBearerTokenValidAsync({ password: undefined, token: "anything" })).toBe(true);
  });

  test("accepts the plaintext token against the bcrypt hash and rejects missing or wrong tokens", async () => {
    expect(
      await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: "correct-password" }),
    ).toBe(true);
    expect(await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: null })).toBe(
      false,
    );
    expect(await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: "wrong" })).toBe(
      false,
    );
  });

  test("hashes a password into a bcrypt value", async () => {
    const hash = hashDaemonPassword("correct-password");

    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await isBearerTokenValidAsync({ password: hash, token: "correct-password" })).toBe(true);
  });

  test("extracts HTTP bearer tokens", () => {
    expect(extractHttpBearerToken("Bearer secret")).toBe("secret");
    expect(extractHttpBearerToken("Basic secret")).toBeNull();
    expect(extractHttpBearerToken(undefined)).toBeNull();
  });

  test("extracts WebSocket paseo bearer subprotocol tokens", () => {
    const protocol = extractWsBearerProtocol("chat, paseo.bearer.secret.with.dots");

    expect(protocol).toBe("paseo.bearer.secret.with.dots");
    expect(extractWsBearerToken(protocol)).toBe("secret.with.dots");
    expect(extractWsBearerToken("paseo.other.secret")).toBeNull();
  });

  test("bypasses bearer auth for preflight, liveness, and capability-token routes", () => {
    // Preflight is always bypassed regardless of path.
    expect(shouldBypassBearerAuth("OPTIONS", "/api/status")).toBe(true);
    // Unauthenticated liveness probe.
    expect(shouldBypassBearerAuth("GET", "/api/health")).toBe(true);
    // Guarded by its own single-use download token, not the daemon password.
    expect(shouldBypassBearerAuth("GET", "/api/files/download")).toBe(true);
    // Guarded by its own per-daemon-run capability token (see
    // isAgentMcpRequestAuthorized), not the daemon password.
    expect(shouldBypassBearerAuth("POST", "/mcp/agents")).toBe(true);
    // Everything else stays behind the daemon password.
    expect(shouldBypassBearerAuth("GET", "/api/status")).toBe(false);
    expect(shouldBypassBearerAuth("POST", "/api/files/upload")).toBe(false);
  });
});

describe("encoded credentials (F01)", () => {
  test("reads the password from the current and legacy subprotocols and from an encoded header", () => {
    const password = "a b,c/d\"e'f🔐";
    const protocols = daemonAuthProtocols(password);
    expect(extractWsBearerToken(extractWsBearerProtocol(protocols.join(", ")))).toBe(password);
    expect(extractWsBearerToken("paseo.bearer.legacy-token")).toBe("legacy-token");
    expect(extractHttpBearerToken(daemonAuthorizationHeader(password))).toBe(password);
    expect(extractHttpBearerToken("Bearer plain-token")).toBe("plain-token");
  });

  test("answers with the plain protocol, so the handshake never echoes the credential", () => {
    expect(selectDaemonProtocol(daemonAuthProtocols("secret"))).toBe(DAEMON_PLAIN_PROTOCOL);
    // An older client offers only its credential protocol, which is echoed as before.
    expect(selectDaemonProtocol(["paseo.bearer.secret"])).toBe("paseo.bearer.secret");
    expect(selectDaemonProtocol([DAEMON_PLAIN_PROTOCOL])).toBe(false);
  });
});

describe("agent MCP request authorizer", () => {
  const CAPABILITY_TOKEN = "cap-token-abc123";

  test("allows any request when no daemon password is configured", async () => {
    expect(
      await isAgentMcpRequestAuthorized({
        password: undefined,
        capabilityToken: CAPABILITY_TOKEN,
        authorizationHeader: undefined,
      }),
    ).toBe(true);
  });

  test("accepts the injected capability token", async () => {
    expect(
      await isAgentMcpRequestAuthorized({
        password: CORRECT_PASSWORD_HASH,
        capabilityToken: CAPABILITY_TOKEN,
        authorizationHeader: `Bearer ${CAPABILITY_TOKEN}`,
      }),
    ).toBe(true);
  });

  test("still accepts a valid daemon-password bearer", async () => {
    expect(
      await isAgentMcpRequestAuthorized({
        password: CORRECT_PASSWORD_HASH,
        capabilityToken: CAPABILITY_TOKEN,
        authorizationHeader: "Bearer correct-password",
      }),
    ).toBe(true);
  });

  test("rejects requests presenting neither the token nor a valid password", async () => {
    expect(
      await isAgentMcpRequestAuthorized({
        password: CORRECT_PASSWORD_HASH,
        capabilityToken: CAPABILITY_TOKEN,
        authorizationHeader: undefined,
      }),
    ).toBe(false);
    expect(
      await isAgentMcpRequestAuthorized({
        password: CORRECT_PASSWORD_HASH,
        capabilityToken: CAPABILITY_TOKEN,
        authorizationHeader: "Bearer wrong-token",
      }),
    ).toBe(false);
  });
});

describe("hello admission", () => {
<<<<<<< HEAD
  test("never promotes an unpaired relay hello to owner authority", async () => {
    for (const credential of [
      undefined,
      { kind: "password" as const, password: "relay-password" },
      { kind: "localCredential" as const, token: "local-token" },
    ]) {
      expect(
        await resolveSessionAdmission({
          credential,
          passwordHash: undefined,
          localCredential: "local-token",
          transport: "relay",
        }),
      ).toEqual({ rejection: "password_required" });
    }
  });

=======
>>>>>>> refs/tags/v0.10.3
  test("admits a stale local credential when no password is configured", async () => {
    expect(
      await resolveSessionAdmission({
        credential: { kind: "localCredential", token: "stale" },
        passwordHash: undefined,
        localCredential: "current",
        transport: "direct",
      }),
    ).toMatchObject({ admission: { principalId: "owner" } });
  });
  test("accepts a password and current local credential, but rejects old and wrong credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-local-auth-"));
    try {
      const first = await writeLocalCredential(home);
      const second = await writeLocalCredential(home);
      const input = {
        passwordHash: CORRECT_PASSWORD_HASH,
        localCredential: second,
        transport: "direct" as const,
      };
      expect(
        await resolveSessionAdmission({
          ...input,
          credential: { kind: "password", password: "correct-password" },
        }),
      ).toMatchObject({ admission: { principalId: "owner" } });
      expect(
        await resolveSessionAdmission({
          ...input,
          credential: { kind: "localCredential", token: second },
        }),
      ).toMatchObject({ admission: { principalId: "owner" } });
      expect(
        await resolveSessionAdmission({
          ...input,
          credential: { kind: "localCredential", token: first },
        }),
      ).toEqual({ rejection: "incorrect_password" });
      expect(
        await resolveSessionAdmission({
          ...input,
          credential: { kind: "password", password: "wrong" },
        }),
      ).toEqual({ rejection: "incorrect_password" });
      expect(
        await resolveSessionAdmission({
          ...input,
          transport: "relay",
          credential: { kind: "password", password: "wrong" },
        }),
<<<<<<< HEAD
      ).toEqual({ rejection: "password_required" });
=======
      ).toEqual({ rejection: "incorrect_password" });
>>>>>>> refs/tags/v0.10.3
      expect(await resolveSessionAdmission({ ...input, credential: undefined })).toEqual({
        rejection: "password_required",
      });
      expect(
        await resolveSessionAdmission({ ...input, transport: "relay", credential: undefined }),
<<<<<<< HEAD
      ).toEqual({ rejection: "password_required" });
=======
      ).toMatchObject({ admission: { principalId: "owner" } });
>>>>>>> refs/tags/v0.10.3
    } finally {
      await deleteLocalCredential(home);
      await rm(home, { recursive: true, force: true });
    }
  });

  test("writes a private rotating credential and reads it only for the matching target", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-local-file-"));
    try {
      await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:6767" }));
      const first = await writeLocalCredential(home);
      if (process.platform !== "win32") {
        expect((await stat(join(home, "local-credential"))).mode & 0o777).toBe(0o600);
      }
      expect(readLocalCredentialForTarget(home, "tcp://localhost:6767")).toBe(first);
      expect(readLocalCredentialForTarget(home, "tcp://remote.example:6767")).toBeNull();
      const second = await writeLocalCredential(home);
      expect(second).not.toBe(first);
      expect((await readFile(join(home, "local-credential"), "utf8")).trim()).toBe(second);
      await deleteLocalCredential(home);
      expect(readLocalCredentialForTarget(home, "localhost:6767")).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
<<<<<<< HEAD

test("report credentials never authenticate the agent MCP action endpoint, including passwordless or matching-token hosts", async () => {
  const report = "report1." + "x".repeat(43);
  for (const password of [undefined, CORRECT_PASSWORD_HASH])
    for (const capabilityToken of [null, report, "ordinary-mcp-token"])
      expect(
        await isAgentMcpRequestAuthorized({
          password,
          capabilityToken,
          authorizationHeader: `Bearer ${report}`,
        }),
      ).toBe(false);
});
=======
>>>>>>> refs/tags/v0.10.3
