// The Team tab's front: who is in charge of what and what each is doing now, as a tree of plain cards (model in
// team-tree.ts). Reads the same cached fleet, role and project observations as Leadership, so nothing is read twice.
import { createContext, useContext, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import { fleetRpc } from "../shared/fleet";
import { projectsRpc } from "../shared/projects";
import { roleDirectoryRpc } from "../shared/roles";
import { mainAssistant } from "../shared/team";
import { buildTeamTree, type TeamCard, type TeamState } from "./team-tree";
import { FreshStartButton } from "./fresh-start-view";
import { PendingQuestions, questionServerId } from "./pending-questions";

/** The host whose controller can start a lead fresh; null where the tree is shown without one (tests, previews). */
const FreshStartHost = createContext<string | null>(null);

type Theme = PluginSurfaceProps["theme"];

function stateColour(state: TeamState, c: Theme["colors"]): string {
  if (state === "working") return c.statusSuccess;
  if (state === "waiting") return c.statusWarning;
  if (state === "paused") return c.accent;
  return c.foregroundMuted;
}

function Card({
  card,
  parent,
  theme,
  openAgent,
}: {
  card: TeamCard;
  parent: TeamCard | null;
  theme: Theme;
  openAgent: ((card: TeamCard) => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const freshStartHost = useContext(FreshStartHost);
  const c = theme.colors;
  const colour = stateColour(card.state, c);
  const relation = parent ? (card.role === "worker" ? "runs" : "leads") : null;
  let reports = "Reports to you";
  if (parent) reports = `Reports to ${parent.roleLabel}`;
  else if (card.noLine) reports = "No reporting line";
  return (
    <View style={{ gap: 6 }}>
      {relation && (
        <Text style={{ color: c.foregroundMuted, fontSize: 12, marginLeft: 4 }}>
          {`↳ ${parent!.roleLabel.split(" · ")[0]} ${relation}`}
        </Text>
      )}
      <Pressable
        testID={`team-card-${card.id}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${card.roleLabel}, ${card.stateLabel}. ${card.now}`}
        onPress={() => setOpen(!open)}
        style={{
          gap: 4,
          padding: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: card.state === "waiting" || card.state === "working" ? colour : c.border,
          backgroundColor: c.surface1,
        }}
      >
        <Text style={{ color: c.foreground, fontWeight: "700" }}>{card.roleLabel}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colour }} />
          <Text testID="team-card-state" style={{ color: c.foreground }}>
            {card.stateLabel}
            {card.runs ? ` · ${card.runs}` : ""}
          </Text>
        </View>
        <Text testID="team-card-now" style={{ color: c.foregroundMuted }}>
          {card.now}
        </Text>
        {card.noLine && card.sessions === 1 && (
          <Text testID="team-card-no-line" style={{ color: c.statusWarning }}>
            No reporting line. Set one in team setup.
          </Text>
        )}
        {open && (
          <View testID="team-card-detail" style={{ gap: 4, marginTop: 6 }}>
            <Text style={{ color: c.foregroundMuted }}>
              {reports}
              {card.children.length
                ? ` · ${card.role === "main" ? "leads" : "runs"} ${card.children.length}`
                : ""}
            </Text>
            <Text style={{ color: c.foregroundMuted }}>
              {card.sessions > 1 ? `${card.sessions} sessions on ${card.host}` : `On ${card.host}`}
            </Text>
            {card.directLink && (
              <Text style={{ color: c.foregroundMuted }}>{`Direct link: ${card.directLink}`}</Text>
            )}
            {openAgent && card.agentId && card.serverId && (
              <View style={{ flexDirection: "row" }}>
                <WorkButton
                  theme={theme}
                  label={card.state === "waiting" ? "Open chat to answer" : "Open chat"}
                  onPress={() => openAgent(card)}
                >
                  {card.state === "waiting" ? "Open chat to answer" : "Open chat"}
                </WorkButton>
              </View>
            )}
            {freshStartHost !== null && card.role !== "worker" && card.sessions === 1 && (
              <FreshStartButton sessionId={card.id} theme={theme} hostId={freshStartHost} />
            )}
          </View>
        )}
      </Pressable>
      {card.state === "waiting" && card.serverId && card.agentId && (
        <PendingQuestions
          serverId={card.serverId}
          agentId={card.agentId}
          testID={`team-card-questions-${card.id}`}
        />
      )}
      {card.children.length > 0 && (
        <View
          style={{
            gap: 10,
            marginLeft: 14,
            paddingLeft: 12,
            borderLeftWidth: 2,
            borderLeftColor: c.border,
          }}
        >
          {card.children.map((child) => (
            <Card key={child.id} card={child} parent={card} theme={theme} openAgent={openAgent} />
          ))}
        </View>
      )}
    </View>
  );
}

export function TeamTreeView({
  cards,
  summary,
  theme,
  openAgent,
}: {
  cards: TeamCard[];
  summary: string;
  theme: Theme;
  openAgent: ((card: TeamCard) => void) | null;
}) {
  const c = theme.colors;
  return (
    <View testID="team-tree" style={{ gap: 12 }}>
      <View style={{ gap: 2 }}>
        <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "700" }}>
          Who is in charge
        </Text>
        <Text testID="team-tree-summary" style={{ color: c.foregroundMuted }}>
          {summary}
        </Text>
      </View>
      {cards.length > 0 && (
        <View
          style={{
            alignSelf: "flex-start",
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: c.border,
          }}
        >
          <Text style={{ color: c.foreground }}>You</Text>
        </View>
      )}
      {cards.length > 0 ? (
        <View
          style={{
            gap: 10,
            marginLeft: 14,
            paddingLeft: 12,
            borderLeftWidth: 2,
            borderLeftColor: c.border,
          }}
        >
          {cards.map((card) => (
            <Card key={card.id} card={card} parent={null} theme={theme} openAgent={openAgent} />
          ))}
        </View>
      ) : (
        <Text style={{ color: c.foregroundMuted }}>
          Sessions you start, and the ones they start, show here with who leads whom.
        </Text>
      )}
    </View>
  );
}

/** The live tree for this host: same query keys as Leadership, refreshed on the same cadence. */
export function TeamTreeSection(props: Pick<PluginSurfaceProps, "theme" | "host" | "navigation">) {
  const hostId = props.host?.id;
  const readFleet = useContract(fleetRpc),
    readProjects = useContract(projectsRpc),
    readRoles = useContract(roleDirectoryRpc);
  const options = { retry: false, refetchInterval: 15000, refetchIntervalInBackground: false };
  const fleet = useQuery({
    queryKey: ["orca-fleet", hostId],
    queryFn: () => readFleet({}),
    ...options,
  });
  const projects = useQuery({
    queryKey: ["orca-projects", hostId],
    queryFn: () => readProjects({}),
    ...options,
  });
  const roles = useQuery({
    queryKey: ["orca-role-directory", hostId],
    queryFn: () => readRoles({}),
    ...options,
  });
  const c = props.theme.colors;
  if (!fleet.data)
    return (
      <Text style={{ color: c.foregroundMuted }}>
        {fleet.isError
          ? "Couldn't read who is working. Try again in a moment."
          : "Reading who is working…"}
      </Text>
    );
  const assigned = (seats: { state: string; sessionId: string | null }[] | undefined) =>
    new Set(
      (seats ?? []).flatMap((s) => (s.state === "assigned" && s.sessionId ? [s.sessionId] : [])),
    );
  const projectNames = new Map((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
  // Seats of archived projects are not shown: their project is hidden from every list.
  const leadSeats = (roles.data?.available ? roles.data.projectSeats : []).filter(
    (s) => s.state === "assigned" && s.sessionId && s.projectId && projectNames.has(s.projectId),
  );
  const tree = buildTeamTree({
    // Unbound sessions belong to the host this screen is connected to (see questionServerId).
    nodes: fleet.data.nodes.map((n) =>
      n.serverId ? n : { ...n, serverId: questionServerId(n, hostId) },
    ),
    edges: fleet.data.edges,
    mainSessionIds: roles.data?.available ? assigned(roles.data.primes) : undefined,
    mainSessionId: roles.data?.available ? mainAssistant(roles.data.primes)?.sessionId : null,
    leadSessionIds: roles.data?.available ? assigned(leadSeats) : undefined,
    leadByProject: new Map(leadSeats.map((s) => [s.projectId!, s.sessionId!])),
    projectNames,
  });
  const navigation = props.navigation;
  const openAgent = navigation?.openAgentOnHost
    ? (card: TeamCard) => {
        if (card.serverId && card.agentId)
          navigation.openAgentOnHost!({ serverId: card.serverId, agentId: card.agentId });
      }
    : null;
  return (
    <View style={{ gap: 8 }}>
      <FreshStartHost.Provider value={hostId ?? ""}>
        <TeamTreeView
          cards={tree.roots}
          summary={tree.summary}
          theme={props.theme}
          openAgent={openAgent}
        />
      </FreshStartHost.Provider>
      {fleet.data.partial && (
        <Text style={{ color: c.foregroundMuted }}>
          Some sessions could not be read, so the tree may be missing a few.
        </Text>
      )}
    </View>
  );
}
