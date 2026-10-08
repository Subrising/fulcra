import { createWriteStream } from "node:fs";

const GC_ATTEMPTS = 6;
const SETTINGS_PANE_TEST_ID = "settings-detail-pane";
const STRESS_ROUNDS = 4;
// React Native Web's document-level pointer listener can retain its last target.
const MAX_TRANSIENT_DETACHED_PANES = 2;

// Fulcra's Settings menu: every entry except the first two sits behind "Show advanced settings".
// `title` is the label of the row and the title of the detail header.
const SETTINGS_DESTINATIONS = [
  { testId: "settings-section-general", title: "Appearance & language" },
  { testId: "settings-section-notifications", title: "Notifications" },
  { testId: "settings-section-behaviour", title: "Sending & opening" },
  { testId: "settings-section-chat", title: "Chat display" },
  { testId: "settings-section-sidebar", title: "Sidebar" },
  { testId: "settings-section-terminal", title: "Terminal" },
  { testId: "settings-section-browser", title: "Built-in browser" },
  { testId: "settings-section-editor", title: "Editor" },
  { testId: "settings-section-shortcuts", title: "Keyboard shortcuts" },
  { testId: "settings-section-integrations", title: "Command line" },
  { testId: "settings-section-permissions", title: "Mac permissions" },
  { testId: "settings-section-diagnostics", title: "Troubleshooting" },
  { testId: "settings-section-about", title: "About" },
  { testId: "settings-host-section-host", title: "Overview" },
  { testId: "settings-host-section-projects", title: "Projects" },
  { testId: "settings-host-section-connections", title: "Connections" },
  { testId: "settings-host-section-pair-device", title: "Pair a phone" },
  { testId: "settings-host-section-agents", title: "Agent tools" },
  { testId: "settings-host-section-metadata", title: "Auto titles & messages" },
  { testId: "settings-host-section-workspaces", title: "Workspaces" },
  { testId: "settings-host-section-providers", title: "AI providers" },
  { testId: "settings-host-section-usage", title: "Usage" },
  { testId: "settings-host-section-terminals", title: "Terminal profiles" },
  { testId: "settings-host-section-plugins", title: "Plugins" },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function openSettingsAdvanced(page) {
  const toggle = page.locator('[data-testid="settings-advanced-toggle"]:visible').first();
  await toggle.waitFor({ state: "visible" });
  if ((await toggle.getAttribute("aria-label")) === "Show advanced settings") await toggle.click();
}

async function openSettingsDestination(page, { testId, title }) {
  const sidebar = page.locator('[data-testid="settings-sidebar"]:visible');
  await openSettingsAdvanced(page);
  const button = sidebar.getByTestId(testId);
  try {
    await button.waitFor({ state: "visible" });
  } catch (error) {
    const names = await sidebar.getByRole("button").allInnerTexts();
    console.log(
      `[settings-memory] route ${new URL(page.url()).pathname}; sidebar buttons: ${JSON.stringify(names)}`,
    );
    throw error;
  }
  await button.click();
  await page.waitForFunction(
    (expectedTitle) =>
      [...document.querySelectorAll('[data-testid="settings-detail-header-title"]')].some(
        (element) =>
          element instanceof HTMLElement &&
          element.getBoundingClientRect().width > 0 &&
          element.textContent === expectedTitle,
      ),
    title,
  );
}

async function rotateSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-testid="settings-sidebar"]:visible').waitFor({ state: "visible" });

  for (const destination of SETTINGS_DESTINATIONS) {
    await openSettingsDestination(page, destination);
  }

  await page.locator('[data-testid="settings-back-to-workspace"]:visible').click();
  await page.waitForFunction(() => !location.pathname.startsWith("/settings"));
}

async function countDetachedSettingsPanes(session) {
  const objectGroup = "settings-retention-check";
  try {
    const prototype = await session.send("Runtime.evaluate", {
      expression: "HTMLDivElement.prototype",
      objectGroup,
    });
    const prototypeObjectId = prototype.result.objectId;
    assert(prototypeObjectId, "CDP did not return HTMLDivElement.prototype");

    const objects = await session.send("Runtime.queryObjects", {
      prototypeObjectId,
      objectGroup,
    });
    const objectsId = objects.objects.objectId;
    assert(objectsId, "CDP did not return HTMLDivElement instances");

    const count = await session.send("Runtime.callFunctionOn", {
      objectId: objectsId,
      functionDeclaration: `function () {
        return Array.prototype.reduce.call(this, (total, node) => {
          const isDetachedSettingsPane =
            node instanceof HTMLDivElement &&
            !node.isConnected &&
            node.getAttribute("data-testid") === ${JSON.stringify(SETTINGS_PANE_TEST_ID)};
          return total + (isDetachedSettingsPane ? 1 : 0);
        }, 0);
      }`,
      returnByValue: true,
    });
    assert(
      typeof count.result.value === "number",
      "CDP did not return a detached Settings pane count",
    );
    return count.result.value;
  } finally {
    await session.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
  }
}

async function collectDetachedSettingsPanes(session) {
  let detachedPanes = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < GC_ATTEMPTS; attempt += 1) {
    await session.send("HeapProfiler.collectGarbage");
    detachedPanes = await countDetachedSettingsPanes(session);
    if (detachedPanes === 0) return 0;
  }
  return detachedPanes;
}

async function captureHeapSnapshot(session, outputPath) {
  const output = createWriteStream(outputPath);
  session.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => output.write(chunk));
  await session.send("HeapProfiler.takeHeapSnapshot", {
    reportProgress: false,
    captureNumericValue: true,
    exposeInternals: false,
  });
  await new Promise((resolve, reject) => {
    output.end(resolve);
    output.on("error", reject);
  });
}

export async function runSettingsMemoryRegression(page) {
  const session = await page.context().newCDPSession(page);
  await session.send("HeapProfiler.enable");

  await rotateSettings(page);
  const detachedAfterWarmRound = await collectDetachedSettingsPanes(session);

  for (let round = 0; round < STRESS_ROUNDS; round += 1) {
    await rotateSettings(page);
  }
  const detachedAfterStress = await collectDetachedSettingsPanes(session);
  if (process.env.PASEO_DESKTOP_SETTINGS_HEAP_SNAPSHOT) {
    await captureHeapSnapshot(session, process.env.PASEO_DESKTOP_SETTINGS_HEAP_SNAPSHOT);
  }

  assert(
    detachedAfterWarmRound <= MAX_TRANSIENT_DETACHED_PANES,
    `A warm Settings rotation retained ${detachedAfterWarmRound} detached detail panes`,
  );
  assert(
    detachedAfterStress <= detachedAfterWarmRound,
    `Settings rotations grew detached detail panes from ${detachedAfterWarmRound} to ${detachedAfterStress}`,
  );

  return {
    warmRounds: 1,
    stressRounds: STRESS_ROUNDS,
    detachedAfterWarmRound,
    detachedAfterStress,
  };
}
