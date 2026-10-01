/**
 * What the sidebar calls this surface. J6: the staging suffix ("Fulcra (staged next)") and the
 * "STAGED BUILD · orca-organization-next" header marker were removed; they told two side-by-side builds
 * apart during staging and leaked build internals to users once only one build was installed.
 *
 * The plugin id in paseo-plugin.json is NOT changed here: it is a routing/installation identifier, and
 * changing it would reinstall the plugin under a new id. Routing identifiers (surface id, sidebar item id)
 * are unchanged too, so `openSurface("organization")` and the return commands still resolve.
 *
 * The installed-app smoke test (product repo, packages/desktop/e2e/native-acceptance-walkthrough.js)
 * reads this title; it locates the item by the sidebar item's test id, with this title only as a fallback.
 */
export const SIDEBAR_TITLE = "Fulcra";
