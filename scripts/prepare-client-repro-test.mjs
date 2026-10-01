// Fixture compilation only: run under heavy-lock, then run the assertion test under test-slot.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compilePlugin } from "../packages/server/src/server/plugins/compiler.ts";
const product = fileURLToPath(new URL("../", import.meta.url));
const [control, output] = process.argv.slice(2);
if (!control || !output) throw Error("Supply control checkout and private evidence directory");
await fs.mkdir(output, { recursive: true });
if (process.argv[4] !== "--boundary-only")
  for (const name of ["first", "second"]) {
    const staging = await fs.mkdtemp(path.join(product, ".command-centre-repro-" + name + "-"));
    try {
      await fs.cp(path.join(control, "orca-organization"), staging, {
        recursive: true,
        filter: (file) => !file.split(path.sep).includes("node_modules"),
      });
      const { clientBundle } = await compilePlugin({
        client: path.join(staging, "index.client.tsx"),
        server: null,
      });
      await fs.writeFile(path.join(output, name + ".js"), clientBundle);
      await fs.writeFile(
        path.join(output, name + ".json"),
        JSON.stringify({
          staging,
          client: createHash("sha256").update(clientBundle).digest("hex"),
        }),
      );
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

// absWorkingDir also controls metafile paths. Retain the transitive shared-module boundary.
const boundary = await fs.mkdtemp(path.join(product, ".command-centre-boundary-"));
try {
  for (const part of ["client", "shared", "node_modules/decoration"])
    await fs.mkdir(path.join(boundary, part), { recursive: true });
  await fs.writeFile(
    path.join(boundary, "node_modules/decoration/package.json"),
    JSON.stringify({ name: "decoration", main: "index.tsx" }),
  );
  await fs.writeFile(
    path.join(boundary, "node_modules/decoration/index.tsx"),
    "export const decoration = <></>;",
  );
  await fs.writeFile(
    path.join(boundary, "shared/decoration.ts"),
    'export {decoration} from "decoration";',
  );
  await fs.symlink(
    path.join(boundary, "shared/decoration.ts"),
    path.join(boundary, "client/decoration.ts"),
  );
  await fs.writeFile(
    path.join(boundary, "index.client.tsx"),
    'export {decoration} from "./client/decoration";',
  );
  let error = null;
  try {
    await compilePlugin({ client: path.join(boundary, "index.client.tsx"), server: null });
  } catch (failure) {
    error = String(failure);
  }
  await fs.writeFile(path.join(output, "boundary.json"), JSON.stringify({ error }));
} finally {
  await fs.rm(boundary, { recursive: true, force: true });
}
