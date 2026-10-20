import { readFileSync, statSync } from "node:fs";
import { hashDaemonPassword, type DaemonAuthConfig } from "./auth.js";

/** Names the shared password file for a script-started daemon. The password itself never goes in env or argv. */
export const COMMAND_CENTRE_PASSWORD_FILE_ENV = "FULCRA_COMMAND_CENTRE_PASSWORD_FILE";
/** The desktop app uses this file in the daemon home, when it exists, instead of a generated credential. */
export const COMMAND_CENTRE_PASSWORD_FILE_NAME = "command-centre-password";
export const COMMAND_CENTRE_PASSWORD_MIN_LENGTH = 16;
const MAX_LENGTH = 1024;

/**
 * Reads the shared Command Centre password. Every fault throws: a bad file must never start a daemon without auth.
 * Errors name the path and the reason, never the content.
 */
export function readCommandCentrePasswordFile(
  filePath: string,
  options: { allowMissing?: boolean; platform?: string } = {},
): string | null {
  const fail = (reason: string) => Error(`Command Centre password file ${filePath}: ${reason}`);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(filePath);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT" && options.allowMissing) return null;
    // eslint-disable-next-line preserve-caught-error
    throw fail("unreadable");
  }
  if (!stats.isFile()) throw fail("not a file");
  // POSIX modes are meaningful; Windows protects the file with the user profile ACL instead.
  if ((options.platform ?? process.platform) !== "win32" && (stats.mode & 0o077) !== 0)
    throw fail("readable by other users (run chmod 600)");
  if (stats.size > MAX_LENGTH * 4) throw fail("too long");
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw fail("unreadable");
  }
  const password = text.trim();
  if (!password) throw fail("empty");
  if (password.length < COMMAND_CENTRE_PASSWORD_MIN_LENGTH)
    throw fail(`shorter than ${COMMAND_CENTRE_PASSWORD_MIN_LENGTH} characters`);
  if (password.length > MAX_LENGTH) throw fail("too long");
  if (/\s/.test(password)) throw fail("contains whitespace");
  return password;
}

/**
 * Daemon auth for an enabled Command Centre. The app passes a bcrypt hash; a script names a password file.
 * Both paths end with a password, or the start is refused.
 */
export function resolveCommandCentreAuth(
  config: { auth?: DaemonAuthConfig },
  env: { passwordFile?: string; generatedAuthHash?: string },
): DaemonAuthConfig {
  if (env.passwordFile) {
    if (config.auth?.password)
      throw Error(
        `${COMMAND_CENTRE_PASSWORD_FILE_ENV} conflicts with a configured daemon password. Set only one.`,
      );
    const password = readCommandCentrePasswordFile(env.passwordFile) as string;
    return { password: hashDaemonPassword(password) };
  }
  if (
    !config.auth?.password &&
    env.generatedAuthHash &&
    /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/.test(env.generatedAuthHash)
  )
    return { password: env.generatedAuthHash };
  if (!config.auth?.password) throw Error("Command Centre requires daemon authentication");
  return config.auth;
}
