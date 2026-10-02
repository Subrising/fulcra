import { briefingRpc, type Briefing } from "../shared/briefing";
import type { readTaskCatalog } from "./tasks";
import type { ProjectDirectory } from "../shared/projects";
import { readOutcome } from "./outcomes";

export function createBriefingReader(
  catalog: () => ReturnType<typeof readTaskCatalog>,
  projects: () => Promise<ProjectDirectory>,
  allowed: (id: string) => Promise<boolean>,
  read = readOutcome,
) {
  const flights = new Map<string | null, Promise<Briefing>>();
  async function observe(after: string | null): Promise<Briefing> {
    const started = Date.now(),
      [tasks, directory] = await Promise.all([catalog(), projects()]);
    const ages = [started, Date.parse(tasks.observedAt), Date.parse(directory.observedAt)];
    if (ages.some((n) => !Number.isFinite(n) || n > started + 5000))
      throw Error("Briefing observation time unavailable");
    const membership = new Map(
        directory.available ? directory.membership.map((m) => [m.taskId, m.projectId]) : [],
      ),
      names = new Map(directory.available ? directory.projects.map((p) => [p.id, p.name]) : []);
    const all = [...tasks.tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      page = all.filter((t) => after === null || t.id > after).slice(0, 64),
      byId = new Map(all.map((t) => [t.id, t]));
    const auth = new Map<string, Promise<boolean>>();
    const authorize = (id: string) => {
      if (!auth.has(id))
        auth.set(
          id,
          allowed(id).catch(() => false),
        );
      return auth.get(id)!;
    };
    const result: Briefing = {
      observedAt: new Date(Math.min(...ages)).toISOString(),
      partial:
        tasks.partial ||
        !tasks.available ||
        directory.partial ||
        !directory.available ||
        after !== null,
      scanned: page.length,
      total: all.length,
      missing: 0,
      unavailable: 0,
      nextCursor: null,
      entries: [],
    };
    // Bound source fan-out; referenced targets share these authorizations within this observation only.
    const loaded: ReturnType<typeof readOutcome>[] = [];
    for (let i = 0; i < page.length; i += 4)
      await Promise.all(
        page.slice(i, i + 4).map(async (task) => {
          if (!(await authorize(task.id))) {
            result.unavailable++;
            return;
          }
          try {
            loaded.push(read(task.id));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") result.missing++;
            else result.unavailable++;
          }
        }),
      );
    let extra = 0;
    for (const { record: r, source } of loaded.sort((a, b) =>
      a.record.taskId < b.record.taskId ? -1 : 1,
    )) {
      const projectId = membership.get(r.taskId) ?? null,
        affects = [],
        dependencies = [];
      for (const p of r.coordination?.affectedProjects ?? []) {
        if (p.projectId === projectId) {
          result.partial = true;
          continue;
        }
        const name = names.get(p.projectId) ?? null;
        result.partial ||= name === null;
        affects.push({ ...p, name });
      }
      for (const dep of r.coordination?.dependsOn ?? []) {
        const target = byId.get(dep.taskId),
          canCheck = auth.has(dep.taskId) || extra++ < 32;
        const visible = !!target && canCheck && (await authorize(dep.taskId));
        result.partial ||= !visible;
        dependencies.push({
          taskId: visible ? dep.taskId : null,
          title: visible ? target!.title : null,
          reportedStatus: visible ? target!.status : null,
          reason: dep.reason,
        });
      }
      result.entries.push({
        taskId: r.taskId,
        title: r.title,
        projectId,
        projectName: projectId ? (names.get(projectId) ?? null) : null,
        outcome: r.outcome,
        currentState: r.currentState,
        nextStep: r.nextStep ?? null,
        question: r.coordination?.decisionNeeded ?? null,
        decision: r.decision?.rationale ?? null,
        publishedAt: r.publishedAt ?? null,
        recordSha256: source.sha256,
        affects,
        dependencies,
      });
    }
    const last = page.at(-1)?.id;
    result.nextCursor = last && all.some((t) => t.id > last) ? last : null;
    result.partial ||= result.nextCursor !== null || result.unavailable > 0;
    return briefingRpc.output.parse(result);
  }
  return (input: unknown) => {
    const { after } = briefingRpc.input.parse(input);
    if (!flights.has(after)) {
      if (flights.size >= 8) throw Error("Briefing readers busy; refresh later");
      flights.set(
        after,
        observe(after).finally(() => flights.delete(after)),
      );
    }
    return flights.get(after)!;
  };
}
