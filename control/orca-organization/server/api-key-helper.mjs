import { deflateRawSync } from "node:zlib";
import { isAbsolute } from "node:path";
// The helper contains code and account references only. Claude receives its stdout through apiKeyHelper.
// Keep the runtime self-contained: plugin and controller bundles do not share a module directory.
async function readApiKey(config) {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const check = () => {
      const state = JSON.parse(
        fs.readFileSync(path.join(config.root, "accounts/accounts.json"), "utf8"),
      );
      const a = state.accounts.find((a) => a.id === config.id && a.provider === "claude");
      if (
        !a ||
        !a.enabled ||
        a.revoked ||
        a.localRevoked ||
        a.auth !== "ok" ||
        a.credentialKind !== "api-key" ||
        (a.keyEpoch ?? null) !== config.epoch
      )
        throw Error();
      if (
        config.session &&
        (state.assignments[config.session]?.accountId !== config.id ||
          state.assignments[config.session]?.ended ||
          state.assignments[config.session]?.provider !== "claude")
      )
        throw Error();
    };
    check();
    // No inherited API keys, loader options or shell configuration reach the store reader.
    const env = {};
    for (const name of ["HOME", "SystemRoot", "USERPROFILE", "TEMP", "TMP"])
      if (process.env[name]) env[name] = process.env[name];
    const options = {
      encoding: "utf8",
      env,
      timeout: 15000,
      maxBuffer: 4096,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    };
    let key;
    if (process.platform === "darwin") {
      key = execFileSync(
        config.security,
        [
          "find-generic-password",
          "-s",
          "Fulcra account",
          "-a",
          config.id,
          "-w",
          ...(config.keychain ? [config.keychain] : []),
        ],
        options,
      ).replace(/\r?\n$/, "");
    } else if (process.platform === "win32") {
      const cipher = fs.readFileSync(
        path.join(config.root, "accounts/secrets", `${config.id}.dpapi`),
        "utf8",
      );
      const script =
        "Add-Type -AssemblyName System.Security;$i=[Console]::In.ReadToEnd().Trim();" +
        "[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($i),$null,'CurrentUser')))";
      const ps = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      );
      key = execFileSync(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { ...options, input: cipher },
      );
    } else throw Error();
    if (!/^sk-ant-api[A-Za-z0-9._~+/=-]{10,1010}$/i.test(key)) throw Error();
    check();
    process.stdout.write(key);
  } catch {
    // Never expose subprocess errors: they can contain stdout, stderr or command details.
    process.stderr.write("The API key is unavailable or revoked.\n");
    process.exitCode = 1;
  }
}

export function apiKeyHelperCommand({
  root,
  id,
  session = null,
  epoch = null,
  env = process.env,
  platform = process.platform,
}) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw Error("Bad account id");
  if (
    !isAbsolute(root) ||
    (epoch !== null && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(epoch)) ||
    (session !== null && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(session))
  )
    throw Error("Bad API account reference");
  if (!["darwin", "win32"].includes(platform))
    throw Error("API keys require macOS Keychain or Windows DPAPI");
  const config = {
    root,
    id,
    session,
    epoch,
    keychain: env.FULCRA_ACCOUNTS_KEYCHAIN || null,
    security: "/usr/bin/security",
  };
  const source = `(${readApiKey.toString()})(${JSON.stringify(config)})`;
  const code = `eval(Buffer.from('${Buffer.from(source).toString("base64")}','base64').toString())`;
  const quote = (s) => {
    if (platform !== "win32") return `'${s.replaceAll("'", "'\\''")}'`;
    if (/["%!\r\n]/.test(s)) throw Error("Unsupported helper path");
    return `"${s}"`;
  };
  // PowerShell sets this nonsecret flag inside the helper, for both cmd.exe and Git Bash callers.
  if (platform === "win32") {
    const ps =
      `${env.SystemRoot || "C:/Windows"}/System32/WindowsPowerShell/v1.0/powershell.exe`.replaceAll(
        "\\",
        "/",
      );
    const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
    // Keep the encoded PowerShell command below cmd.exe's command-line limit.
    // Compression applies only to fixed code and account references, never to a key.
    const packed = deflateRawSync(Buffer.from(source)).toString("base64");
    const winCode = `eval(require('node:zlib').inflateRawSync(Buffer.from('${packed}','base64')).toString())`;
    const script = `$env:ELECTRON_RUN_AS_NODE='1'; & ${literal(process.execPath)} '-e' ${literal(winCode)}; exit $LASTEXITCODE`;
    const command = `${quote(ps)} -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
    if (command.length > 7500) throw Error("Unsupported helper command length");
    return command;
  }
  return `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} -e ${quote(code)}`;
}
