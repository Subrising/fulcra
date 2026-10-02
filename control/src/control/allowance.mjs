import { uuid } from "./authority.mjs";
export class InstructionAllowanceExhausted extends Error {
  constructor() {
    super(
      "Task instruction allowance exhausted; new automation is paused. Inspect allowance and retained outputs; do not automatically increase the limit.",
    );
    this.code = "ORCA_INSTRUCTION_ALLOWANCE_EXHAUSTED";
  }
}
export class TaskAllowance {
  constructor(control) {
    this.control = control;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS task_allowances(task TEXT PRIMARY KEY,revision INTEGER NOT NULL,maximum INTEGER,reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_instruction_charges(message TEXT PRIMARY KEY,task TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_instruction_count ON task_instruction_charges(task);`);
  }
  get db() {
    return this.control.store.db;
  }
  status(taskId) {
    if (!uuid(taskId)) throw Error("Invalid allowance task");
    const policy = this.db.prepare("SELECT * FROM task_allowances WHERE task=?").get(taskId);
    const used = Number(
      this.db.prepare("SELECT count(*) n FROM task_instruction_charges WHERE task=?").get(taskId).n,
    );
    const maximum = policy?.maximum ?? null;
    return {
      taskId,
      revision: policy?.revision ?? 0,
      maxInstructions: maximum,
      admittedInstructions: used,
      remaining: maximum === null ? null : Math.max(0, maximum - used),
      exhausted: maximum !== null && used >= maximum,
      reason: policy?.reason ?? null,
      scope:
        "Controller instruction admissions since allowance support was installed; includes uncertain attempts and supervisor wakes. Not tokens, cost, tool calls, historical turns or direct human input.",
    };
  }
  async set(a) {
    if (
      !a ||
      Object.keys(a).sort().join() !== "expectedRevision,maxInstructions,reason,taskId" ||
      !uuid(a.taskId) ||
      !Number.isSafeInteger(a.expectedRevision) ||
      a.expectedRevision < 0 ||
      a.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      (a.maxInstructions !== null &&
        (!Number.isSafeInteger(a.maxInstructions) ||
          a.maxInstructions < 0 ||
          a.maxInstructions > 1000)) ||
      typeof a.reason !== "string" ||
      !a.reason.isWellFormed() ||
      a.reason.trim().length < 12 ||
      a.reason.length > 2000
    )
      throw Error("Invalid task allowance policy");
    await this.control.authority(a.taskId);
    return this.control.store.atomic(() => {
      if (!this.db.prepare("SELECT id FROM sessions WHERE task=?").get(a.taskId))
        throw Error("An enrolled task is required");
      const prior = this.status(a.taskId),
        reason = a.reason.trim();
      // Absolute cap and revision make a lost-response retry safe without adding credit twice.
      if (
        prior.revision === a.expectedRevision + 1 &&
        prior.maxInstructions === a.maxInstructions &&
        prior.reason === reason
      )
        return prior;
      if (prior.revision !== a.expectedRevision)
        throw Error("Task allowance changed; read it again before deciding");
      this.db
        .prepare("INSERT OR REPLACE INTO task_allowances VALUES (?,?,?,?)")
        .run(a.taskId, prior.revision + 1, a.maxInstructions, reason);
      return this.status(a.taskId);
    });
  }
  // Synchronous hook inside the same transaction as the durable dispatch admission.
  charge(taskId, messageId) {
    const prior = this.db
      .prepare("SELECT task FROM task_instruction_charges WHERE message=?")
      .get(messageId);
    if (prior) {
      if (prior.task !== taskId) throw Error("Task instruction identity conflict");
      return;
    }
    const status = this.status(taskId);
    if (status.exhausted) throw new InstructionAllowanceExhausted();
    this.db.prepare("INSERT INTO task_instruction_charges VALUES (?,?)").run(messageId, taskId);
  }
}
