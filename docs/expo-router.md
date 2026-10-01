# Expo Router

Paseo's mobile route tree is fragile because Expo Router and React Navigation do
not fail loudly when a nested native route is mounted under the wrong layout. The
usual symptom is a white or blank native screen with no JavaScript crash.

Read this before changing `packages/app/src/app`, startup routing, remembered
workspace restore, or active workspace selection.

## Ownership

Each layout owns only the routes directly inside its directory.

- The root layout registers `h/[serverId]`.
- The root layout does not register host leaf routes such as
  `h/[serverId]/workspace/[workspaceId]`, `h/[serverId]/open-project`, or
  `h/[serverId]/index`.
- `packages/app/src/app/h/[serverId]/_layout.tsx` owns the host leaves with
  relative screen names: `index`, `workspace/[workspaceId]/index`,
  `agent/[agentId]`, `sessions`, `open-project`, `settings`,
  `plugin/[pluginId]/[surfaceId]`, and
  `plugin/[pluginId]/[contributionKind]/[contributionId]`.

Expo Router warns with `[Layout children]: No route named ...` when a layout
registers grandchildren. Treat that warning as a route-tree bug. On native, that
shape can leave a nested index route mounted without its local dynamic params and
render a blank screen.

## Startup

The root `/` route chooses a host boundary. It does not jump directly into a host
leaf.

- Good: `/` -> `/h/[serverId]`
- Bad: `/` -> `/h/[serverId]/workspace/[workspaceId]`

`/h/[serverId]` restores a remembered workspace on that same host, waiting for
saved selection hydration. With no remembered workspace, it opens Fulcra work home
through the existing plugin surface runtime. This preserves an original Book
conversation after restart even when only Mini hosts the work overview. The
controller providing home must have `orca-organization`; unavailable controllers
retain the surface's normal loading/error state. Explicit conversation routes
keep their saved host and session identity.

The root still selects the remembered host boundary. It must not jump straight
to a plugin or workspace leaf, or silently choose another online host while the
remembered one connects. The private Fulcra app starts with its built-in daemon
management disabled; pairing selects the existing controller.

Returning from app settings restores an existing conversation workspace when one
is remembered. Without a workspace, it returns through `/` and the host boundary
to Fulcra home. Connecting a second host must not require opening a project first.

## Error Recovery

The root error boundary lives above `ExpoRoot` in `src/root-app.tsx`. Reload
remounts the router at `/open-project`, preserving saved workspace layouts and
the remembered selection. Do not move the boundary inside the root layout:
catching a render error there unmounts the navigator, so the recovery button
cannot reliably dispatch a navigation reset. Starting recovery at `/` would
restore the same workspace and could repeat the crash.

## App-Wide Route Hops

When app-wide routes such as `/new`, `/settings`, or `/sessions` navigate back
into a host workspace, use `navigateToWorkspace()`. Do not make the caller
branch on its current route.

Pass only `serverId` and `workspaceId` for normal attention-aware navigation.
When the action names a specific tab, pass it as `target`; that explicit choice
is authoritative. Callers should not choose between separate route and tab
navigation APIs.

The root stack owns `h/[serverId]`; the host stack owns
`workspace/[workspaceId]/index`. Repeated global-route hops must `POP_TO` the
root host route and pass the nested workspace screen when a host route is
already mounted, or Expo Router can append extra hidden workspace deck entries.
The workspace navigation helper inspects the mounted navigation state to make
that decision; if no host route is mounted yet, it falls back to ordinary route
navigation. Both paths wait for the root navigation container to be ready. The
workspace navigation owner keeps the latest pending intent across ref
re-registration and applies it on the container's `ready` event; routes must not
add their own readiness retries.

Those hidden entries are not harmless: composer floating panels can measure
against the wrong deck and disappear offscreen. Follow the
[retained panel measurement rules](coding-standards.md#retained-panel-measurements)
for components that intentionally remain mounted while hidden.

Hidden host routes may keep their local params while an app-wide route is
foregrounded. Active-workspace observers must prefer the current pathname and
only use local param fallback during cold mount (`/` or empty pathname), or a
hidden workspace can overwrite the remembered workspace before Settings or
History returns.

Plugin settings use the distinct `settings/hosts/[serverId]/plugins/[pluginId]/[screenId]` leaf;
Back returns to that host's Plugins page.

Settings detail routes are separate siblings on purpose. Keep
`settings/[section]`, the host routes, the projects index, and project detail as
distinct route names. `router.dismissTo()` ultimately matches stack entries by
route name. A single catch-all Settings route would make project detail and the
projects index the same route; Back would update params in place and leave a
phantom detail entry underneath. The host routes also stay outside the
store-ready protected group so a cold host deep link can survive daemon startup.
Do not collapse this topology with a catch-all, `getId`, or
`dangerouslySingular` workaround.

## Agent Targets

Notifications and agent URLs enter the router with different authoritative
targets.

- Notifications carry `serverId`, `workspaceId`, and `agentId`. Route them
  directly to the workspace with the agent open intent.
- Agent URLs carry only `serverId` and `agentId`. Route them through
  `/h/[serverId]/agent/[agentId]`; that route waits for the named host, resolves
  the agent's workspace from the host, and then opens the agent there.

Both paths converge on `navigateToAgent()`. Do not make notification routing
guess a workspace, and do not add a workspace to the stable agent URL format.

## Params

Required dynamic params belong to the matched route.

Do not paper over missing required params by reading global params in the leaf.
If `useLocalSearchParams()` misses a required param, fix layout ownership or the
startup route shape.

Use the host route context for host-owned leaves that need the host id after
`h/[serverId]/_layout.tsx` has matched. Do not make a leaf recover from an
unmatched tree by guessing from global state.

## App Directory

Keep non-route modules out of `src/app`. Expo Router treats ordinary `.ts` and
`.tsx` files there as routes, which produces `missing the required default
export` warnings and pollutes the route tree.

Put shared route policy in `src/navigation`, `src/utils`, stores, or another
non-route directory.

## Native Stack

Keep workspace identity and retention outside native-stack `getId` and
`dangerouslySingular`. Expo Router maps `dangerouslySingular` to React
Navigation `getId`, and `getId` has broken Android native-stack/Fabric by
reordering an already-mounted workspace screen.

Use `ThemedStack` from `packages/app/src/navigation/themed-stack.tsx` for every
Expo Router stack. React Navigation otherwise paints each native stack screen
with its light default background. A screen-level wrapper can hide that surface
while settled, but Android may expose it for one frame when navigation crosses
from a nested stack to its parent stack. This is especially visible when an
app-wide route such as `/new` opens from a dark workspace.

Do not read the active theme with `useUnistyles()` in a layout to build
`screenOptions`. `ThemedStack` keeps that third-party prop theme-reactive through
a small `withUnistyles` boundary without subscribing the route tree itself to
every Unistyles runtime update.

Navigators keep their identity across appearance changes. `ThemedStack` remounts
each screen's content below the native stack when appearance tokens change; a
keyed wrapper above a stack remounts the stack itself, and Android crashes when
that happens while a FragmentManager transaction is running, which settings
hydration at startup makes likely. A screen that mounts a nested navigator (the
root stack's `h/[serverId]`) is passed in `nestedNavigatorScreens` so the nested
stack owns its own screens. See [unistyles.md](unistyles.md).

## Regression Shape

Pure helper tests are useful but not enough. The failure mode here is native
route-tree state, so a real regression should launch native with seeded persisted
state:

1. Seed `paseo:last-workspace-route-selection` with a valid
   `{ serverId, workspaceId }`.
2. Launch the native app cold.
3. Assert a real screen is visible, not the blank tree.
4. Assert no `[Layout children]` warning appears.

The pure policy tests should still enforce the boundary split:

- root startup with a saved workspace returns `/h/[serverId]`;
- host index with the same saved workspace returns
  `/h/[serverId]/workspace/[workspaceId]`;
- host index with no restorable workspace returns Fulcra home
  (`/h/[serverId]/plugin/orca-organization/sidebar/organization`) when that host contributes
  the surface, and `/open-project` when it does not. Fulcra home lives in a plugin, and the
  catalog arrives after connect, so the index waits rather than redirecting while a connected
  host that supports plugins is still answering. Offline, unsupported and failed lookups
  resolve immediately — a permanent redirect to a surface that never loads strands the app on
  a screen with no menu.

## Checklist

Before landing route changes:

- [ ] Did you change `packages/app/src/app`? Re-read this file.
- [ ] Did you touch remembered workspace restore? Keep root on `/h/[serverId]`.
- [ ] Did a route return to a workspace? Use `navigateToWorkspace()` and pass a
      `target` when the action names a specific tab.
- [ ] Did you add a route? Register it in the layout that directly owns it.
- [ ] Did `useLocalSearchParams()` lose a required param? Fix the route tree.
- [ ] Did native show a blank screen without a crash? Suspect route ownership
      before stores, themes, or rendering.
