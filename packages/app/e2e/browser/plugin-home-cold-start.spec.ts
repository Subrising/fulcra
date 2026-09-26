import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";

// The home plugin is a plugin surface, and the host index has to decide where to send a cold start
// before the catalog that contains it has arrived. Redirect is permanent, so deciding early
// sends a host that DOES have the home plugin to the fallback with no way back. Every other spec
// here runs without this plugin installed, so the present-plugin path had no coverage at all.
const PLUGIN_ID = "organization";
const SIDEBAR_ID = "organization";
const SURFACE_MARKER = "The home plugin surface mounted";

const PLUGIN_SOURCE = `import React from "react";
import { Text, View } from "react-native";

function OrcaHomeSurface() {
  return <View><Text>${SURFACE_MARKER}</Text></View>;
}

export default function contribute(client) {
  client.addSurface(${JSON.stringify(SIDEBAR_ID)}, OrcaHomeSurface);
  client.addSidebarItem({
    id: ${JSON.stringify(SIDEBAR_ID)},
    title: "Home",
    icon: "House",
    surface: ${JSON.stringify(SIDEBAR_ID)},
  });
  return () => {};
}`;

test("host index reaches the home plugin on a cold start, after the catalog arrives", async ({
  page,
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-home-e2e-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });

  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(path.join(directory, "index.client.tsx"), PLUGIN_SOURCE);
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);

    // Precondition, asserted rather than assumed: the daemon really serves this plugin with
    // the organization sidebar contribution. Without this a fixture mistake and a routing bug
    // look identical from the page.
    const catalog = await client.getPluginCatalog();
    const entry = catalog.find((item) => item.id === PLUGIN_ID);
    expect(entry, `daemon catalog: ${JSON.stringify(catalog.map((item) => item.id))}`).toBeTruthy();

    // A genuine cold start: no remembered workspace, no cached catalog, and the first
    // connection still ahead of us. Nothing is stubbed — the delay is the real one the app
    // hits every time it launches.
    // Straight to the host index in a fresh page: the first connection and the catalog are
    // both still ahead of the routing decision. Storage is left alone deliberately — clearing
    // it also drops the host registration, which is a different scenario.
    await page.goto(`/h/${encodeURIComponent(getServerId())}`);

    // The routing decision is what is under test, so assert it first and by itself: a bounded
    // wait on the catalog is allowed, a permanent redirect away from the home plugin is the bug.
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
      .toContain(`/plugin/${PLUGIN_ID}/sidebar/${SIDEBAR_ID}`);
    await expect(page.getByText(SURFACE_MARKER, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => {});
    await client.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});
