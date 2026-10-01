# C2c display fixtures

The preview uses synthetic sessions with UUID folder names and the production sidebar row and
control-chip components. For example, a generated folder becomes “Fixture launch plan”, while a
session without a title becomes “Untitled session”. No personal data is used.

The component preview is deliberately labelled; it does not launch the app, a host or any provider.
The capture script rejects external page requests and checks visible text for private paths and raw
UUIDs before taking dark/light screenshots at 1280×800 and 390×844.

Run `node scripts/c2c-ui-fixture/capture.mjs --build` under the job's heavy-work lock, then
`node scripts/c2c-ui-fixture/capture.mjs` under its test-slot wrapper. Dependencies and Chrome are
required. V1c reused the identical-lockfile install and verified this preview. All four captures
passed the visible-name, Medium effort, privacy and horizontal-overflow checks and were visually
inspected. The capture resolver replaces only exact adapter modules, retaining real submodules such
as status-ring geometry. Browser launch uses mock Keychain/basic-password-store flags; temporary
files stay in the job directory and the local server closes even if browser launch fails.

Screenshots: [dark desktop](../../orca-organization/docs/screens/c2c/sidebar-draft-dark-1280x800.png),
[light desktop](../../orca-organization/docs/screens/c2c/sidebar-draft-light-1280x800.png),
[dark mobile](../../orca-organization/docs/screens/c2c/sidebar-draft-dark-390x844.png),
[light mobile](../../orca-organization/docs/screens/c2c/sidebar-draft-light-390x844.png).

Verification: 59 tests passed across the six mapped app files, all six source smoke checks passed,
and the app workspace typecheck passed after the protocol/client declaration build. These captures
show production rows and control chips in a labelled synthetic scaffold; they do not claim full-app
or live-provider end-to-end verification.

The dependency-free fallback is a narrower source smoke check, not a replacement for Vitest or
rendered UI verification. Run this one file through the job's test-slot wrapper:

```sh
node --import ./scripts/c2c-ui-fixture/source-loader.mjs --test ./scripts/c2c-ui-fixture/source-smoke.test.mjs
```

It loads actual TypeScript source through Node 24, using a resolver only for app aliases and source
extensions. It does not mock product modules. It checks naming, title precedence, sidebar projection,
headers and the draft effort default; it does not execute the project-summary or picker integration.

## Project-heading polish

The current fixture also exercises a real project name (“Example shop”), an identifier-only custom
name (“Untitled project”), and a meaningful custom name (“Launch planning”). The capture asserts the
three actual projected headings and scans all rendered text for UUIDs and private paths. Workspace
identity and titles are unchanged. Updated captures are under
`orca-organization/docs/screens/polish-sidebar/`; this remains an isolated component preview.
