import { describe, expect, it } from "vitest";
import { buildAgentLsFetchOptions, toListItem } from "./ls.js";

describe("buildAgentLsFetchOptions", () => {
  it("fetches active agents by default", () => {
    expect(buildAgentLsFetchOptions({})).toEqual({
      scope: "active",
    });
  });

  it("keeps label and thinking filters within the active scope", () => {
    expect(
      buildAgentLsFetchOptions({
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      scope: "active",
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });

  it("fetches global non-archived agents for -g", () => {
    expect(buildAgentLsFetchOptions({ global: true })).toEqual({});
  });

  it("keeps -a within the active scope", () => {
    expect(buildAgentLsFetchOptions({ all: true })).toEqual({
      scope: "active",
      filter: {
        includeArchived: true,
      },
    });
  });

  it("fetches all global agents for -a -g", () => {
    expect(buildAgentLsFetchOptions({ all: true, global: true })).toEqual({
      filter: {
        includeArchived: true,
      },
    });
  });

  it("applies filters to global queries", () => {
    expect(
      buildAgentLsFetchOptions({
        global: true,
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });
});

describe("ls status of an unloaded session", () => {
  const base = {
    id: "dormant",
    title: "Dormant",
    provider: "claude",
    model: null,
    status: "idle",
    nativeLifecycle: "closed",
    cwd: "/tmp",
    createdAt: new Date().toISOString(),
  } as Parameters<typeof toListItem>[0];

  it("shows the stored status and a note for a reopened session that is not loaded", () => {
    expect(toListItem(base)).toMatchObject({ status: "idle", note: "not loaded" });
    expect(toListItem({ ...base, status: "running" })).toMatchObject({
      status: "running",
      note: "not loaded",
    });
  });

  it("keeps closed for a record that really closed", () => {
    expect(toListItem({ ...base, status: "closed" })).toMatchObject({ status: "closed", note: "" });
  });

  it("shows a loaded session as it is", () => {
    expect(toListItem({ ...base, nativeLifecycle: undefined })).toMatchObject({
      status: "idle",
      note: "",
    });
    expect(toListItem({ ...base, nativeLifecycle: "running", status: "running" })).toMatchObject({
      status: "running",
      note: "",
    });
  });
});
