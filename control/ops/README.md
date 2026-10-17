# Archive guards for account switch jobs

`archive-maintenance.patch` updates the work-switch source and the latest FU-225 monitor source.
It also updates their isolated fixtures.
These sources are private task files. They are not part of the product install.

Apply the patch from the task root that contains `ops/`.
Copy `../src/control/archive-guard.mjs` from this directory into each patched script directory first.
Each script checks list metadata and fresh native archive state.
A wait worker checks again after its completion event.
The work-switch reload fallback checks again before reload.
The FU-225 monitor checks again before each switch attempt.

Run these commands from that task root:

```sh
python3 ops/work-switch/check.py
node ops/fu225-r4/candidate/fixture.mjs
```

The fixtures use temporary homes and synthetic accounts.
They do not call a live daemon or provider.
They test stale list records, archive changes during loading, and archive changes before reload.

The patch changes source files only.
Do not run an installer or change an installed monitor during this repair.
