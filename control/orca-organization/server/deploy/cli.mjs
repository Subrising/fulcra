#!/usr/bin/env node
// Lets a session prepare a deploy plan. It never deploys: the plan waits on Home under "Needs you" until a person
// opens it in Fulcra and confirms. Run it from the project's folder:
//   node deploy-plan.mjs --environment Test [--ref branch:main | commit:<sha> | pr:<number>] [--as "Release helper"]
// It reads the Command Centre's state folder from PASEO_HOME (or ORCA_HOME), as every Fulcra session has it.
import path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createDeployEngine } from "./engine.mjs";
import { stateRoot } from "../config.mjs";

function parseRef(value, repo) {
  if (!value) {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    return branch === "HEAD"
      ? { kind: "commit", value: "HEAD" }
      : { kind: "branch", value: branch };
  }
  const [kind, ...rest] = value.split(":");
  const rest_ = rest.join(":");
  if (kind === "pr") return { kind: "pr", value: Number(rest_) };
  if (kind === "branch" || kind === "commit") return { kind, value: rest_ };
  return { kind: "branch", value };
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  out = console.log,
  makeEngine = (root) => createDeployEngine({ root }),
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      environment: { type: "string" },
      ref: { type: "string" },
      project: { type: "string" },
      as: { type: "string" },
    },
  });
  if (!values.environment) throw new Error("Name the environment: --environment <name>");
  const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: path.resolve(values.project ?? process.cwd()),
    encoding: "utf8",
  }).trim();
  const engine = makeEngine(path.join(stateRoot(env), "deploy"));
  const { environments } = await engine.overview();
  const target = environments.find(
    (e) => e.name.toLowerCase() === values.environment.toLowerCase(),
  );
  if (!target)
    throw new Error(
      `No environment called ${values.environment}. Connected: ${environments.map((e) => e.name).join(", ") || "none"}`,
    );
  const plan = await engine.plan({
    environmentId: target.id,
    repo,
    project: path.basename(repo),
    ref: parseRef(values.ref, repo),
    preparedBy: {
      kind: "session",
      sessionId: env.PASEO_AGENT_ID ?? "unknown",
      label: (values.as ?? "A session").slice(0, 200),
    },
  });
  out(`Prepared a plan for ${target.name}: ${plan.change.summary}`);
  for (const c of plan.change.changes)
    out(`  ${c.kind} ${c.name} (${c.label})${c.details.length ? ": " + c.details.join("; ") : ""}`);
  for (const r of plan.change.risks) out(`  Risk: ${r}`);
  out(
    "It is waiting on Home under Needs you. Only a person can confirm it in Fulcra; this command never deploys.",
  );
  return plan;
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("deploy-plan.mjs")
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
