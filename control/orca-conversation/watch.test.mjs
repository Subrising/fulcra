import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { emit } from "./watch.mjs";
import { gatewayWake } from "./gateway-wake.mjs";

test("notification failure preserves bounded cause without command, prompt or credential echo and never retries", async () => {
  const text = "Private instruction ".repeat(200),
    secret = "S".repeat(43);
  for (const code of ["ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", 1]) {
    let calls = 0;
    await assert.rejects(
      emit("agent:main:owned", text, async () => {
        calls++;
        throw Object.assign(Error("Command failed: " + text), {
          code,
          signal: "SIGTERM",
          killed: true,
          stdout: "token=" + secret + "\nJSON failure",
          stderr: text + "\n" + "x".repeat(2000) + "\ntoken=" + secret + "\nGateway unavailable",
        });
      }),
      (error) => {
        assert(error.message.includes(String(code)));
        assert(error.message.includes("SIGTERM"));
        assert(error.message.includes("Gateway unavailable"));
        assert(error.message.includes("JSON failure"));
        assert(!error.message.includes("Private instruction"));
        assert(!error.message.includes(secret));
        assert(error.message.length < 1800);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("real silent timeout and stdout-only failure retain process facts without a second attempt", async () => {
  const execute = promisify(execFile);
  for (const timeout of [true, false]) {
    let calls = 0;
    await assert.rejects(
      emit("agent:main:owned", "No real notification", async () => {
        calls++;
        return execute(
          "/usr/bin/python3",
          [
            "-I",
            "-c",
            timeout
              ? "import time;time.sleep(2)"
              : 'print("stdout-only failure");raise SystemExit(7)',
          ],
          { timeout: timeout ? 100 : 5000 },
        );
      }),
      (error) => {
        const facts = JSON.parse(error.message.slice(error.message.indexOf("{")));
        assert(facts.elapsedMs > 0);
        if (timeout) {
          assert(facts.killed);
          assert.equal(facts.signal, "SIGTERM");
        } else {
          assert.equal(facts.exitCode, 7);
          assert(facts.stdoutTail.includes("stdout-only failure"));
        }
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("successful notification retains the exact target, bounded process options and acknowledgement", async () => {
  const r = await emit(
    "agent:main:owned",
    "Exact scoped outcome",
    async (binary, args, options) => {
      assert.equal(binary, process.execPath);
      assert(args[0].endsWith("/gateway-wake.mjs"));
      assert.equal(args[1], "agent:main:owned:heartbeat");
      assert.equal(args[2], "Exact scoped outcome");
      assert.deepEqual(options, { timeout: 30000, maxBuffer: 16384 });
      return { stdout: '{"acknowledged":true}' };
    },
  );
  assert.deepEqual(r, { acknowledged: true, response: '{"acknowledged":true}' });
});

test("SDK wake uses the same Gateway method, auth defaults and exact target once", async () => {
  let calls = 0;
  const invoke = async (method, options, input) => {
    calls++;
    assert.equal(method, "wake");
    assert.deepEqual(options, { json: true, timeout: "20000" });
    assert.deepEqual(input, {
      mode: "now",
      text: "Scoped callback",
      sessionKey: "agent:main:owned:heartbeat",
    });
    return { ok: true };
  };
  assert.deepEqual(await gatewayWake("agent:main:owned:heartbeat", "Scoped callback", invoke), {
    acknowledged: true,
  });
  assert.equal(calls, 1);
  for (const [key, text] of [
    ["agent:other:owned:heartbeat", "Scoped"],
    ["agent:main:owned", "Scoped"],
    ["agent:main:owned:heartbeat", ""],
    ["agent:main:owned:heartbeat", "x".repeat(16385)],
  ])
    await assert.rejects(gatewayWake(key, text, invoke));
  assert.equal(calls, 1);
  await assert.rejects(
    gatewayWake("agent:main:owned:heartbeat", "Scoped", async () => ({ ok: false })),
    /did not acknowledge/,
  );
  await assert.rejects(
    gatewayWake("agent:main:owned:heartbeat", "Scoped", async () => {
      throw Error("Connection lost");
    }),
    /Connection lost/,
  );
});
