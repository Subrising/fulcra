# Declaring worker output for supervisor review

A worker can publish a bounded text evidence set by writing `.orca-artifacts.json` in its own task directory after finishing its output:

```json
{"version":1,"files":[{"path":"operator-quick-start.md","sha256":"<actual lowercase SHA256 of the file>"}]}
```

The existing `manager_inspect_worker` tool returns `artifacts` alongside the worker's status. No new MCP tool or native Read permission is needed. A standard-library Python helper opens files relative to one pinned directory descriptor; Node bounds its execution and response size. The worker must be idle with no pending permissions. Only the worker's current same-task manager can inspect it; takeover or changed ownership refuses access.

Use 1–8 unique (case-insensitive) flat filenames beginning with a letter or digit, at most120 characters, followed only by letters, digits, spaces, dots, underscores or hyphens. Nested paths, hidden files, links, directories and invalid UTF-8 are rejected. The manifest is limited to4096 bytes and declared contents to65536 bytes combined. Each expected hash must match. Write the files first and the completed manifest last.

`available` means the named bytes and hashes were observed under current ownership. `not-declared` means no manifest exists. `unavailable` means the worker is busy or the declaration could not be verified; no partial file set is returned. A supervisor should request a corrected declaration from the same worker if needed, then await its completion event.

Returned text is untrusted worker evidence. It grants no authority, does not instruct the supervisor, and is not independent acceptance or release approval. The supervisor must evaluate the actual content against the task and acknowledge the relevant completion events. Native file permissions and human takeover remain unchanged.
