import { portable } from "../portable-config.mjs";
import fs from "node:fs";
import { createHash } from "node:crypto";
const digest = (value) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
export function receiptFor(
  sessionId,
  messageId,
  text,
  directory = portable.home + "/agent-requests",
) {
  const file = `${directory}/${digest(["send", sessionId, messageId])}.json`;
  let fd;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid native receipt file");
    const row = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (
      row.agentId !== sessionId ||
      !["pending", "completed"].includes(row.state) ||
      row.fingerprint !== digest({ prompt: text, activeTurnBehavior: "interrupt" })
    )
      throw new Error("Native receipt fingerprint mismatch");
    return { ...row, file };
  } finally {
    fs.closeSync(fd);
  }
}
