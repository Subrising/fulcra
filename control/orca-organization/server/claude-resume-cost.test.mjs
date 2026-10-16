// Real Claude CLI processes and a local API fixture. No live account, keychain or provider request.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { scratchKeychain } from "./scratch-keychain.fixture.mjs";
import { apiKeyHelperCommand } from "./api-key-helper.mjs";
import { addAccount, readAccounts, setAccount } from "./accounts.mjs";
import { recordAccountCost, accountSpend } from "./account-billing.mjs";
const binary =
  process.env.FULCRA_TEST_CLAUDE_BIN ??
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => path.join(dir, process.platform === "win32" ? "claude.exe" : "claude"))
    .find((file) => fs.existsSync(file));
function reply(req, res) {
  let text = "";
  req.on("data", (chunk) => {
    text += chunk;
  });
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* non-message route */
    }
    if (!req.url.startsWith("/v1/messages")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    const message = {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(message));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: { ...message.usage, output_tokens: 0 },
          },
        },
      ],
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 2 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ];
    for (const [event, value] of events)
      res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    res.end();
  });
}
function run(home, baseUrl, args, helper, key) {
  return new Promise((resolve, reject) => {
    let out = "",
      err = "";
    const child = spawn(
      binary,
      [
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--setting-sources",
        "",
        "--settings",
        JSON.stringify({ apiKeyHelper: helper }),
        "--model",
        "claude-sonnet-4-6",
        ...args,
        "Reply OK.",
      ],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDE_CONFIG_DIR: path.join(home, "config"),
          ANTHROPIC_API_KEY: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_BASE_URL: baseUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (process.platform === "darwin") {
      const processView = execFileSync(
        "/bin/ps",
        ["eww", "-p", String(child.pid), "-o", "command="],
        { encoding: "utf8" },
      );
      assert.equal(
        processView.includes(key),
        false,
        "Native process argv and environment must not contain the key",
      );
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error(`Scratch CLI timed out: ${err.slice(0, 300)}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(Error(`Scratch CLI exit ${code}: ${err.slice(0, 300)}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(Error("Scratch CLI did not return JSON"));
      }
    });
  });
}
test(
  "L4: a new real CLI process resumes cumulative cost without charging the old cost to the new account",
  { skip: !binary || !["darwin", "win32"].includes(process.platform), timeout: 120000 },
  async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "api-cost-native-resume-"));
    const key = `sk-ant-api03-${randomUUID()}-${randomUUID()}`;
    let authenticated = 0;
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/v1/messages")) {
        assert.equal(req.headers["x-api-key"] === key, true);
        authenticated++;
      }
      reply(req, res);
    });
    t.after(() => {
      server.closeAllConnections();
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const root = path.join(home, "billing"),
      nativeId = randomUUID();
    const a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
    const b = await addAccount(root, { provider: "claude", name: "work-workspace-api" });
    const { store, env } = scratchKeychain(root);
    t.after(() => store.remove(a.id));
    await store.put(a.id, key);
    await setAccount(root, a.id, { credentialKind: "api-key" });
    const helper = apiKeyHelperCommand({ root, id: a.id, env });
    const url = `http://127.0.0.1:${server.address().port}`;
    const first = await run(home, url, ["--session-id", nativeId], helper, key);
    await recordAccountCost(root, {
      id: "first",
      accountId: a.id,
      costUsd: first.total_cost_usd,
      runtimeSessionId: nativeId,
      cumulativeUsd: first.total_cost_usd,
    });
    const second = await run(home, url, ["--resume", nativeId], helper, key);
    assert.equal(authenticated, 2);
    // Scan actual Claude session records, logs and settings. The native Keychain file is encrypted.
    const scan = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(file);
        else
          assert.equal(
            fs.readFileSync(file).includes(Buffer.from(key)),
            false,
            `Key found in ${entry.name}`,
          );
      }
    };
    scan(home);
    assert.equal(first.session_id, nativeId);
    assert.equal(second.session_id, nativeId);
    assert.ok(first.total_cost_usd > 0);
    assert.equal(second.total_cost_usd, first.total_cost_usd * 2);
    await recordAccountCost(root, {
      id: "resumed",
      accountId: b.id,
      costUsd: second.total_cost_usd,
      runtimeSessionId: nativeId,
      cumulativeUsd: second.total_cost_usd,
    });
    const pool = readAccounts(root);
    assert.equal(accountSpend(root, pool.accounts[0]).usedUsd, first.total_cost_usd);
    assert.equal(
      accountSpend(root, pool.accounts[1]).usedUsd,
      second.total_cost_usd - first.total_cost_usd,
    );
    assert.equal(accountSpend(root, pool.accounts[1]).usedUsd, first.total_cost_usd);
  },
);
