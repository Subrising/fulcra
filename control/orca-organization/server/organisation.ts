// Fulcra J1 Organisation, server side. Thin, typed views over the controller's operator methods
// (src/control/remits.mjs, briefs.mjs); the controller is the only authority and re-checks every rule. This file
// adds three things only:
//   - live session counts and last activity for a project, from the fleet the other tabs already read;
//   - the last good value, returned marked out of date when the controller does not answer (CONTRACTS §1);
//   - per-item validation, so one malformed record drops out instead of blanking the whole view.
import {
  remitsRpc,
  remitsView,
  remit,
  projectDomain,
  remitProject,
  remitHistoryEntry,
  primeSeat,
  remitAssignRpc,
  remitMoveRpc,
  remitEndRpc,
  projectDomainSetRpc,
} from "../shared/cc/remit";
import { projectBrief, projectBriefRpc } from "../shared/cc/brief";
import { briefStale } from "../shared/cc/brief-rules.mjs";
import type { ContractInput, ContractOutput } from "../shared/rpc-contract";
import type { Fleet } from "../shared/fleet";
import type { ProjectDirectory } from "../shared/projects";
type Call = (method: string, input?: unknown) => Promise<any>;
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const message = (e: unknown) => clip(e instanceof Error ? e.message : String(e), 500);
const valid = <T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  items: unknown,
) =>
  (Array.isArray(items) ? items : []).flatMap((i) => {
    const r = schema.safeParse(i);
    return r.success ? [r.data] : [];
  });
const latest = (times: (string | null | undefined)[]) =>
  times
    .filter((t): t is string => typeof t === "string" && Number.isFinite(Date.parse(t)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1) ?? null;

export function createOrganisation({
  call,
  fleet,
  projects,
  now = () => new Date().toISOString(),
}: {
  call: Call;
  fleet: () => Promise<Fleet>;
  projects: () => Promise<ProjectDirectory>;
  now?: () => string;
}) {
  let lastRemits: ContractOutput<typeof remitsRpc> | null = null;
  const lastBriefs = new Map<string, ContractOutput<typeof projectBriefRpc>>();
  // Each caller states its contract output type; `pick` parses the controller's answer with the contract schema.
  const write = async (
    method: string,
    input: unknown,
    pick: (d: any) => object,
    empty: object,
  ): Promise<any> => {
    const observedAt = now();
    try {
      return { ok: true, message: null, observedAt, ...pick(await call(method, input)) };
    } catch (e) {
      // A refusal is an answer, not a failure: "Changed since you looked; refresh", "Give a reason of 12 to 500 characters".
      return { ok: false, message: message(e), observedAt, ...empty };
    }
  };
  return {
    async remits(): Promise<ContractOutput<typeof remitsRpc>> {
      const observedAt = now();
      try {
        const d = await call("remits-list", null);
        const parts = {
          primes: valid(primeSeat, d.primes),
          remits: valid(remit, d.remits),
          domains: valid(projectDomain, d.domains),
          projects: valid(remitProject, d.projects),
          history: valid(remitHistoryEntry, d.history),
        };
        const dropped =
          parts.primes.length !== (d.primes?.length ?? 0) ||
          parts.remits.length !== (d.remits?.length ?? 0) ||
          parts.projects.length !== (d.projects?.length ?? 0) ||
          parts.history.length !== (d.history?.length ?? 0);
        lastRemits = remitsView.parse({
          version: 1,
          observedAt: d.observedAt,
          partial: Boolean(d.partial) || dropped,
          stale: false,
          error: null,
          ...parts,
        });
        return lastRemits;
      } catch (e) {
        if (lastRemits) return { ...lastRemits, stale: true, error: message(e) };
        return {
          version: 1,
          observedAt,
          partial: true,
          stale: true,
          error: message(e),
          primes: [],
          remits: [],
          domains: [],
          projects: [],
          history: [],
        };
      }
    },
    assign: (
      input: ContractInput<typeof remitAssignRpc>,
    ): Promise<ContractOutput<typeof remitAssignRpc>> =>
      write("remits-assign", input, (d) => ({ remit: remit.parse(d.remit) }), { remit: null }),
    move: (
      input: ContractInput<typeof remitMoveRpc>,
    ): Promise<ContractOutput<typeof remitMoveRpc>> =>
      write(
        "remits-move",
        input,
        (d) => ({ remit: remit.parse(d.remit), ended: remit.parse(d.ended) }),
        { remit: null, ended: null },
      ),
    end: (input: ContractInput<typeof remitEndRpc>): Promise<ContractOutput<typeof remitEndRpc>> =>
      write("remits-end", input, (d) => ({ remit: remit.parse(d.remit) }), { remit: null }),
    domainSet: (
      input: ContractInput<typeof projectDomainSetRpc>,
    ): Promise<ContractOutput<typeof projectDomainSetRpc>> =>
      write("remits-domain-set", input, (d) => ({ domain: projectDomain.parse(d.domain) }), {
        domain: null,
      }),
    // §4.2 reader: the brief, plus observed counts. Sessions come from the live fleet on the project's member
    // tasks; decisions, held messages and journal activity from the controller. `stale` is recomputed with the
    // fleet's latest activity merged in, using the same rule the controller uses.
    async brief(
      input: ContractInput<typeof projectBriefRpc>,
    ): Promise<ContractOutput<typeof projectBriefRpc>> {
      const observedAt = now();
      const [c, f, d] = await Promise.allSettled([
        call("briefs-read", { projectId: input.projectId }),
        fleet(),
        projects(),
      ]);
      if (c.status === "rejected") {
        const last = lastBriefs.get(input.projectId);
        if (last) return { ...last, stale: true, partial: true, error: message(c.reason) };
        return {
          version: 1,
          observedAt,
          partial: true,
          error: message(c.reason),
          projectId: input.projectId,
          brief: null,
          authorName: null,
          observed: null,
          stale: true,
        };
      }
      const read = c.value,
        directory = d.status === "fulfilled" && d.value.available ? d.value : null,
        live = f.status === "fulfilled" ? f.value : null;
      const parsed = read.brief ? projectBrief.safeParse(read.brief) : null;
      const brief = parsed?.success ? parsed.data : null;
      const tasks = new Set(
        directory
          ? directory.membership.filter((m) => m.projectId === input.projectId).map((m) => m.taskId)
          : [],
      );
      const nodes = live ? live.nodes.filter((n) => tasks.has(n.task)) : [];
      const lastActivityAt = latest([
        read.journal?.lastActivityAt,
        ...nodes.map((n) => n.updatedAt),
      ]);
      const name = directory?.projects.find((p) => p.id === input.projectId)?.name ?? null;
      const authorName = !brief
        ? null
        : brief.author.seat === input.projectId
          ? `the ${name ?? "project"} lead`
          : `the ${brief.author.seat} main assistant`;
      const out = projectBriefRpc.output.parse({
        version: 1,
        observedAt: read.observedAt,
        partial: !directory || !live || (parsed !== null && !parsed.success),
        error: parsed && !parsed.success ? "The saved update could not be read" : null,
        projectId: input.projectId,
        brief,
        authorName,
        observed: {
          sessionsRunning: nodes.filter((n) => n.status === "running").length,
          sessionsTotal: nodes.length,
          openDecisions: read.journal?.openDecisions ?? 0,
          heldMessages: read.journal?.heldMessages ?? 0,
          lastActivityAt,
          observedAt: read.observedAt,
        },
        stale: brief
          ? briefStale({ writtenAt: brief.writtenAt, lastActivityAt, now: Date.parse(observedAt) })
          : false,
      });
      if (lastBriefs.size >= 128 && !lastBriefs.has(input.projectId))
        lastBriefs.delete(lastBriefs.keys().next().value!);
      lastBriefs.set(input.projectId, out);
      return out;
    },
  };
}
