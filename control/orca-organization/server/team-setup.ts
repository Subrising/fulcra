import { randomUUID } from "node:crypto";
import {
  MAIN_SEAT,
  mainAssistant,
  teamChatsRpc,
  teamSetupRpc,
  type TeamChats,
  type TeamSetupResult,
} from "../shared/team";
import { primeName } from "../client/organisation-model";

// Fulcra 0.2.8: one step per team change, built from the controller's own owner-only methods. Each step is a separate
// controller write; when a later step is refused, the steps already done stay done and the reply says which ran
// ("partly"), so nothing is retried behind the owner's back.

type Call = (method: string, input?: unknown) => Promise<any>;
const NOTE = "Set up from Fulcra by its owner";

interface Seat {
  role: string;
  seat: string;
  projectId: string | null;
  state: string;
  revision: number;
  sessionId: string | null;
  session: { generation: number } | null;
}

const reason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2000);

/** The main assistant every view shows (shared/team.ts mainAssistant), from the controller's raw seat list. */
export function mainSeat(seats: Seat[]): Seat | null {
  return mainAssistant(seats.filter((s) => s.role === "prime"));
}

export function createTeamSetup(call: Call, now = () => new Date().toISOString()) {
  const seats = async (): Promise<Seat[]> => (await call("bindings-status")).bindings ?? [];
  const enrol = (sessionId: string, taskId: string) =>
    call("team-enrol", { sessionId, taskId, note: NOTE });

  async function seat(role: string, seatKey: string, sessionId: string, generation: number) {
    const current = (await seats()).find((s) => s.role === role && s.seat === seatKey);
    return call("bindings-assign", {
      role,
      seat: seatKey,
      sessionId,
      expectedRevision: current?.revision ?? 0,
      expectedSessionGeneration: generation,
      note: NOTE,
    });
  }

  /** Put a project under the main assistant, moving it from another main assistant when needed. */
  async function own(projectId: string, primeSeat: string, steps: string[]) {
    const list = await call("remits-list");
    const current = (list?.remits ?? []).find(
      (r: any) => r.scope?.kind === "project" && r.scope.projectId === projectId,
    );
    if (current?.primeSeat === primeSeat) return;
    if (current)
      await call("remits-move", {
        messageId: randomUUID(),
        expectedRevision: current.revision,
        remitId: current.id,
        toPrimeSeat: primeSeat,
        note: NOTE,
      });
    else
      await call("remits-assign", {
        messageId: randomUUID(),
        expectedRevision: 0,
        primeSeat,
        scope: { kind: "project", projectId },
        note: NOTE,
      });
    steps.push(`The project is now under the ${primeName(primeSeat)}.`);
  }

  async function run(
    input: any,
    steps: string[],
  ): Promise<{ message: string; projectId: string | null }> {
    if (input.action === "main-assistant") {
      const directory = await call("bindings-status");
      const enrolled = await enrol(input.sessionId, directory.programme);
      if (enrolled.action !== "already") steps.push("The chat joined the team.");
      const all: Seat[] = directory.bindings ?? [];
      const held = all.find(
        (s) => s.role === "prime" && s.state === "assigned" && s.sessionId === input.sessionId,
      );
      if (held)
        return { message: `This chat is already the ${primeName(held.seat)}.`, projectId: null };
      await seat("prime", MAIN_SEAT, input.sessionId, enrolled.generation);
      steps.push("The chat is now the main assistant.");
      return { message: "This chat is now your main assistant.", projectId: null };
    }
    if (input.action === "project-lead") {
      let projectId: string = input.projectId,
        taskId: string;
      if (input.projectName !== undefined) {
        const created = await call("team-project-create", { name: input.projectName, note: NOTE });
        projectId = created.projectId;
        taskId = created.taskId;
        steps.push(`The project "${created.name}" was added.`);
      } else taskId = (await call("team-project-anchor", { projectId, note: NOTE })).taskId;
      const enrolled = await enrol(input.sessionId, taskId);
      if (enrolled.action === "moved") steps.push("The chat moved to this project.");
      else if (enrolled.action === "enrolled") steps.push("The chat joined the project.");
      await seat("project-orchestrator", projectId, input.sessionId, enrolled.generation);
      steps.push("The chat is now the lead of the project.");
      const main = mainSeat(await seats());
      if (main) await own(projectId, main.seat, steps);
      else steps.push("No main assistant yet, so the project is not under one.");
      return { message: "This chat now leads the project.", projectId };
    }
    if (input.action === "add-workers") {
      const { taskId } = await call("team-project-anchor", {
        projectId: input.projectId,
        note: NOTE,
      });
      let added = 0;
      const refused: string[] = [];
      for (const sessionId of input.sessionIds) {
        try {
          const r = await enrol(sessionId, taskId);
          if (r.action !== "already") added++;
        } catch (error) {
          refused.push(`${sessionId.slice(0, 8)}: ${reason(error)}`);
        }
      }
      steps.push(`${added} ${added === 1 ? "chat" : "chats"} joined the project.`);
      for (const line of refused) steps.push(`Not added: ${line}`);
      if (refused.length)
        throw Object.assign(Error("Some chats could not join."), { partial: true });
      return { message: "The chats are now workers in the project.", projectId: input.projectId };
    }
    if (input.action === "archive-project") {
      await call("team-project-archive", { projectId: input.projectId, note: NOTE });
      steps.push("The project is archived. Its tasks, chats and history are kept.");
      return { message: "The project is archived and hidden.", projectId: input.projectId };
    }
    // retire-main-assistant
    const all = await seats();
    const old = all.find((s) => s.role === "prime" && s.seat === input.seat);
    if (!old || old.state !== "assigned")
      throw Error("That main assistant record is already empty.");
    const next = mainSeat(all.filter((s) => s !== old));
    if (!next) throw Error("Choose a new main assistant first, so Fulcra always shows one.");
    const list = await call("remits-list");
    for (const r of (list?.remits ?? []).filter((r: any) => r.primeSeat === input.seat)) {
      await call("remits-move", {
        messageId: randomUUID(),
        expectedRevision: r.revision,
        remitId: r.id,
        toPrimeSeat: next.seat,
        note: NOTE,
      });
      steps.push("A project moved to the current main assistant.");
    }
    await call("bindings-unassign", {
      role: "prime",
      seat: input.seat,
      expectedRevision: old.revision,
      note: NOTE,
    });
    steps.push(`The old record "${primeName(input.seat)}" is removed. The chat itself is kept.`);
    return { message: "The old main assistant record is removed.", projectId: null };
  }

  return async (value: unknown): Promise<TeamSetupResult> => {
    const input = teamSetupRpc.input.parse(value);
    const steps: string[] = [];
    try {
      const done = await run(input, steps);
      return { status: "done", steps, observedAt: now(), ...done };
    } catch (error) {
      return {
        status: steps.length ? "partly" : "refused",
        message: reason(error),
        steps,
        projectId: null,
        observedAt: now(),
      };
    }
  };
}

interface AgentEntry {
  agent?: {
    id?: string;
    title?: string | null;
    provider?: string;
    status?: string;
    archivedAt?: string | null;
    updatedAt?: string | null;
  };
}

/** The chats on this computer with their place on the team, for the pickers. */
export function createTeamChats(
  call: Call,
  list: () => Promise<{ entries: AgentEntry[]; complete: boolean }>,
  projects: () => Promise<{
    projects: { id: string; name: string }[];
    membership: { taskId: string; projectId: string | null }[];
  }>,
  now = () => new Date().toISOString(),
) {
  return async (): Promise<TeamChats> => {
    try {
      const [listed, directory, status, enrolled] = await Promise.all([
        list(),
        projects().catch(() => ({ projects: [], membership: [] })),
        call("bindings-status"),
        call("list").catch(() => []),
      ]);
      const names = new Map(directory.projects.map((p) => [p.id, p.name]));
      const projectOfTask = new Map(directory.membership.map((m) => [m.taskId, m.projectId]));
      const role = new Map<string, string>();
      for (const row of Array.isArray(enrolled) ? enrolled : []) {
        const project = projectOfTask.get(row.task);
        if (project && names.has(project)) role.set(row.id, `Worker in ${names.get(project)}`);
      }
      for (const s of (status.bindings ?? []) as Seat[]) {
        if (s.state !== "assigned" || !s.sessionId) continue;
        if (s.role === "prime") role.set(s.sessionId, primeName(s.seat));
        else if (s.projectId && names.has(s.projectId))
          role.set(s.sessionId, `Lead of ${names.get(s.projectId)}`);
      }
      const chats = listed.entries
        .map((e) => e.agent)
        .filter((a): a is NonNullable<AgentEntry["agent"]> & { id: string } =>
          Boolean(a?.id && !a.archivedAt),
        )
        .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
        .slice(0, 500)
        .map((a) => ({
          id: a.id,
          title: (a.title?.trim() || "Untitled chat").slice(0, 200),
          provider: String(a.provider ?? "unknown").slice(0, 40),
          running: a.status === "running",
          updatedAt: a.updatedAt ? String(a.updatedAt).slice(0, 40) : null,
          role: role.get(a.id) ?? null,
        }));
      return teamChatsRpc.output.parse({
        observedAt: now(),
        available: true,
        complete: listed.complete,
        chats,
        note: listed.complete ? null : "Only the newest chats are listed.",
      });
    } catch (error) {
      return {
        observedAt: now(),
        available: false,
        complete: false,
        chats: [],
        note: reason(error).slice(0, 500),
      };
    }
  };
}
