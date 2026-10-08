import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PluginAgentPanelProps,
  PluginClientContext,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import type { ContractSend } from "../shared/rpc-contract";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import { projectsRpc } from "../shared/projects";
import { roleDirectoryRpc } from "../shared/roles";
import { teamChatsRpc, teamSetupRpc, type TeamChat, type TeamSetupResult } from "../shared/team";
import { primeName } from "./organisation-model";

// Fulcra 0.2.8: set up the team in one step from chats that already exist. "Make main assistant" and "Make lead of
// project…" open from any chat (its menu) and from Leads; Leads also adds workers, archives a project and removes an
// old main assistant record. Plain words only: main assistant, lead, worker.

type Theme = PluginSurfaceProps["theme"];
type Setup = ContractSend<typeof teamSetupRpc>;
interface Project {
  id: string;
  name: string;
}

export const TEAM_PANEL = "team-role";

function useTeamWrite() {
  const write = useContract(teamSetupRpc);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TeamSetupResult | null>(null);
  const run = async (input: Setup) => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await write(input));
    } catch (error) {
      setResult({
        status: "refused",
        message: error instanceof Error ? error.message : "The change could not be made.",
        steps: [],
        projectId: null,
        observedAt: new Date().toISOString(),
      });
    } finally {
      setBusy(false);
      // Every Fulcra view reads these; refresh them so the new main assistant and leads show at once.
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("orca-") });
    }
  };
  return { run, busy, result, clear: () => setResult(null) };
}

function useProjects(hostId: string | undefined) {
  const read = useContract(projectsRpc);
  const query = useQuery({
    queryKey: ["orca-projects", hostId],
    queryFn: () => read({}),
    retry: false,
  });
  return (query.data?.projects ?? []) as Project[];
}

function useChats(hostId: string | undefined) {
  const read = useContract(teamChatsRpc);
  return useQuery({
    queryKey: ["orca-team-chats", hostId],
    queryFn: () => read({}),
    retry: false,
  });
}

export function SetupResult({ theme, result }: { theme: Theme; result: TeamSetupResult | null }) {
  if (!result) return null;
  const c = theme.colors;
  const failed = result.status !== "done";
  return (
    <View accessibilityLiveRegion="polite" testID="team-setup-result" style={{ gap: 4 }}>
      <Text
        style={{
          color: failed ? (c.statusDanger) : c.foreground,
          fontWeight: "600",
        }}
      >
        {result.status === "partly" ? `Not finished: ${result.message}` : result.message}
      </Text>
      {result.steps.map((step, n) => (
        <Text key={`${n}:${step}`} style={{ color: c.foregroundMuted }}>
          {`· ${step}`}
        </Text>
      ))}
    </View>
  );
}

function Choice({
  theme,
  label,
  detail,
  selected,
  multi,
  onPress,
  testID,
}: {
  theme: Theme;
  label: string;
  detail: string | null;
  selected: boolean;
  multi: boolean;
  onPress: () => void;
  testID: string;
}) {
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole={multi ? "checkbox" : "radio"}
      accessibilityState={{ checked: selected }}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      onPress={onPress}
      testID={testID}
      style={{
        minHeight: 48,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: selected ? (c.accent ?? c.foreground) : c.border,
        backgroundColor: selected ? (c.surface2 ?? c.surface0) : (c.surface1 ?? c.surface0),
      }}
    >
      <Text style={{ color: c.foreground, width: 20 }}>
        {selected ? (multi ? "☑" : "●") : multi ? "☐" : "○"}
      </Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: c.foreground }}>
          {label}
        </Text>
        {detail ? (
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function chatDetail(chat: TeamChat) {
  return [
    chat.role,
    chat.running ? "working now" : null,
    chat.provider === "codex" ? "Codex" : "Claude",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ChatPicker({
  theme,
  hostId,
  selected,
  multi,
  onChange,
}: {
  theme: Theme;
  hostId: string | undefined;
  selected: string[];
  multi: boolean;
  onChange: (ids: string[]) => void;
}) {
  const query = useChats(hostId);
  const [filter, setFilter] = useState("");
  const c = theme.colors;
  const all = query.data?.chats ?? [];
  const words = filter.trim().toLowerCase();
  const shown = (
    words ? all.filter((chat) => chat.title.toLowerCase().includes(words)) : all
  ).slice(0, 12);
  const toggle = (id: string) =>
    onChange(
      multi ? (selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]) : [id],
    );
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        value={filter}
        onChangeText={setFilter}
        placeholder="Find a chat by name"
        placeholderTextColor={c.foregroundMuted}
        accessibilityLabel="Find a chat by name"
        testID="team-chat-filter"
        style={{
          color: c.foreground,
          borderColor: c.border,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 12,
          minHeight: 48,
        }}
      />
      {query.isPending ? (
        <Text style={{ color: c.foregroundMuted }}>Reading your chats…</Text>
      ) : null}
      {query.data && !query.data.available ? (
        <Text
          style={{ color: c.foregroundMuted }}
        >{`Your chats could not be read: ${query.data.note ?? "try again"}`}</Text>
      ) : null}
      {query.data?.available && !shown.length ? (
        <Text style={{ color: c.foregroundMuted }}>No chat matches.</Text>
      ) : null}
      {shown.map((chat) => (
        <Choice
          key={chat.id}
          theme={theme}
          label={chat.title}
          detail={chatDetail(chat)}
          selected={selected.includes(chat.id)}
          multi={multi}
          onPress={() => toggle(chat.id)}
          testID={`team-chat-${chat.id}`}
        />
      ))}
    </View>
  );
}

export function ProjectPicker({
  theme,
  projects,
  value,
  onChange,
  newName,
  onNewName,
}: {
  theme: Theme;
  projects: Project[];
  value: string | null;
  onChange: (id: string | null) => void;
  newName?: string;
  onNewName?: (name: string) => void;
}) {
  const c = theme.colors;
  return (
    <View style={{ gap: 8 }}>
      {projects.map((project) => (
        <Choice
          key={project.id}
          theme={theme}
          label={project.name}
          detail={null}
          selected={value === project.id}
          multi={false}
          onPress={() => onChange(project.id)}
          testID={`team-project-${project.id}`}
        />
      ))}
      {onNewName ? (
        <TextInput
          value={newName}
          onChangeText={(text) => {
            onNewName(text);
            if (text.trim()) onChange(null);
          }}
          placeholder="Or type a new project name"
          placeholderTextColor={c.foregroundMuted}
          accessibilityLabel="New project name"
          testID="team-project-new"
          style={{
            color: c.foreground,
            borderColor: c.border,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 12,
            minHeight: 48,
          }}
        />
      ) : null}
    </View>
  );
}

function leadInput(sessionId: string, projectId: string | null, newName: string): Setup | null {
  if (projectId) return { action: "project-lead", sessionId, projectId };
  if (newName.trim()) return { action: "project-lead", sessionId, projectName: newName.trim() };
  return null;
}

/** "Make main assistant" and "Make lead of project…" for one chat: its menu opens this panel. */
export function TeamRolePanel({
  theme,
  agentId,
  host,
}: Pick<PluginAgentPanelProps, "theme" | "agentId" | "host">) {
  const c = theme.colors;
  const projects = useProjects(host?.id);
  const chats = useChats(host?.id);
  const write = useTeamWrite();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const role = chats.data?.chats.find((chat) => chat.id === agentId)?.role ?? null;
  const lead = leadInput(agentId, projectId, newName);
  return (
    <View
      testID="team-role-panel"
      style={{ flex: 1, backgroundColor: c.surface0, padding: 12, gap: 12 }}
    >
      <Text style={{ color: c.foreground, fontWeight: "600" }}>
        {role ? `This chat: ${role}` : "This chat is not on your team yet."}
      </Text>
      <WorkButton
        theme={theme}
        label="Make main assistant"
        disabled={write.busy}
        onPress={() => void write.run({ action: "main-assistant", sessionId: agentId })}
      />
      <Text style={{ color: c.foreground, fontWeight: "600" }}>Make lead of project…</Text>
      <ProjectPicker
        theme={theme}
        projects={projects}
        value={projectId}
        onChange={setProjectId}
        newName={newName}
        onNewName={setNewName}
      />
      <WorkButton
        theme={theme}
        label="Make lead"
        disabled={write.busy || !lead}
        onPress={() => lead && void write.run(lead)}
      />
      <SetupResult theme={theme} result={write.result} />
    </View>
  );
}

type Mode = "main" | "lead" | "workers" | "archive" | null;
const MODES: { mode: Exclude<Mode, null>; label: string }[] = [
  { mode: "main", label: "Make main assistant" },
  { mode: "lead", label: "Make lead of project…" },
  { mode: "workers", label: "Adopt existing chats" },
  { mode: "archive", label: "Archive a project" },
];

function ModeBody({
  props,
  mode,
  write,
}: {
  props: PluginSurfaceProps;
  mode: Exclude<Mode, null>;
  write: ReturnType<typeof useTeamWrite>;
}) {
  const theme = props.theme;
  const projects = useProjects(props.host?.id);
  const [chats, setChats] = useState<string[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const muted = { color: theme.colors.foregroundMuted };
  if (mode === "archive")
    return (
      <View style={{ gap: 8 }}>
        <Text style={muted}>
          The project is hidden from every list. Its tasks, chats and history are kept.
        </Text>
        <ProjectPicker
          theme={theme}
          projects={projects}
          value={projectId}
          onChange={setProjectId}
        />
        <WorkButton
          theme={theme}
          label="Archive project"
          disabled={write.busy || !projectId}
          onPress={() => projectId && void write.run({ action: "archive-project", projectId })}
        />
      </View>
    );
  if (mode === "workers")
    return (
      <View style={{ gap: 8 }}>
        <Text style={muted}>Choose the project, then tick the chats that work in it.</Text>
        <ProjectPicker
          theme={theme}
          projects={projects}
          value={projectId}
          onChange={setProjectId}
        />
        <ChatPicker
          theme={theme}
          hostId={props.host?.id}
          selected={chats}
          multi
          onChange={setChats}
        />
        <WorkButton
          theme={theme}
          label={
            chats.length
              ? `Add ${chats.length} ${chats.length === 1 ? "chat" : "chats"} as workers`
              : "Add as workers"
          }
          disabled={write.busy || !projectId || !chats.length}
          onPress={() =>
            projectId && void write.run({ action: "add-workers", projectId, sessionIds: chats })
          }
        />
      </View>
    );
  const sessionId = chats[0] ?? null;
  const lead = sessionId ? leadInput(sessionId, projectId, newName) : null;
  return (
    <View style={{ gap: 8 }}>
      <Text style={muted}>Choose the chat.</Text>
      <ChatPicker
        theme={theme}
        hostId={props.host?.id}
        selected={chats}
        multi={false}
        onChange={setChats}
      />
      {mode === "lead" ? (
        <>
          <Text style={muted}>Choose its project, or type a new one.</Text>
          <ProjectPicker
            theme={theme}
            projects={projects}
            value={projectId}
            onChange={setProjectId}
            newName={newName}
            onNewName={setNewName}
          />
        </>
      ) : null}
      <WorkButton
        theme={theme}
        label={mode === "main" ? "Make main assistant" : "Make lead"}
        disabled={write.busy || !sessionId || (mode === "lead" && !lead)}
        onPress={() => {
          if (mode === "main" && sessionId) void write.run({ action: "main-assistant", sessionId });
          else if (lead) void write.run(lead);
        }}
      />
    </View>
  );
}

function OldRecords({
  props,
  write,
}: {
  props: PluginSurfaceProps;
  write: ReturnType<typeof useTeamWrite>;
}) {
  const read = useContract(roleDirectoryRpc);
  const roles = useQuery({
    queryKey: ["orca-role-directory", props.host?.id],
    queryFn: () => read({}),
    retry: false,
  });
  const held = (roles.data?.primes ?? []).filter((s) => s.state === "assigned" && s.sessionId);
  if (held.length < 2) return null;
  const c = props.theme.colors;
  return (
    <View style={{ gap: 8 }} testID="team-old-records">
      <Text style={{ color: c.foregroundMuted }}>
        {`You have ${held.length} main assistant records. Keep one; remove the others. The chats are kept.`}
      </Text>
      {held
        .filter((s) => s.seat !== "main")
        .map((s) => (
          <WorkButton
            key={s.seat}
            theme={props.theme}
            label={`Remove the "${primeName(s.seat)}" record`}
            disabled={write.busy}
            onPress={() => void write.run({ action: "retire-main-assistant", seat: s.seat })}
          />
        ))}
    </View>
  );
}

/** The Leads page's "Set up your team" card. */
export function TeamSetupCard(props: PluginSurfaceProps) {
  const [mode, setMode] = useState<Mode>(null);
  const write = useTeamWrite();
  const c = props.theme.colors;
  return (
    <View
      testID="team-setup"
      style={{ gap: 12, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: c.border }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: c.foreground, fontSize: 18, fontWeight: "600" }}
      >
        Set up your team
      </Text>
      <Text style={{ color: c.foregroundMuted }}>
        Use the chats you already have. One main assistant leads everything; each project has one
        lead; workers help a lead.
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {MODES.map((m) => (
          <WorkButton
            key={m.mode}
            theme={props.theme}
            label={m.label}
            selected={mode === m.mode}
            onPress={() => {
              write.clear();
              setMode(mode === m.mode ? null : m.mode);
            }}
          />
        ))}
      </View>
      {mode ? <ModeBody key={mode} props={props} mode={mode} write={write} /> : null}
      <OldRecords props={props} write={write} />
      <SetupResult theme={props.theme} result={write.result} />
    </View>
  );
}

type Client = Partial<Pick<PluginClientContext, "addWorkspacePanel" | "addCommandCenterItem">>;
/** "Make main assistant" and "Make lead of project…" in every chat's menu. */
export function registerTeamRole(client: Client) {
  if (typeof client.addWorkspacePanel !== "function") return () => {};
  const off = [
    client.addWorkspacePanel({
      id: TEAM_PANEL,
      title: "Team role…",
      icon: "Crown",
      context: "agent",
      Component: TeamRolePanel,
    }),
  ];
  if (typeof client.addCommandCenterItem === "function")
    for (const [id, title] of [
      ["team-main-assistant", "Make main assistant"],
      ["team-project-lead", "Make lead of project…"],
    ] as const)
      off.push(
        client.addCommandCenterItem({
          id,
          context: "agent",
          title,
          icon: "Crown",
          keywords: ["team", "lead", "main assistant", "worker", "project"],
          onSelect: (ctx) => ctx.openPanel(TEAM_PANEL),
        }),
      );
  return () => off.forEach((dispose) => dispose());
}
