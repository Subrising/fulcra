// The command-line tools a deploy needs, at pinned versions. Fulcra downloads them into its own folder only when
// asked, and checks every download against the checksum written here before it is allowed to run.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runTool, toolEnvironment, mustRun } from "./run.mjs";

export const RADIUS_VERSION = "0.60.2";
export const K3D_VERSION = "5.9.0";

const PLATFORM = () => {
  const osName =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  return osName && arch ? `${osName}_${arch}` : null;
};

const DOWNLOADS = {
  rad: {
    url: (p) =>
      `https://github.com/radius-project/radius/releases/download/v${RADIUS_VERSION}/rad_${p}`,
    sha256: {
      darwin_arm64: "a0d8276d30e318dcee8520c7c749be7009bc17ad2f0e0942a99a60ae4969487b",
      darwin_amd64: "87b1e6d713acf6fa6864fd8ce66b4ec386e5b3d04815ce1769f4b354eddc2a65",
      linux_arm64: "7de188b908157d19d6f0ab7a5736a2b3c083cb78416f98652c26b02f3a95a29e",
      linux_amd64: "941daf7f646e93351a690f7327875e86adba761cf72d6e8238f1b6741798a745",
    },
  },
  k3d: {
    url: (p) =>
      `https://github.com/k3d-io/k3d/releases/download/v${K3D_VERSION}/k3d-${p.replace("_", "-")}`,
    sha256: {
      darwin_arm64: "fe106541d5d0a3f18debcd4d432a16f8c0ce3e6ddc06f8fbb6f696a122313e00",
      darwin_amd64: "b4aabc37534f95b9c764e7823f2df923f50d57600837aa60a06266cce47db732",
      linux_arm64: "03cde5cf23e6e8e67de5a039ecf26e5b85aca82fba3e5d13dadf904cd218a250",
      linux_amd64: "06d8f25bc3a971c4eb29e0ff08429b180402db0f4dec838c9eac427e296800a0",
    },
  },
};

export function createTools({ root, fetcher = fetch, run = runTool }) {
  const bin = path.join(root, "bin");
  const at = (name) => path.join(bin, name);
  const env = (kubeconfig) => toolEnvironment({ bin, kubeconfig });
  const bicep = path.join(os.homedir(), ".rad", "bin", "bicep");

  async function versionOf(name) {
    try {
      const args = name === "rad" ? ["version", "-o", "json"] : ["version"];
      const r = await run(at(name), args, { env: env(), timeoutMs: 20_000 });
      return r.code === 0 || name === "rad" ? r.stdout : null;
    } catch {
      return null;
    }
  }

  return {
    bin,
    env,
    path: at,
    bicep,
    /** What is installed, in words a person can act on. */
    async check() {
      const [rad, k3d, docker] = await Promise.all([
        fs.existsSync(at("rad")) ? versionOf("rad") : null,
        fs.existsSync(at("k3d")) ? versionOf("k3d") : null,
        run("docker", ["info", "--format", "{{.ServerVersion}}"], { env: env(), timeoutMs: 15_000 })
          .then((r) => (r.code === 0 ? r.stdout.trim() : null))
          .catch(() => null),
      ]);
      return {
        rad: rad !== null && rad.includes(RADIUS_VERSION),
        k3d: k3d !== null && k3d.includes(K3D_VERSION),
        bicep: fs.existsSync(bicep),
        docker: docker !== null && docker !== "",
      };
    },
    /** Download one tool, check it, and only then make it runnable. */
    async install(name) {
      const platform = PLATFORM();
      const spec = DOWNLOADS[name];
      if (!platform || !spec?.sha256[platform])
        throw new Error(`Fulcra cannot install ${name} on this kind of computer`);
      await fsp.mkdir(bin, { recursive: true, mode: 0o700 });
      const response = await fetcher(spec.url(platform));
      if (!response.ok) throw new Error(`Could not download ${name} (HTTP ${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== spec.sha256[platform])
        throw new Error(
          `The ${name} download did not match its published checksum, so it was not installed`,
        );
      const temporary = `${at(name)}.${process.pid}.part`;
      await fsp.writeFile(temporary, bytes, { mode: 0o700 });
      await fsp.rename(temporary, at(name));
    },
    /** Radius compiles Bicep with its own matching Bicep build. */
    async installBicep() {
      await mustRun(at("rad"), ["bicep", "download"], { env: env(), timeoutMs: 300_000 });
    },
  };
}
