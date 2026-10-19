import { createServer } from "node:http";
import registry from "./registry.fixture.json" with { type: "json" };

import securityPlugin from "./overview.fixture.json" with { type: "json" };

import overviewCorpus from "../../protocol/tests/fixtures/plugin-overview.json" with { type: "json" };
securityPlugin.readme +=
  "\n\n" +
  overviewCorpus
    .map(({ markdown }) => markdown + "\n\n```html\n" + markdown + "\n```")
    .join("\n\n");

// Serve the published registry contract so SSR and browser navigation use the same data.
// A fixed GitHub release and repo, so a GitHub outage or rate limit cannot fail page tests.
const version = "0.11.4";
const githubReleases = [
  {
    tag_name: `v${version}`,
    prerelease: false,
    draft: false,
    assets: [
      `Paseo-${version}-arm64.dmg`,
      "Paseo-x86_64.AppImage",
      `Paseo-Setup-${version}-x64.exe`,
      `Paseo-Setup-${version}-arm64.exe`,
      `paseo-v${version}-android.apk`,
    ].map((name) => ({ name })),
  },
];

createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/github/repos/getpaseo/paseo/releases?per_page=10") {
    response.end(JSON.stringify(githubReleases));
    return;
  }
  if (request.url === "/github/repos/getpaseo/paseo") {
    response.end(JSON.stringify({ stargazers_count: 1234 }));
    return;
  }
  if (request.url === "/index.json") {
    response.end(JSON.stringify(registry));
    return;
  }
  const plugin = [securityPlugin, ...registry.plugins].find(
    (entry) => request.url === `/plugins/${entry.id}.json`,
  );
  response.statusCode = plugin ? 200 : 404;
  response.end(JSON.stringify(plugin ?? { error: "Plugin not found" }));
}).listen(8188, "127.0.0.1");
