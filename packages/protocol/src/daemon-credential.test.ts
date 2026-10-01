import { describe, expect, it } from "vitest";
import {
  DAEMON_PLAIN_PROTOCOL,
  daemonAuthorizationHeader,
  daemonAuthProtocols,
  decodeDaemonPassword,
  encodeDaemonPassword,
  passwordFromBearerToken,
  passwordFromProtocol,
  redactCredential,
} from "./daemon-credential";

// Synthetic passwords only. Every printable ASCII character, plus the troublemakers on their own.
const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
const PASSWORDS = [
  PRINTABLE,
  "correct horse battery staple",
  "a,b,c",
  "slash/and\\back",
  `quote"single'tick\``,
  "semi;colon=equals",
  "påsswörd-日本語-🔐",
  "x",
  "b64u.looks-encoded",
  ...PRINTABLE.split(""),
];
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER = /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;

describe("daemon credential encoding (F01)", () => {
  it("round-trips any password through base64url", () => {
    for (const password of PASSWORDS) {
      const encoded = encodeDaemonPassword(password);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeDaemonPassword(encoded)).toBe(password);
    }
  });

  it("offers only valid subprotocol tokens, and the host reads the password back", () => {
    for (const password of PASSWORDS) {
      const protocols = daemonAuthProtocols(password);
      expect(protocols[0]).toBe(DAEMON_PLAIN_PROTOCOL);
      for (const protocol of protocols) expect(protocol).toMatch(TOKEN);
      const carried = protocols.map(passwordFromProtocol).filter((p) => p !== null);
      expect(carried.length).toBeGreaterThan(0);
      for (const value of carried) expect(value).toBe(password);
    }
  });

  it("builds a valid Authorization header the host reads back", () => {
    for (const password of PASSWORDS) {
      const header = daemonAuthorizationHeader(password);
      expect(header).toMatch(HEADER);
      expect(passwordFromBearerToken(header.slice("Bearer ".length))).toBe(password);
    }
  });

  it("removes every form of the password from text (F02)", () => {
    for (const password of PASSWORDS.slice(0, 9)) {
      const text = [
        `The subprotocol '${daemonAuthProtocols(password)[1]}' is invalid.`,
        daemonAuthorizationHeader(password),
        `raw ${password} end`,
      ].join(" | ");
      const safe = redactCredential(text, password);
      expect(safe).not.toContain(password);
      expect(safe).not.toContain(encodeDaemonPassword(password));
    }
  });
});
