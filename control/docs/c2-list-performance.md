# Session-list performance fixture

The focused `src/control/list-batch.test.mjs` check uses a temporary SQLite journal with 100 sessions, shuffled insertion order, local and remote routes, delegation transitions, duplicate worker relationships and pending revocations. It also checks the journal without a manager-worker table.

Observed on Node 24.21.0:

| Projection                      | SQL reads |  Elapsed |
| ------------------------------- | --------: | -------: |
| Original per-session projection |       335 | 4.784 ms |
| Batched projection              |         4 | 0.852 ms |

The outputs passed strict deep equality, including child-record order and SQLite row prototypes. The timing covers the list query and projection, excluding fixture setup. These are fixture timings, not a measurement of a live controller. Reads count executed SQL statements, including the initial session list. The test enforces at most ten.
