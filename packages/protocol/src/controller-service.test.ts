import { expect, test } from "vitest";
import { parseControllerServiceFrame } from "./controller-service.js";
const epoch = "11111111-1111-4111-8111-111111111111";
test("IR-8 host service frames have an explicit version and use public normalization", () => {
  const welcome = {
    type: "daemon-open",
    version: 1,
    epoch,
    frame: {
      type: "session",
      message: {
        type: "status",
        payload: { status: "server_info", serverId: "fixture", hostname: { legacy: true } },
      },
    },
  };
  expect(parseControllerServiceFrame(welcome)).toMatchObject({
    version: 1,
    frame: { message: { payload: { hostname: { legacy: true } } } },
  });
  expect(
    parseControllerServiceFrame({
      type: "daemon-event",
      version: 1,
      epoch,
      frame: { type: "pong", legacy: "public schema discards this" },
    }),
  ).toEqual({ type: "daemon-event", version: 1, epoch, frame: { type: "pong" } });
  expect(() => parseControllerServiceFrame({ ...welcome, version: 2 })).toThrow();
  expect(() => parseControllerServiceFrame({ ...welcome, version: undefined })).toThrow();
  expect(() => parseControllerServiceFrame({ ...welcome, admission: { owner: true } })).toThrow();
});
