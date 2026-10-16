import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Watch stable directories. Atomic ledger replacement must not leave a watch on the old file inode. */
export class LedgerDirectoryWatch {
  private root?: FSWatcher;
  private readonly projects = new Map<string, FSWatcher>();
  private stopped = false;
  private lane: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(
    private readonly directory: string,
    private readonly changed: () => void,
    private readonly failed: (error: unknown) => void,
  ) {
    this.ready = this.refresh();
  }
  covers(project: string): boolean {
    return !this.stopped && Boolean(this.root) && this.projects.has(project);
  }
  close(): void {
    this.stopped = true;
    this.root?.close();
    this.root = undefined;
    for (const watcher of this.projects.values()) watcher.close();
    this.projects.clear();
  }
  refresh(): Promise<void> {
    const result = this.lane
      .then(() => this.discover())
      .catch((error: unknown) => this.failed(error));
    this.lane = result;
    return result;
  }
  private async membership(name: string): Promise<void> {
    if (this.stopped || name.startsWith(".")) return;
    if (this.projects.has(name)) {
      await this.refresh();
      return;
    }
    try {
      if ((await stat(path.join(this.directory, name))).isDirectory()) await this.refresh();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.failed(error);
    }
  }
  private rootWatch(): void {
    if (this.root || this.stopped) return;
    this.root = watch(this.directory, (_event, name) => {
      if (name) void this.membership(String(name));
      else void this.refresh();
    });
    this.root.on("error", (error) => {
      this.root?.close();
      this.root = undefined;
      this.failed(error);
    });
    this.root.unref();
  }
  private async discover(): Promise<void> {
    if (this.stopped) return;
    this.rootWatch();
    const directories = new Set(
      (await readdir(this.directory, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name),
    );
    let changed = false;
    for (const [name, watcher] of this.projects) {
      if (!directories.has(name)) {
        watcher.close();
        this.projects.delete(name);
        changed = true;
      }
    }
    for (const name of directories) {
      if (this.stopped || this.projects.has(name)) continue;
      try {
        const watcher = watch(path.join(this.directory, name), (_event, file) => {
          if (!this.stopped && (!file || String(file) === "OPEN-ITEMS.md")) this.changed();
        });
        watcher.on("error", (error) => {
          watcher.close();
          this.projects.delete(name);
          this.failed(error);
        });
        watcher.unref();
        this.projects.set(name, watcher);
        changed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.failed(error);
      }
    }
    if (changed && !this.stopped) this.changed();
  }
}
