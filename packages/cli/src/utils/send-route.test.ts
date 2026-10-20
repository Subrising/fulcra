import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSendRoute, sshSend, readRemoteSendHost } from "./send-route.js";

const transport = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: transport }));
const route = {
  host: "remote host",
  sshTarget: "remote-test",
  cli: "/opt/bin/fulcra",
  home: "/srv/fulcra",
};
const id = "11111111-1111-4111-8111-111111111111";
const id2 = "11111111-1111-4111-8111-111111111112";
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
  await policy({ sshRoutes: { [id]: route }, roles: { lead: id } });
  expect(await readSendRoute("role:lead")).toEqual({ agentId: id, route });
});
it("refuses ambiguous route prefixes and invalid SSH options", async () => {
  await policy({ sshRoutes: { [id]: route, [id2]: route } });
  await expect(readSendRoute("1111")).rejects.toThrow("ambiguous");
  await policy({ sshRoutes: { [id]: { ...route, sshTarget: "-oProxyCommand=wrong" } } });
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

it("relays the source host's own-lead check to the destination (FU-402)", async () => {
  await sshSend({
    route,
    agentId: "target",
    prompt: "DECISION merge now?",
    sender: {
      agentId: "sender",
      serverId: "book",
      outboundServerOnly: "mini",
      outboundParent: true,
    },
    localServerId: "book",
    localHost: "book host",
    options: { daemonTarget: { kind: "instance", home: "/local" } },
  });
  expect(JSON.parse(wire).flags).toEqual([
    "--from",
    "sender@book",
    "--outbound-server-only",
    "mini",
    "--outbound-parent",
  ]);
});

it.each(["-oProxyCommand=wrong", "11111111", "not-a-session"])(
  "rejects an invalid route key: %s",
  async (key) => {
    await policy({ sshRoutes: { [key]: route } });
    await expect(readSendRoute(key)).rejects.toThrow("Invalid SSH");
    expect(transport).not.toHaveBeenCalled();
  },
);
it("maps the exact legacy pause receipt to held", async () => {
  output = JSON.stringify({
    agentId: "target",
    status: "sent",
    message: "Provider paused. Notice saved. No turn was started.",
  });
  expect((await send()).status).toBe("held");
});
it("warns once when the remote CLI can skip the host pause launcher", async () => {
  const result = await sshSend({
    route: { ...route, cli: "/bin/native-cli" },
    agentId: "target",
    prompt: "draft",
    sender: null,
    localServerId: "source",
    localHost: "source",
    options: { daemonTarget: { kind: "instance", home: "/local" } },
  });
  expect(result.message.match(/Warning:/g)).toHaveLength(1);
  expect(result.message).toContain("Python pause guard");
});
it("checks destination support without sending input", async () => {
  output = JSON.stringify({ sendRouting: { serverId: "destination", mainAssistantId: null } });
  expect(await readRemoteSendHost(route)).toEqual({
    serverId: "destination",
    mainAssistantId: null,
  });
  expect(JSON.parse(wire)).toMatchObject({ operation: "metadata" });
  expect(JSON.parse(wire)).not.toHaveProperty("prompt");
});
it.skipIf(process.platform === "win32")(
  "keeps injection-like prompt text intact through the real remote shell",
  async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const ssh = join(root, "ssh");
    const cli = join(root, "fulcra");
    const marker = join(root, "injected");
    const prompt = `quote ' "; touch ${marker}; # $(touch ${marker}) \`touch ${marker}\`\nsecond line`;
    await writeFile(ssh, '#!/bin/sh\nfor last do :; done\nexec /bin/sh -c "$last"\n', {
      mode: 0o700,
    });
    await writeFile(
      cli,
      '#!/usr/bin/env python3\nimport json,pathlib,sys\na=sys.argv\ntext=pathlib.Path(a[a.index("--prompt-file")+1]).read_text()\njson.dump({"agentId":"target","status":"sent","message":text},sys.stdout)\n',
      { mode: 0o700 },
    );
    transport.mockImplementation((_command, args, options) => actual.spawn(ssh, args, options));
    const result = await sshSend({
      route: { ...route, cli },
      agentId: "target",
      prompt,
      sender: null,
      localServerId: "source",
      localHost: "source",
      options: { daemonTarget: { kind: "instance", home: "/local" } },
    });
    expect(result.message).toBe(prompt);
    await expect(import("node:fs/promises").then((fs) => fs.access(marker))).rejects.toThrow();
  },
);
