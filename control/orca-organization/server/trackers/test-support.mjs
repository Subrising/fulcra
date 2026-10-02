// J3 test ports: recorded synthetic fixtures behind a fake fetch, a counting fake keychain and a manual
// clock. No test in this directory reaches the network or a real credential.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (tracker, name) =>
  JSON.parse(fs.readFileSync(path.join(here, "fixtures", tracker, name), "utf8"));
export function response(status, body, headers = {}) {
  const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: new Headers(headers),
    body:
      text === null
        ? null
        : (async function* () {
            yield Buffer.from(text);
          })(),
  };
}
// routes: { [url]: response | (init, n) => response | { throw: message } }. Unknown URLs are 404.
export function fakeFetch(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init: { ...init, headers: { ...init.headers } } });
    const route = routes[url];
    const r =
      typeof route === "function" ? route(init, calls.filter((c) => c.url === url).length) : route;
    if (!r) return response(404, { message: "Not Found" });
    if (r.throw) throw new Error(r.throw);
    return r;
  };
  fetcher.calls = calls;
  return fetcher;
}
export function fakeSecrets(values) {
  const reads = [];
  return {
    reads,
    async read(name) {
      reads.push(name);
      return Object.hasOwn(values, name) ? values[name] : null;
    },
  };
}
export function clock(start = Date.parse("2026-09-23T12:00:00Z")) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}
export const GH = "https://api.github.com";
export const githubRoutes = (extra = {}) => ({
  [`${GH}/repos/Subrising/scratch`]: () => response(200, fixture("github", "repo.json")),
  [`${GH}/repositories/123456`]: () =>
    response(200, fixture("github", "repo.json"), { etag: 'W/"repo"' }),
  [`${GH}/repositories/123456/issues?state=open&per_page=50&sort=updated`]: () =>
    response(200, fixture("github", "issues-open.json"), { etag: 'W/"list-1"' }),
  [`${GH}/repositories/123456/issues/7`]: () =>
    response(200, fixture("github", "issues-open.json")[0]),
  [`${GH}/repositories/123456/issues/12`]: () =>
    response(200, fixture("github", "issue-12-closed.json")),
  [`${GH}/repositories/123456/issues/13`]: () =>
    response(200, fixture("github", "issue-13-pr.json")),
  [`${GH}/repositories/123456/issues/14`]: () =>
    response(200, fixture("github", "issue-14-foreign.json")),
  ...extra,
});
export const MAPPING = Object.freeze({
  projectId: "22222222-2222-4222-8222-000000000001",
  tracker: "github",
  auth: "keychain",
  site: "github.com",
  remoteId: "123456",
  remoteName: "Subrising/scratch",
  state: "mapped",
  revision: 1,
});
