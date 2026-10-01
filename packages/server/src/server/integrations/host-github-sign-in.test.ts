import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createMemoryCredentialBackend } from "./credential-backend.js";
import { createHostGithubSignIn, type GhRunner } from "./host-github-sign-in.js";
import { createHostIntegrations } from "./host-integrations.js";

const CANARY = "gho_CANARY_host_login_0123456789";

// A stand-in for `gh`: answers by argv, records every call, fails like gh does for anything else.
function fakeGh(answers: Record<string, string | Error>) {
  const calls: string[][] = [];
  const run: GhRunner = async (_gh, args) => {
    calls.push(args);
    const answer = answers[args.join(" ")];
    if (answer === undefined) throw Object.assign(new Error("exit 1"), { code: 1 });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { run, calls };
}

const HOSTS = [
  "auth",
  "status",
  "--json",
  "hosts",
  "--jq",
  '[.hosts[][] | select(.active and .state == "success") | .host]',
].join(" ");
const user = (host: string) =>
  ["api", "user", "--hostname", host, "--jq", "{login: .login, id: .id}"].join(" ");

describe("this Mac's GitHub sign-in", () => {
  it("reads the login and id of every signed-in host, and keeps an Enterprise host separate", async () => {
    const gh = fakeGh({
      [HOSTS]: '["github.com","GHE.Corp.Example"]\n',
      [user("github.com")]: '{"login":"dzgray","id":42}\n',
      [user("GHE.Corp.Example")]: '{"login":"example-owner","id":7}\n',
    });
    const signIn = createHostGithubSignIn({ resolveGhPath: async () => "/stub/gh", run: gh.run });
    expect(await signIn.read()).toEqual({
      status: "signed-in",
      identities: [
        { site: null, login: "dzgray", id: 42 },
        { site: "ghe.corp.example", login: "example-owner", id: 7 },
      ],
    });
    // Only these read-only calls; never one that could print a token.
    expect(gh.calls.map((args) => args.join(" "))).toEqual([
      HOSTS,
      user("github.com"),
      user("GHE.Corp.Example"),
    ]);
    expect(gh.calls.flat()).not.toContain("--show-token");
    expect(gh.calls.flat().some((arg) => arg === "token" || arg.includes("oauth_token"))).toBe(
      false,
    );
  });

  it("says gh is missing without running anything", async () => {
    const gh = fakeGh({});
    const signIn = createHostGithubSignIn({ resolveGhPath: async () => null, run: gh.run });
    expect(await signIn.read()).toEqual({ status: "no-cli" });
    expect(gh.calls).toEqual([]);
  });

  it("says signed out when gh knows no signed-in host, without asking for a user", async () => {
    const gh = fakeGh({ [HOSTS]: "[]\n" });
    const signIn = createHostGithubSignIn({ resolveGhPath: async () => "/stub/gh", run: gh.run });
    expect(await signIn.read()).toEqual({ status: "signed-out" });
    expect(gh.calls).toHaveLength(1);
  });

  it("falls back to github.com when this gh cannot list hosts as JSON", async () => {
    const gh = fakeGh({ [user("github.com")]: '{"login":"dzgray","id":42}' });
    const signIn = createHostGithubSignIn({ resolveGhPath: async () => "/stub/gh", run: gh.run });
    expect(await signIn.read()).toEqual({
      status: "signed-in",
      identities: [{ site: null, login: "dzgray", id: 42 }],
    });
    const signedOut = createHostGithubSignIn({
      resolveGhPath: async () => "/stub/gh",
      run: fakeGh({}).run,
    });
    expect(await signedOut.read()).toEqual({ status: "signed-out" });
  });

  it("skips a host whose answer is not a login, and never throws", async () => {
    const gh = fakeGh({
      [HOSTS]: '["github.com","ghe.corp.example","bad host/x"]',
      [user("github.com")]: "not json",
      [user("ghe.corp.example")]: '{"login":"example-owner","id":7}',
    });
    const signIn = createHostGithubSignIn({ resolveGhPath: async () => "/stub/gh", run: gh.run });
    expect(await signIn.read()).toEqual({
      status: "signed-in",
      identities: [{ site: "ghe.corp.example", login: "example-owner", id: 7 }],
    });
    expect(gh.calls.flat()).not.toContain("bad host/x");
    const broken = createHostGithubSignIn({
      resolveGhPath: async () => {
        throw new Error("PATH lookup failed");
      },
    });
    expect(await broken.read()).toEqual({ status: "no-cli" });
  });

  it("reads once at a time and keeps the answer for a short while", async () => {
    const clock = { value: 0 };
    const gh = fakeGh({ [HOSTS]: '["github.com"]', [user("github.com")]: '{"login":"a","id":1}' });
    const signIn = createHostGithubSignIn({
      resolveGhPath: async () => "/stub/gh",
      run: gh.run,
      now: () => clock.value,
      ttlMs: 60_000,
    });
    await Promise.all([signIn.read(), signIn.read()]);
    expect(gh.calls).toHaveLength(2);
    clock.value = 59_000;
    await signIn.read();
    expect(gh.calls).toHaveLength(2);
    clock.value = 61_000;
    await signIn.read();
    expect(gh.calls).toHaveLength(4);
  });

  it("runs a real gh without passing or keeping its token (stubbed executable)", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "fulcra-gh-stub-"));
    try {
      const argvLog = path.join(directory, "argv.log");
      const envLog = path.join(directory, "env.log");
      const ghPath = path.join(directory, "gh");
      writeFileSync(
        ghPath,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> '${argvLog}'`,
          `printf 'prompt=%s token=%s\\n' "$GH_PROMPT_DISABLED" "\${GH_TOKEN:+set}" >> '${envLog}'`,
          'case "$1 $2" in',
          `  "auth status") echo '["github.com"]' ;;`,
          `  "api user") echo '{"login":"dzgray","id":42}' ;;`,
          "  *) exit 1 ;;",
          "esac",
        ].join("\n"),
      );
      chmodSync(ghPath, 0o755);
      const logged: string[] = [];
      const signIn = createHostGithubSignIn({
        resolveGhPath: async () => ghPath,
        log: (message, fields) => logged.push(JSON.stringify({ message, fields })),
      });
      const previous = process.env.GH_TOKEN;
      process.env.GH_TOKEN = CANARY;
      let result: Awaited<ReturnType<typeof signIn.read>>;
      try {
        result = await signIn.read();
      } finally {
        if (previous === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = previous;
      }
      expect(result).toEqual({
        status: "signed-in",
        identities: [{ site: null, login: "dzgray", id: 42 }],
      });
      // gh keeps using its own login (an inherited GH_TOKEN stays gh's business), prompts are off,
      // and nothing Fulcra keeps or logs contains a token.
      expect(readFileSync(envLog, "utf8")).toContain("prompt=1");
      const argv = readFileSync(argvLog, "utf8");
      expect(argv).not.toContain(CANARY);
      expect(argv).not.toContain("--show-token");
      expect(JSON.stringify(result)).not.toContain(CANARY);
      expect(logged.join("\n")).not.toContain(CANARY);
      expect(logged.join("\n")).not.toContain("dzgray");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("host integrations wiring", () => {
  it("lists the sign-in it is given, and none when told null", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "fulcra-host-integrations-"));
    const make = (hostSignIn: Parameters<typeof createHostIntegrations>[0]["hostSignIn"]) =>
      createHostIntegrations({
        paseoHome,
        serverId: "srv_test",
        logger: pino({ level: "silent" }),
        backend: createMemoryCredentialBackend(),
        hostSignIn,
        sendPush: () => Promise.reject(new Error("no push in tests")),
      });
    try {
      const withSignIn = make({
        read: async () => ({
          status: "signed-in",
          identities: [{ site: null, login: "dzgray", id: 42 }],
        }),
      });
      const listed = await withSignIn.services.credentials!.list();
      withSignIn.dispose();
      expect(listed.accounts.map((a) => [a.displayName, a.method])).toEqual([["dzgray", "cli"]]);
      const without = make(null);
      const none = await without.services.credentials!.list();
      without.dispose();
      expect(none.accounts).toEqual([]);
    } finally {
      rmSync(paseoHome, { recursive: true, force: true });
    }
  });
});
