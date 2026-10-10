import fs from "node:fs";
import { privateOwned } from "../../orca-organization/server/owned.mjs";
import { createHash } from "node:crypto";

// Private journal accounting. Window rollover changes throughput, never a grant, generation or expiry.
export const RATE_WINDOW_MS = 3600000;
const LIMITS = Object.freeze({
  followup: { initial: 32, max: 64 },
  channel: { initial: 8, max: 64 },
  seat: { initial: 8, max: 32 },
});
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class IntercomRates {
  constructor(store, now = Date.now, settingsFile = process.env.PASEO_INTERCOM_RATE_FILE) {
    this.store = store;
    this.db = store.db;
    this.now = now;
    this.settingsFile = settingsFile;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS intercom_rate_settings(kind TEXT PRIMARY KEY,max INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS intercom_rate_clock(id INTEGER PRIMARY KEY CHECK(id=1),watermark INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS intercom_rate_operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,fingerprint TEXT NOT NULL,at INTEGER NOT NULL);
      INSERT OR IGNORE INTO intercom_rate_clock VALUES(1,0);
      CREATE TABLE IF NOT EXISTS intercom_rate_native_settings(id INTEGER PRIMARY KEY CHECK(id=1),settings TEXT NOT NULL);`);
  }
  nativeSettings() {
    if (!this.settingsFile) return null;
    try {
      const settings = readNativeRateSettings(this.settingsFile);
      this.db
        .prepare("INSERT OR REPLACE INTO intercom_rate_native_settings VALUES(1,?)")
        .run(JSON.stringify(settings));
      return settings;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const cached = this.db
        .prepare("SELECT settings FROM intercom_rate_native_settings WHERE id=1")
        .get();
      if (cached) throw Error("Native owner rate Settings disappeared", { cause: error });
      return null;
    }
  }
  count(kind, scope) {
    return this.used(kind, scope, this.clock());
  }
  requirePermit(kind, scope, id, maximum = Infinity) {
    const now = this.clock(),
      prior = this.db.prepare("SELECT * FROM intercom_rate_operations WHERE id=?").get(id);
    if (
      !prior ||
      prior.kind !== kind ||
      prior.scope !== scope ||
      prior.at <= now - RATE_WINDOW_MS ||
      this.used(kind, scope, now) > Math.min(this.setting(kind).max, maximum)
    )
      throw Error("Intercom rolling rate permit expired or lowered");
  }
  setting(kind) {
    if (!Object.hasOwn(LIMITS, kind)) throw Error("Unknown intercom rate");
    const native = this.nativeSettings()?.[kind];
    const local = this.db
      .prepare("SELECT max FROM intercom_rate_settings WHERE kind=?")
      .get(kind)?.max;
    const chosen = local ?? native ?? LIMITS[kind].initial;
    const max = native === undefined ? chosen : Math.min(chosen, native);
    if (!Number.isSafeInteger(max) || max < 0 || max > LIMITS[kind].max)
      throw Error("Invalid stored intercom rate");
    return { kind, max, windowMs: RATE_WINDOW_MS, ownerMaximum: LIMITS[kind].max };
  }
  status() {
    return Object.keys(LIMITS).map((kind) => this.setting(kind));
  }
  set(a, requireOwner) {
    if (
      !a ||
      Object.keys(a).sort().join() !== "kind,max" ||
      !Object.hasOwn(LIMITS, a.kind) ||
      !Number.isSafeInteger(a.max) ||
      a.max < 0 ||
      a.max > LIMITS[a.kind].max ||
      typeof requireOwner !== "function"
    )
      throw Error("Finite owner rate Settings required");
    return this.store.atomic(() => {
      requireOwner();
      this.clock();
      requireOwner();
      this.db
        .prepare("INSERT OR REPLACE INTO intercom_rate_settings VALUES(?,?)")
        .run(a.kind, a.max);
      return this.setting(a.kind);
    });
  }
  clock() {
    const now = this.now(),
      last = this.db
        .prepare("SELECT watermark FROM intercom_rate_clock WHERE id=1")
        .get()?.watermark;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(last) || now < last)
      throw Error("Intercom rate clock rollback");
    this.db.prepare("UPDATE intercom_rate_clock SET watermark=? WHERE id=1").run(now);
    return now;
  }
  used(kind, scope, now) {
    this.setting(kind);
    return this.db
      .prepare(
        "SELECT count(*) n FROM intercom_rate_operations WHERE kind=? AND scope=? AND at>? AND at<=?",
      )
      .get(kind, scope, now - RATE_WINDOW_MS, now).n;
  }
  spend(kind, scope, id, immutableBody, requireAuthority, maximum = Infinity) {
    if (
      typeof scope !== "string" ||
      !scope ||
      scope.length > 200 ||
      typeof id !== "string" ||
      !id ||
      id.length > 200 ||
      typeof requireAuthority !== "function"
    )
      throw Error("Bound intercom rate operation required");
    const binding = fingerprint({ kind, scope, immutableBody });
    return this.store.atomic(() => {
      requireAuthority();
      const now = this.clock(),
        setting = this.setting(kind);
      const prior = this.db.prepare("SELECT * FROM intercom_rate_operations WHERE id=?").get(id);
      if (prior) {
        if (prior.fingerprint !== binding || prior.kind !== kind || prior.scope !== scope)
          throw Error("Intercom rate identity conflict");
        requireAuthority();
        return { ...setting, duplicate: true, used: this.used(kind, scope, now) };
      }
      if (this.db.prepare("SELECT count(*) n FROM intercom_rate_operations").get().n >= 10000)
        throw Error("Intercom rate permanent-id capacity");
      const used = this.used(kind, scope, now);
      if (used >= Math.min(setting.max, maximum)) throw Error("Intercom rolling rate reached");
      requireAuthority(); // Latest Settings and authority at the durable accounting commit.
      if (Math.min(this.setting(kind).max, maximum) <= used)
        throw Error("Intercom rolling rate changed");
      this.db
        .prepare("INSERT INTO intercom_rate_operations VALUES(?,?,?,?,?)")
        .run(id, kind, scope, binding, now);
      return { ...setting, duplicate: false, used: used + 1 };
    });
  }
}

/** The path comes only from daemon-owned distribution startup, never shared config or caller flags. */
export function readNativeRateSettings(file) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      !privateOwned(stat, file) ||
      stat.size > 8 * 1024 * 1024
    )
      throw Error("Unsafe native owner rate Settings store");
    const data = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (
      data.version !== 1 ||
      !data.settings ||
      !Array.isArray(data.entries) ||
      data.entries.length > 10000
    )
      throw Error("Invalid native owner rate Settings journal");
    for (const [kind, limit] of Object.entries(LIMITS))
      if (
        !Number.isSafeInteger(data.settings[kind]) ||
        data.settings[kind] < 0 ||
        data.settings[kind] > limit.max
      )
        throw Error("Invalid native owner rate Settings bounds");
    return data.settings;
  } finally {
    fs.closeSync(fd);
  }
}
