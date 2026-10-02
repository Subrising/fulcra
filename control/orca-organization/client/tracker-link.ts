import { Linking } from "react-native";
// J3: the only way the Orca view opens a tracker item. The URL was constructed server-side from the pinned
// mapping; this re-checks it is https on a tracker host before handing it to the OS. Tracker text never
// becomes a link, and nothing opens without an explicit press.
const TRACKER_URL =
  /^https:\/\/(github\.com|bitbucket\.org|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net)\/[^\s]*$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// J4b: a Data Center item lives on its own site. `site` is the one its ref names (the server built both from the
// same mapping), so exactly that host is allowed besides the cloud trackers.
export function isTrackerUrl(url: unknown, site: string | null = null): url is string {
  if (typeof url !== "string" || url.length > 512) return false;
  if (TRACKER_URL.test(url)) return true;
  return !!site && HOST.test(site) && url.startsWith(`https://${site}/`) && !/\s/.test(url);
}
export function openTrackerUrl(
  url: unknown,
  open: (url: string) => Promise<unknown> = (u) => Linking.openURL(u),
  site: string | null = null,
): boolean {
  if (!isTrackerUrl(url, site)) return false;
  void open(url).catch(() => undefined);
  return true;
}
// The site a tracker ref names (`issue:jira-dc@jira.example.com:…`, `pr:bitbucket-dc@git.example.com:…#9`), or null.
export function refSite(ref: unknown): string | null {
  const m =
    typeof ref === "string"
      ? /^(?:issue|pr):[a-z][a-z0-9-]{1,31}@([A-Za-z0-9.-]{1,253}):/.exec(ref)
      : null;
  return m && HOST.test(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
}
// "Create a token" pages: the providers' own help and settings pages only.
const HELP_URL = /^https:\/\/(github\.com|id\.atlassian\.com|confluence\.atlassian\.com)\/[^\s]*$/;
export function openHelpUrl(
  url: unknown,
  open: (url: string) => Promise<unknown> = (u) => Linking.openURL(u),
): boolean {
  if (typeof url !== "string" || url.length > 512 || !HELP_URL.test(url)) return false;
  void open(url).catch(() => undefined);
  return true;
}
