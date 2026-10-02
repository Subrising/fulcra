import fs from "node:fs";
import { connect, root, runtime, verifyPins } from "./runtime.mjs";
import { sessionConfig } from "./session-config.mjs";
verifyPins();
const [action, target, argument] = process.argv.slice(2);
const client = await connect();
fs.mkdirSync(`${root}runtime`, { recursive: true });
const record = (value) =>
  fs.appendFileSync(
    `${root}runtime/session-events.jsonl`,
    JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n",
  );
try {
  if (action === "inventory") {
    console.log(
      JSON.stringify(await client.providers.waitForReady({ cwd: runtime.installation }), null, 2),
    );
    console.log(JSON.stringify(await client.agents.list(), null, 2));
  } else if (action === "models") {
    console.log(JSON.stringify(await client.providers.listModels(target), null, 2));
    console.log(JSON.stringify(await client.providers.listModes(target), null, 2));
  } else if (action === "create") {
    const family = target.split("/")[0];
    const config = sessionConfig(target);
    const cwd = `${runtime.installation}/tasks/${family}`;
    fs.mkdirSync(cwd, { recursive: true });
    const agent = await client.agents.create({
      config,
      cwd,
      env: { ORCA_TRIAL_RUN: runtime.marker, PASEO_PASSWORD: "" },
      title: `Orca ${family} independent worker`,
      labels: { owner: "orca-foundation", control: "delegated", scope: "synthetic-trial" },
    });
    record({ type: "created", id: agent.id, family, cwd, config });
    console.log(agent.id);
  } else {
    const agent = client.agents.ref(target);
    await agent.refresh();
    if (action === "inspect") console.log(JSON.stringify(agent.current(), null, 2));
    else if (action === "timeline")
      console.log(JSON.stringify(await agent.timeline.refetch({ limit: 100 }), null, 2));
    else if (action === "turn") {
      const subscription = agent.timeline.subscribe((event) =>
        record({ type: "timeline", ...event }),
      );
      try {
        await subscription.ready;
        const text = fs.readFileSync(argument, "utf8");
        record({ type: "send", id: agent.id, promptFile: argument });
        console.log(JSON.stringify(await agent.run(text, { timeoutMs: 180000 }), null, 2));
      } finally {
        subscription();
      }
    } else if (action === "allow") {
      const request = agent.pendingPermissions?.find((p) => p.id === argument);
      if (!request) throw new Error("Exact pending request not found");
      record({
        type: "permission-response-attempt",
        controller: "orca-root-codex",
        id: agent.id,
        request,
      });
      await agent.respondToPermission({ requestId: argument, response: { behavior: "allow" } });
      record({
        type: "permission-response-delivered",
        controller: "orca-root-codex",
        id: agent.id,
        requestId: argument,
      });
      console.log(
        "Exact request response delivered; inspect resumed work before claiming completion.",
      );
    } else throw new Error("Use inventory, models, create, inspect, timeline, turn or allow");
  }
} finally {
  await client.close();
}
