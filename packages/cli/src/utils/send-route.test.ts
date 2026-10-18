import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSendRoute, sshSend } from "./send-route.js";

const transport = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: transport }));
const route = {
  host: "remote host",
  sshTarget: "remote-test",
  cli: "/opt/bin/fulcra",
  home: "/srv/fulcra",
};
let root: string;
let output: string;
let exitCode: number;
let wire: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "send-route-"));
  vi.stubEnv("FULCRA_NOTICE_CONFIG", root);
  output = JSON.stringify({ agentId: "target", status: "held", message: "Provider paused." });
  exitCode = 0;
  wire = "";
  transport.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    child.stdin.on("data", (chunk) => {
      wire += chunk;
    });
    child.stdin.on("finish", () => {
      child.stdout.end(output);
      child.emit("close", exitCode);
    });
    return child;
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});
const policy = async (value: unknown) => writeFile(join(root, "pause.json"), JSON.stringify(value));

it("requires structured routes and ignores display text", async () => {
  await policy({ noticeRoutes: { target: { host: "remote host", route: "ssh remote" } } });
  expect(await readSendRoute("target")).toBeNull();
  await policy({ sshRoutes: { target: route }, roles: { lead: "target" } });
  expect(await readSendRoute("role:lead")).toEqual({ agentId: "target", route });
});
it("refuses ambiguous route prefixes and invalid SSH options", async () => {
  await policy({ sshRoutes: { target1: route, target2: route } });
  await expect(readSendRoute("target")).rejects.toThrow("ambiguous");
  await policy({ sshRoutes: { target: { ...route, sshTarget: "-oProxyCommand=wrong" } } });
  await expect(readSendRoute("target")).rejects.toThrow("Invalid SSH");
  expect(transport).not.toHaveBeenCalled();
});
const send = () =>
  sshSend({
    route,
    agentId: "target",
    prompt: "private draft ' $() `text`\nnext line",
    sender: { agentId: "sender" },
    localServerId: "source-server",
    localHost: "source host",
    options: { daemonTarget: { kind: "instance", home: "/local" } },
  });
it("keeps the prompt on stdin and sends the source identity to destination checks", async () => {
  expect((await send()).status).toBe("held");
  const [command, args] = transport.mock.calls[0]!;
  expect(command).toBe("ssh");
  expect(args).toContain("StrictHostKeyChecking=yes");
  expect(JSON.stringify(args)).not.toContain("private draft");
  expect(JSON.parse(wire)).toMatchObject({
    agentId: "target",
    flags: ["--from", "sender@source-server"],
    home: route.home,
  });
});
it.each(["AGENT_NOT_FOUND", "SEND_FAILED"])(
  "names both checked hosts for a remote miss: %s",
  async (code) => {
    output = JSON.stringify({
      error: { code, message: "Failed to send message: Agent not found: target" },
    });
    exitCode = 1;
    await expect(send()).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: expect.stringContaining("source host (local daemon) and remote host"),
    });
  },
);
it("keeps a destination identity refusal visible without retry", async () => {
  output = JSON.stringify({ error: { code: "SEND_FAILED", message: "Wrong reporting line" } });
  exitCode = 1;
  await expect(send()).rejects.toThrow("remote host refused: Wrong reporting line");
  expect(transport).toHaveBeenCalledTimes(1);
});
it("does not treat a lost reply as a miss or retry it", async () => {
  output = "";
  exitCode = 255;
  await expect(send()).rejects.toThrow("uncertain");
  expect(transport).toHaveBeenCalledTimes(1);
});

it.skipIf(process.platform === "win32")(
  "reads the real destination CLI refusal from stderr",
  async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const ssh = join(root, "ssh");
    const cli = join(root, "receiver");
    await writeFile(ssh, '#!/bin/sh\nfor last do :; done\nexec /bin/sh -c "$last"\n', {
      mode: 0o700,
    });
    await writeFile(
      cli,
      '#!/usr/bin/env python3\nimport json,sys\njson.dump({"error":{"code":"SEND_FAILED","message":"Wrong reporting line"}},sys.stderr)\nsys.exit(1)\n',
      { mode: 0o700 },
    );
    transport.mockImplementation((_command, args, options) => actual.spawn(ssh, args, options));
    await expect(
      sshSend({
        route: { ...route, cli },
        agentId: "target",
        prompt: "private draft",
        sender: { agentId: "sender" },
        localServerId: "source-server",
        localHost: "source host",
        options: { daemonTarget: { kind: "instance", home: "/local" } },
      }),
    ).rejects.toMatchObject({
      code: "SEND_FAILED",
      message: expect.stringContaining("Wrong reporting line"),
    });
    expect(transport).toHaveBeenCalledTimes(1);
  },
);
it("preserves a relayed sender and the explicit notice opt-out", async () => {
  await sshSend({
    route,
    agentId: "target",
    prompt: "quiet",
    sender: { agentId: "sender", serverId: "original" },
    localServerId: "relay",
    localHost: "relay host",
    options: {
      daemonTarget: { kind: "instance", home: "/local" },
      notifyOnFinish: false,
      steer: true,
    },
  });
  expect(JSON.parse(wire).flags).toEqual([
    "--from",
    "sender@original",
    "--no-notify-on-finish",
    "--steer",
  ]);
});
