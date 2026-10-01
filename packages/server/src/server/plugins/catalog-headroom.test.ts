import { capturedCatalogReply, catalogReplyPath } from "./catalog-reply.fixture.js";
import { expect, test } from "vitest";
import { PluginRuntime } from "./runtime.js";
import { Session } from "../session.js";
import * as serviceBounds from "@getpaseo/protocol/controller-service";
import {
  boundedControllerJson,
  parseControllerServiceFrame,
} from "@getpaseo/protocol/controller-service";
import { parseControllerRequest } from "@getpaseo/protocol/controller-frames";

// Exercise the production catalog dispatcher and runtime mapping without starting sessions/providers.
function catalog(sessionCount: number, pluginCount: number) {
  const sessions = Array.from({ length: sessionCount }, (_, id) => ({ id: `fixture-${id}` }));
  const runtime = Object.create(PluginRuntime.prototype) as PluginRuntime;
  Object.assign(runtime, {
    plugins: new Map(
      Array.from({ length: pluginCount }, (_, id) => [
        `plugin-${id}`,
        { ...capturedCatalogReply().plugin, id: `plugin-${id}` },
      ]),
    ),
  });
  const frames: unknown[] = [];
  const owner = {
    dispatchIntegrationMessage() {},
    pluginRuntime: runtime,
    agentManager: {
      listAgents: () => sessions,
      trustedPlugins: { boot: "fixture-boot", catalog: () => [] },
    },
    emit: (message: unknown) => frames.push({ type: "session", message }),
  };
  const dispatch = Reflect.get(Session.prototype, "dispatchPluginMessage") as (
    this: typeof owner,
    message: { type: "plugin.catalog.get.request"; requestId: string },
  ) => void;
  dispatch.call(owner, { type: "plugin.catalog.get.request", requestId: "fixture" });
  // Session socket serialization omits optional undefined fields before host parsing.
  return JSON.parse(JSON.stringify(frames[0])) as unknown;
}
test.skipIf(!catalogReplyPath)(
  "catalog size is independent of 140 versus 420 sessions on each of two hosts",
  () => {
    const sizes: number[] = [];
    for (const _host of ["first", "second"])
      for (const count of [0, 140, 420]) {
        const value = catalog(count, 1);
        sizes.push(Buffer.byteLength(JSON.stringify(value)));
        expect(JSON.stringify(value)).not.toContain("fixture-419");
      }
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeGreaterThan(650000);
  },
);
test.skipIf(!catalogReplyPath)(
  "realistic three-plugin catalog fits the host bound while child requests stay at 1 MiB",
  () => {
    const frame = {
      type: "daemon-event",
      epoch: "11111111-1111-4111-8111-111111111111",
      frame: catalog(420, 3),
    };
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeGreaterThan(2_000_000);
    expect(() => parseControllerServiceFrame(frame)).not.toThrow();
    expect(() => boundedControllerJson(frame)).toThrow();
    expect(() => serviceBounds.boundedControllerHostInput(frame)).not.toThrow();
    expect(() =>
      serviceBounds.boundedControllerHostInput({
        type: "management",
        data: "x".repeat(2 * 1024 * 1024),
      }),
    ).toThrow();
    expect(() =>
      parseControllerRequest({
        type: "daemon-rpc",
        id: "fixture",
        epoch: frame.epoch,
        frame: frame.frame,
      }),
    ).toThrow();
    const tooLarge = {
      ...frame,
      frame: {
        type: "session",
        message: { type: "status", payload: { status: "x".repeat(8 * 1024 * 1024) } },
      },
    };
    expect(() => parseControllerServiceFrame(tooLarge)).toThrow();
  },
);
