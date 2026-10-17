# Claude API key storage

Fulcra stores pooled Claude API keys in the macOS Keychain or Windows DPAPI storage.
Other platforms refuse API key launches.
The key reaches Claude through `apiKeyHelper` stdout.
The helper command contains account references and fixed code only.
API keys do not enter launch arguments, launch environments, chat environments, or session settings.
Subscription token transport and Codex authentication use their existing paths.

The helper checks account state before and after each store read.
Credential writes and deletes run one at a time for each account.
Revoke blocks the account before it waits for this lock.
Replacement restores access only if its credential generation still matches.
Replacement blocks the account and changes its generation before the OS store write.
A disabled, revoked, missing, replaced, or reassigned account cannot supply a key.
Account replacement changes the credential generation.
Old helper commands cannot read the replacement key.
The daemon removes inherited authentication variables and copied API key values from pooled API launches.
It refuses native settings that supply authentication or conflict with the helper.
Other native settings keep their normal behavior.
The preflight uses the SDK settings resolver for managed files, MDM, registry, and cached server settings.
It refuses a managed policy helper because the resolver cannot inspect its future output.
Pooled API settings cannot replace the helper or inject authentication through settings `env`.

## API spend and billing warnings

Fulcra has no daily, account, session, or worker spend caps. It never refuses an API turn because of spend.
Accounting recovery records a warning if storage fails. It does not stop the next turn.
Native background and scheduled API work have no spend gate.

The first durable billing error for an API account creates one warning for its owning lead and the Main assistant.
Repeated errors stay in the same incident. A later successful turn clears it. A new billing error starts another incident.
The warning uses the provider's billing error signal. Fulcra does not read a cash balance or invent one.
It has no dollar or percentage threshold.
Each recipient has a durable receipt. A missing lead or Main binding remains pending.
A one-shot call uses its authenticated caller session when the host supplies one.
Without that session, only Main can receive its warning. Fulcra does not guess an owner from other account users.
Successful observations have durable timestamps and source IDs. Older errors cannot reopen a recovered incident.
Distinct observations at the same timestamp follow their saved observation order.
One-shot accounting faults keep a secret-free retry record. Recovery does not change the returned provider result.

`organization.accounts.update` accepts the owner-only `topUpAt` reporting date as an ISO timestamp.
Set it to `null` to report all recorded spend since account creation. The date never controls admission or warnings.

`paseo inspect <id> --json` and session usage RPCs expose cumulative `sessionCost`.
Worker finish records retain the final turn's cost. Native inbox events expose `totalSpendUsd`.
Finish notices include the session total. Account usage reports show recorded spend since the reporting date.
These figures come from provider result records on this host. Missing cost data remains unavailable.

## Revoke a key locally

Run `fulcra account revoke <name-or-id>`.
The command blocks the account first, removes its stored credential, and stops its API processes.
Session history remains available.
Running one-shot calls stop when account state becomes unavailable.
If deletion or process stopping fails, the command reports failure and keeps the account blocked.
Retry the command to complete removal.
If automatic crash recovery cannot confirm process identity, use the recovery steps below.

Local revoke does not invalidate the provider's key.
Use Claude Console to revoke the key for all applications and machines.
An HTTP request already accepted by the provider can finish.
Runtime stop checks use process leases and private stop channels, independent of bounded assignment history.
The channel carries a stop capability and a completion reply. It never carries an API key.
Each lease records the owner and child process IDs and native creation times.
After an owner crash, recovery stops the child tree only if the creation time matches.
A missing child permits lease removal. A different creation time keeps the lease for operator inspection.
Revoke can recover a credential lock after its owner has ended and the lock is at least one second old.
Metadata locking serializes recovery with other credential lock attempts.
An uncertain lock or lease leaves the account blocked and reports failure.

### Manual crash recovery

1. Keep the account blocked after a failed revoke.
2. Stop the daemon that owns the account store.
3. Inspect the named lease under `<Command Centre home>/accounts/api-runtimes/`.
4. Verify the recorded child and its descendants have ended with native process tools.
5. Remove that lease only after this check.
6. For a legacy lease without child identity, verify all affected Claude processes have ended first.
7. Inspect `.credential-<account UUID>.lock` under the same account store.
8. Remove that lock only after its recorded owner has ended.
9. Start the daemon and retry local revoke.

Do not remove a lease or lock while its process identity is uncertain.
The helper always uses `/usr/bin/security` on macOS; environment overrides cannot select a reader.
On Windows, PowerShell sets the nonsecret Electron flag inside the helper process.
This entry command has the same form for cmd.exe and Git Bash callers.

## Storage before this change

The base account implementation uses these locations:

| Data                      | Location                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------- |
| macOS pooled Claude key   | Keychain generic password, service `Fulcra account`, account UUID                       |
| Windows pooled Claude key | `<Command Centre home>/accounts/secrets/<UUID>.dpapi`, protected with DPAPI CurrentUser |
| Account metadata          | `<Command Centre home>/accounts/accounts.json`; no credential field                     |
| Interactive API transport | `ANTHROPIC_API_KEY` in the Claude launch environment                                    |
| One-shot API transport    | `ANTHROPIC_API_KEY` in the one-shot Claude environment                                  |

The previous hook supplied launch credentials without saving them in account metadata.
The previous process environment exposed keys to process inspection and child tools.
Provider configuration can also contain user-supplied environment values.
Native Claude user, project, local, or managed settings can contain an authentication `env` map.
Those values can remain in provider configuration files and native shell snapshots.
Shell profiles, service definitions, shell history, copied diagnostics, and prior external scripts need separate operator inspection.
This change does not inspect or modify those live locations.

## Move existing keys safely

1. Stop the affected sessions and one-shot calls.
2. Revoke the old API key in Claude Console.
3. Remove old API authentication entries from provider settings, shell profiles, and service definitions.
4. Remove exposed environment values from provider configuration.
5. Treat old process captures, logs, chat records, and backups as exposed data.
6. Create a replacement key in Claude Console.
7. Enter the replacement through Settings → Accounts on the trusted host connection.
8. Start a new session with that account.

Do not paste keys into a chat, terminal command, environment variable, or helper script.
Do not export a live Keychain item or decrypt a live DPAPI file to perform this migration.
Existing protected items need no export or relocation.
Fulcra uses them through the helper after the update.
Rotate any key previously exposed through an environment or file.

Native setting behavior follows [Claude settings precedence](https://code.claude.com/docs/en/settings) and [authentication precedence](https://code.claude.com/docs/en/authentication).

The OS account remains a trust boundary.
Programs with that user's Keychain or DPAPI access can request credentials directly.
`apiKeyHelper` removes accidental file and environment transport; it does not isolate hostile programs with equal OS access.
