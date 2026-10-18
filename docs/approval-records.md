# Approval records

Fulcra records permission replies at the daemon boundary. It preserves the existing policy.

Each `permission.decision` log entry has these fields:

| Field                                 | Meaning                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `recordedAt`                          | UTC record time                                                        |
| `agentId`, `sessionId`, `sessionName` | Job identity and native session identity                               |
| `requestId`, `tool`                   | Exact permission request and tool                                      |
| `target.cwd`, `target.inputSha256`    | Work folder and digest of the tool input                               |
| `rule`, `source`                      | Applied rule and recorded input source                                 |
| `decision`                            | Delivered allow, delivered deny, deferred approval, or failed delivery |

Use the request ID to find the exact target in the private native timeline.
The digest identifies its arguments without copying commands, file contents, credentials, or response messages.
A modified input uses the digest of the input that was allowed.
A missing session name or native identity remains null. The record does not invent a person.
`human` identifies the native RPC source. It does not identify a named person.

Automatic decisions use the trusted automatic permission rule. A defer record means the host refused automatic approval.
It does not mean that the provider denied the tool. Manual guards and later human decisions remain active.
An allow record follows provider acknowledgement. A failed reply does not produce an allow record.
History replay does not create new approval records.

Computer Use consent records also name the app, bundle, and server.
The rule identifies a listed app grant or a remembered answer. Policy refusal writes a separate defer record.

`scripts/approval-record.py` records existing command hooks. It runs the hook and passes its result through.
It never runs the requested tool. Empty output means `pass`, which means this hook supplied no veto.
A hook error, invalid output, or audit failure blocks the proposed tool with exit code two.
On POSIX hosts, the append-only log must be a private, owned, regular file.
Windows uses the user directory's inherited access controls. Writes use a file lock on all hosts.
The default path is `~/.fulcra-guards/approval-records.jsonl`.

The optional `--kind git` mode records an existing git hook's exit status.
It preserves hook stdin. It stores only its digest. It does not run a commit or push itself.

User files are local policy. Back them up before a change.
Propose settings beside existing files as `<name>.new`. Preserve edits made after the proposal.
Install the recorder before settings that call it. Keep the original hook commands and matchers.
Remove a warning-only hook from the approval path only when it has no security decision.
Never remove secret, public-push, private-data, archive, heavy-job, or merge guards under this procedure.

Run the Python tests with `python3 scripts/approval-record.test.py`.
Run focused manager tests and the server type check through the project's normal commands.
Direct hook tests prove the hook logic and record format. They do not prove an installed daemon release.
