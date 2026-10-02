import fs from "node:fs";
import { fileURLToPath } from "node:url";

const gateway = async (...args) => {
  const { callGatewayFromCli } =
    await import("/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/gateway-runtime.js");
  return callGatewayFromCli(...args);
};

// Use OpenClaw's exported SDK with the same CLI auth and target resolution.
// This avoids full command discovery and its large local SQLite snapshot.
export async function gatewayWake(sessionKey, text, call = gateway) {
  if (
    typeof sessionKey !== "string" ||
    !/^agent:main:[a-z0-9:_-]{1,170}$/.test(sessionKey) ||
    !sessionKey.endsWith(":heartbeat")
  )
    throw Error("Exact owned heartbeat target required");
  if (
    typeof text !== "string" ||
    !text.trim() ||
    !text.isWellFormed() ||
    Buffer.byteLength(text) > 16384
  )
    throw Error("Bounded notification required");
  const result = await call(
    "wake",
    { json: true, timeout: "20000" },
    { mode: "now", text, sessionKey },
  );
  if (result?.ok !== true) throw Error("Gateway did not acknowledge the notification");
  return { acknowledged: true };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await gatewayWake(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
