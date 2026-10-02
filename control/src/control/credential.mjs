import fs from "node:fs";
export function readCredential(file) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.mode & 0o077 || s.size !== 43)
      throw Error("Private owned controller credential required");
    const value = fs.readFileSync(fd, "utf8");
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, "base64url").toString("base64url") !== value
    )
      throw Error("Invalid controller credential");
    return value;
  } finally {
    fs.closeSync(fd);
  }
}
