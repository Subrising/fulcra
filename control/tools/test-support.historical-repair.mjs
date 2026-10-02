// Test fixture only. Invoke --build under the caller's heavy-work scheduler, never from a test.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
export const historicalCommit = "8358fca093a7340665c3425a72f90c8711e1568e";
const root = fileURLToPath(new URL("../.verification/pre-trusted-hooks/", import.meta.url));
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function files(directory, prefix = "") {
  return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return files(directory, relative);
    return entry.isFile() && /\.(js|json)$/.test(entry.name) ? [relative] : [];
  });
}
export function historicalRepairFixture() {
  const receipt = path.join(root, "fixture.json");
  if (!fs.existsSync(receipt))
    throw Error(
      "Historical pre-trusted-hook fixture missing. Under heavy-lock, run: node tools/test-support.historical-repair.mjs --build <product-checkout-with-dependencies>. Current ORCA_MCP_TEST_NATIVE is deliberately NOT a historical patch target.",
    );
  const manifest = JSON.parse(fs.readFileSync(receipt, "utf8"));
  if (
    manifest.commit !== historicalCommit ||
    !manifest.files ||
    Object.keys(manifest.files).length === 0
  )
    throw Error("Invalid historical repair fixture provenance");
  const pkg = path.join(root, "packages/server");
  for (const [file, digest] of Object.entries(manifest.files)) {
    if (
      path.isAbsolute(file) ||
      file.split(/[\\/]/).includes("..") ||
      sha(path.join(pkg, file)) !== digest
    )
      throw Error("Historical repair fixture changed: " + file);
  }
  return path.join(pkg, "dist/server/server");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--build" || !process.argv[3])
    throw Error(
      "Usage (under heavy-lock): node tools/test-support.historical-repair.mjs --build <product-checkout>",
    );
  const product = fs.realpathSync(process.argv[3]);
  if (fs.existsSync(root)) {
    historicalRepairFixture();
    console.log("Reusing verified historical fixture " + historicalCommit);
  } else {
    const archive = execFileSync("git", ["archive", historicalCommit, "packages/server"], {
      cwd: product,
      maxBuffer: 64 * 1024 * 1024,
    });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      execFileSync("tar", ["-xf", "-", "-C", root], { input: archive });
      fs.symlinkSync(path.join(product, "node_modules"), path.join(root, "node_modules"), "dir");
      const pkg = path.join(root, "packages/server");
      execFileSync(
        path.join(product, "node_modules/.bin/tsc"),
        ["-p", "tsconfig.server.json", "--noCheck", "--incremental", "false"],
        { cwd: pkg, stdio: "inherit" },
      );
      const entries = [
        "package.json",
        ...files(path.join(pkg, "dist")).map((file) => "dist/" + file),
      ];
      fs.writeFileSync(
        path.join(root, "fixture.json"),
        JSON.stringify(
          {
            commit: historicalCommit,
            purpose: "historical repair only; not candidate/native acceptance",
            files: Object.fromEntries(entries.map((file) => [file, sha(path.join(pkg, file))])),
          },
          null,
          2,
        ) + "\n",
      );
      historicalRepairFixture();
      console.log("Prepared historical fixture " + historicalCommit);
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }
}
