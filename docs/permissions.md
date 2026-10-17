# Daemon permissions

The daemon authorizes principals with semantic permissions. RPC names and protocol namespaces are not authority.

For the daemon-to-daemon worker and notice boundary, see [host links](host-links.md).

## Model

```text
principal -> grants
    |
    +-- authenticated by a device or service credential
    `-- opens a session with equal or narrower authority
```

A principal is the durable identity the daemon authorizes. A credential proves that a device or service represents it. Keep them separate so you can rotate credentials, attach more than one device, and revoke a Hub user without inventing daemon user accounts.

A pairing invitation is neither. It is an expiring, single-use exchange that creates a principal and credential with the permissions selected by its issuer.

## Permissions

| Permission              | Authority                                                                  |
| ----------------------- | -------------------------------------------------------------------------- |
| `daemon.read`           | Daemon status, diagnostics, configuration, and provider information        |
| `daemon.manage`         | Restart, update, configuration changes, providers, skills, and plugins     |
| `tunnel.manage`         | Relay, Hub, service tunnel, and public endpoint relationships              |
| `access.manage`         | Pairing invitations, principals, credentials, grants, and revocation       |
| `workspace.read`        | Projects, workspaces, agents, timelines, files, diffs, and terminal output |
| `workspace.write`       | Prompts, agent control, files, terminals, git operations, and scripts      |
| `workspace.manage`      | Create, rename, archive, and remove projects and workspaces                |
| `automation.manage`     | Schedules, heartbeats, and loops                                           |
| `command-centre.manage` | Per-request authenticated bundled controller management                    |
| `accounts.manage`       | Local owner account administration and account switching                   |
| `hub.execute`           | Agent lifecycle, workspace titling, observation, and recovery              |

Agents and terminals use workspace authority. Both can execute code and mutate the workspace, so separate write permissions would claim an isolation boundary the daemon cannot enforce.

Owner, operator, and viewer are UI presets expanded into explicit permissions. Do not persist them as roles. Adding a permission must not silently widen an existing principal.

Permissions are additive allows. Missing authority denies the operation. Do not add deny precedence.

A paired device never stores `command-centre.manage` or `accounts.manage` in its permission list.
The registry adds a management permission only while this Mac's owner has granted it. Each grant starts off.
Today only relay sockets carry device authentication. A direct connection uses the host password.
See [device-key login on direct connections](direct-device-login.md) for the planned change.
`accounts.manage` is a legacy device grant. It does not permit account administration or cross-session account switches on a paired device.

A normal paired device can use `/account` without either management grant. It needs `daemon.read`, `workspace.read`, and `workspace.write`.
The host binds account requests to the source socket's focused chat and live timeline. It checks this binding before dispatch and before list replies.
The phone reports its focus and subscriptions. This intent check prevents cross-tab mistakes; it does not isolate a compromised device with `workspace.write`.
A completed switch keeps its result when focus changes. Failed device audit writes return a warning with that successful result.
A switch uses the existing idle, account-limit, history, and native recovery checks. A session under another owner's delegation refuses the switch.
The account list contains routing IDs, names, provider, and status only. Status can include a limit reason and reset time.
The list excludes credentials, pool settings, budgets, and other session assignments. Completed device switches record the device ID in `accounts-audit.json`. Uncertain outcomes remain in the controller journal with the device ID.
Account creation, removal, credentials, pool settings, and explicit account takeover require the local owner on the host Mac.
Read-only Command Centre calls also require a current host grant at invocation and dispatch. Removing or suspending that grant refuses later calls.
Clients without `command_centre_permission` do not receive the management permissions on the wire because their permission enum is closed.

An operation may require several existing permissions together. Session-bound quota reads require both `workspace.read` for the native session identity and `daemon.read` for account usage. Apply this conjunction to requests and replies so revocation also prevents delivery of an in-flight result. Existing arrays of alternative permissions remain any-of requirements.

## Resources

Permissions are daemon-wide today. Future grants may select workspaces or agents, but operation classification remains inside the authorization module:

```ts
type Grant = {
  permission: Permission;
  resource: { kind: "daemon" } | { kind: "workspace"; ids: string[] };
};
```

A delegating principal can grant only authority it already possesses. A session may attenuate its principal's grants but cannot widen them.

Workspace-scoped grants require every resource-bearing operation and outbound observation to enforce the same workspace boundary. File preview currently accepts any daemon-readable regular file, so it must gain resource enforcement before workspace-specific access ships.

## Adopting a tool capability on a retained agent

An agent that already exists cannot reach a tool its saved policy does not preapprove.
Replacing the agent would grant it and lose the session's history, so `agent.mcp.refresh`
carries the MCP server entry and the tool policy together:

```ts
{ agentId, expected: { provider, sessionId, configRevision },
  changes: { orca: { type: "stdio", command: "…", env: { ORCA_ROLE_FILE: "…" } } },
  toolPolicy: { preapproved: [{ kind: "mcp", server: "orca", tool: "role-observe" }] } }
```

`toolPolicy` omitted preserves the saved policy; `null` clears it. Both halves are needed
in one call — a preapproval naming a server that the same request does not leave in the
config is refused as `invalid_changes`, before anything is closed. That rule is the
authorization boundary: the refresh cannot widen a policy past the servers it installs,
and `paseo` remains outside the API's authority.

The fence is unchanged. `expected.configRevision` comes from
`agent.mcp.get_refresh_state` and is single-use: a stale revision, a changed admission, a
non-idle agent, a pending permission or an in-flight turn refuses the call. Refusal is the
normal outcome of a racing operator, not an error to retry blindly — re-read the state
first. A refresh resumes the same provider session and asserts the resumed identity, so
the timeline and native session id survive; a provider that resumes anything else fails
the refresh.

## Computer-use app consent for a job

A lead can name apps when it creates a Codex worker:

```json
{
  "provider": "codex",
  "title": "App task",
  "initialPrompt": "Complete the app task.",
  "settings": { "modeId": "full-access" },
  "labels": { "computerUse.allowApps": "[\"VRoid Studio\",\"Simulator\"]" }
}
```

The label is a JSON array of exact app names. It is fixed when the job starts.
It applies only to full-access Codex sessions with `approval_policy=never` and `sandbox_mode=danger-full-access`.
A listed app needs no lead approval. Each automatic accept writes the app name and UTC time to the session timeline.
An unlisted app asks the lead once. The session remembers explicit accepts and declines, including after reload.
Concurrent requests for the same app share that answer. A canceled request can ask again.
Other MCP forms and URLs keep their existing behavior. Restricted sessions and Claude keep their existing behavior.

Codex native approval policy does not answer MCP elicitations. Those requests use a separate protocol path.
This grant covers only the empty app-consent form from the computer-use MCP server.
It does not grant operating-system access or remove operating-system prompts.

## Hub

The Hub authenticates as a service principal. Its locally selected grants decide whether it may execute agents, manage the daemon, manage tunnels, or manage access.

Hub user and role identifiers remain opaque external subjects. The Hub may create and revoke linked daemon principals when granted `access.manage`; the daemon does not interpret accounts, organizations, or roles.

Hub enrollment and permission updates exchange these semantic permissions directly. Legacy persisted Hub relationships that contain `hub.execution.*` migrate once to `hub.execute` when the daemon loads them; new relationships never persist or emit transport scopes as authority.
