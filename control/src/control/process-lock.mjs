import fs from "node:fs";
import path from "node:path";
// Never recover a stale lock automatically: the host supervisor must establish that the prior child exited.
export function acquireProcessLock(home, { epoch } = {}) {
  if (
    epoch !== undefined &&
    (typeof epoch !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(epoch))
  )
    throw Error("Invalid owned-child epoch");
  const file = path.join(home, "process.lock");
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST")
      throw Error(
        "Controller process.lock exists; host supervisor must verify the prior child has exited",
      );
    throw e;
  }
  const held = fs.fstatSync(fd);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, ...(epoch === undefined ? {} : { epoch }) }) + "\n",
    );
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = fs.lstatSync(file);
      if (current.dev === held.dev && current.ino === held.ino) fs.unlinkSync(file);
    } finally {
      fs.closeSync(fd);
    }
  };
}
