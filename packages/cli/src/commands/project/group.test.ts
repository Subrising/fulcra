import { describe, expect, it } from "vitest";
import type {
  AgentSnapshotPayload,
  WorkspaceDescriptorPayload,
  WorkspaceProjectDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { groupSessionProjects } from "./group.js";

const projects = [
  {
    projectId: "one",
    projectDisplayName: "uuid-one",
    projectRootPath: "/tasks/one",
    projectKind: "directory",
  },
  {
    projectId: "two",
    projectDisplayName: "uuid-two",
    projectRootPath: "/tasks/two",
    projectKind: "directory",
  },
] as WorkspaceProjectDescriptorPayload[];
const workspaces = projects.map((project) => ({
  id: project.projectId,
  projectId: project.projectId,
})) as WorkspaceDescriptorPayload[];
const agent = (id: string, workspaceId: string, labels: Record<string, string>) =>
  ({
    id,
    workspaceId,
    cwd: `/tasks/${workspaceId}`,
    labels,
    archivedAt: null,
  }) as AgentSnapshotPayload;
describe("groupSessionProjects", () => {
  it("groups labelled sessions across folders and falls back to folders without a label", () => {
    expect(
      groupSessionProjects({
        projects,
        workspaces,
        agents: [
          agent("a", "one", { project: "fulcra" }),
          agent("b", "two", { project: "fulcra" }),
          agent("c", "one", {}),
          { ...agent("d", "two", {}), archivedAt: "2026-10-13" },
        ],
      }),
    ).toEqual([
      { projectId: "label:fulcra", name: "fulcra", kind: "label", path: "2 folders", sessions: 2 },
      { projectId: "one", name: "uuid-one", kind: "directory", path: "/tasks/one", sessions: 1 },
    ]);
  });
});
