import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ProjectDirectory } from "../shared/projects";
import type { Fleet } from "../shared/fleet";
import { WorkButton } from "./work-button";

export const UNGROUPED = "ungrouped";
export function projectTaskIds(directory?: ProjectDirectory) {
  return new Map(
    directory?.available ? directory.membership.map((row) => [row.taskId, row.projectId]) : [],
  );
}
export function ProjectPicker({
  theme,
  directory,
  tasks,
  selected,
  stale,
  onSelect,
}: Pick<PluginSurfaceProps, "theme"> & {
  directory?: ProjectDirectory;
  tasks: Fleet["tasks"];
  selected: string | null;
  stale: boolean;
  onSelect: (id: string | null) => void;
}) {
  const c = theme.colors,
    membership = projectTaskIds(directory),
    current = directory?.projects.find((p) => p.id === selected);
  const count = tasks.filter((t) => membership.get(t.id) === current?.id).length;
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>Projects</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <WorkButton
          theme={theme}
          label="All recorded work"
          selected={selected === null}
          onPress={() => onSelect(null)}
        />
        {directory?.projects.map((project) => (
          <WorkButton
            key={project.id}
            theme={theme}
            label={`Project: ${project.name}`}
            selected={selected === project.id}
            onPress={() => onSelect(project.id)}
          >
            {project.name}
          </WorkButton>
        ))}
        {!!directory?.projects.length && (
          <WorkButton
            theme={theme}
            label="Work without a verified project"
            selected={selected === UNGROUPED}
            onPress={() => onSelect(UNGROUPED)}
          >
            Other recorded work
          </WorkButton>
        )}
      </View>
      {stale && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted }}>
          Project membership is unavailable or outdated. Saved grouping is shown where available;
          activity is observed separately.
        </Text>
      )}
      {directory?.partial && <Text style={{ color: c.foregroundMuted }}>{directory.note}</Text>}
      {directory?.available && !directory.projects.length && (
        <Text style={{ color: c.foregroundMuted }}>
          No projects are registered yet. Your existing work remains below.
        </Text>
      )}
      {current && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "600" }}>
            {current.name}
          </Text>
          {current.description && (
            <Text style={{ color: c.foregroundMuted, lineHeight: 22 }}>{current.description}</Text>
          )}
          <Text style={{ color: c.foregroundMuted }}>
            {count} visible {count === 1 ? "workstream" : "workstreams"} · Project:{" "}
            {current.status.replaceAll("_", " ")}
          </Text>
        </View>
      )}
      {selected && selected !== UNGROUPED && !current && (
        <Text style={{ color: c.foregroundMuted }}>
          The selected project is no longer available in this directory. Choose All recorded work to
          inspect retained conversations.
        </Text>
      )}
      {selected === UNGROUPED && (
        <Text style={{ color: c.foregroundMuted }}>
          Work with no project recorded or whose project membership is unknown.
        </Text>
      )}
    </View>
  );
}
