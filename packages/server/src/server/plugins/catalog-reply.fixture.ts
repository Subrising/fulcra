import { readFileSync } from "node:fs";

// Opt-in integration fixture: a captured real catalog reply, never a size-only string.
// Set FULCRA_TEST_CATALOG_REPLY to the JSON receipt from the staged packaged daemon.
export const catalogReplyPath = process.env.FULCRA_TEST_CATALOG_REPLY;
export function capturedCatalogReply() {
  if (!catalogReplyPath) throw new Error("FULCRA_TEST_CATALOG_REPLY is required");
  const receipt = JSON.parse(readFileSync(catalogReplyPath, "utf8"));
  const frame = receipt.frame;
  if (frame?.type !== "session" || frame.message?.type !== "plugin.catalog.get.response")
    throw new Error("Expected a captured catalog reply");
  const plugin = frame.message.payload.plugins.find(
    (entry: { id: string }) => entry.id === "orca-organization-next",
  );
  if (typeof plugin?.clientBundle !== "string" || !plugin.clientBundle.includes("function"))
    throw new Error("Captured Command Centre client script is missing");
  return { frame, plugin: plugin as { id: string; clientBundle: string } };
}
