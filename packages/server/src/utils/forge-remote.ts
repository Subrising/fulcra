import { FORGE_DEFINITIONS } from "@getpaseo/protocol/forge-manifest";
import { normalizeHost, parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";

// U5-D07: the forge remote of a checkout, chosen by URL, not by the remote's name. A checkout whose GitHub remote is
// called `subrising` (not `origin`) resolved to "No supported forge remote". ONE git call reads every remote's URL
// (`git config --get-regexp`); then:
//   1. `origin`, when it is on a known forge host, or when it is the only remote (self-hosted forges keep origin);
//   2. the first remote (by name) on a known forge host;
//   3. `origin` anyway (a self-hosted forge the adapter probe may still recognise), else the only remote.
// Known forge hosts are the forge manifest's public cloud hosts; self-hosted instances are still recognised later by
// the adapters' host probe, exactly as before, from whichever URL is returned here.
type RunGit = (
  args: string[],
  options: { cwd: string; envOverlay?: Record<string, string> },
) => Promise<{ stdout: string }>;

const CLOUD_HOSTS = new Set(
  FORGE_DEFINITIONS.flatMap((definition) => definition.cloudHosts ?? []).map((host) =>
    normalizeHost(host),
  ),
);

export function isKnownForgeRemoteUrl(url: string | null): boolean {
  if (!url) return false;
  const location = parseGitRemoteLocation(url);
  return !!location && CLOUD_HOSTS.has(normalizeHost(location.host));
}

export async function resolveForgeRemoteUrl(
  cwd: string,
  runGit: RunGit,
  envOverlay?: Record<string, string>,
): Promise<string | null> {
  let stdout = "";
  try {
    stdout = (await runGit(["config", "--get-regexp", "^remote\\..*\\.url$"], { cwd, envOverlay }))
      .stdout;
  } catch {
    return null; // git exits 1 when there is no remote at all
  }
  const urls = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^remote\.(.+)\.url\s+(\S.*)$/.exec(line.trim());
    if (match && !urls.has(match[1])) urls.set(match[1], match[2].trim());
  }
  const names = [...urls.keys()].sort();
  const origin = urls.get("origin") ?? null;
  if (origin && (isKnownForgeRemoteUrl(origin) || names.length === 1)) return origin;
  const forge = names.map((name) => urls.get(name)!).find((url) => isKnownForgeRemoteUrl(url));
  if (forge) return forge;
  if (origin) return origin;
  return names.length === 1 ? urls.get(names[0])! : null;
}
