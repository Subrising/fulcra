# Integrations sign-in and the shared credential store

The host keeps one set of tracker and forge accounts: GitHub, Jira Cloud, Jira Data Center,
Bitbucket Cloud and Bitbucket Data Center. The user signs in once in **Settings › Integrations**;
plugins read accounts through `server.credentials` ([plugins.md](plugins.md#use-a-connected-account))
and the GitHub PR panels use the same accounts. Code lives in
`packages/server/src/server/integrations/`.

## Where things are stored

| What                      | Where                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Account metadata          | `$PASEO_HOME/integrations/accounts.json`, private file mode. Never a secret.                   |
| Access and refresh tokens | OS credential store, service `ai.fulcra.credentials`, account `<account id>`, one JSON item    |
| OAuth client ids          | `config.json` → `integrations.oauthClientIds`, e.g. `{ "github": "Iv1.…" }`. Empty by default. |
| Sign-in flows in progress | Daemon memory only, ten minutes at most                                                        |

Per platform:

| Platform | Store                                  | Tool                                                                        | Status                                      |
| -------- | -------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| macOS    | login keychain, generic password       | `/usr/bin/osascript` running a Security-framework helper; request on stdin  | Tested on device (8 KB secret round-trip)   |
| Linux    | Secret Service (libsecret)             | `secret-tool`; `store` reads the secret from stdin                          | Unit-tested with a fake; untested on device |
| Windows  | Credential Manager, generic credential | `powershell.exe` calling `CredRead`/`CredWrite`; target and secret on stdin | Unit-tested with a fake; untested on device |

Secrets never go in argv: other local users can read the process table. On macOS the helper is a
short JavaScript-for-Automation script calling `SecItemCopyMatching`/`SecItemUpdate`/`SecItemAdd`/
`SecItemDelete`; it replaced `security -i`, whose command line could not hold an access token plus a
refresh token of a few kilobytes. Items it creates trust it as their reader, so no keychain prompt
appears. Legacy `ai.fulcra.plugin.*` items were created by `/usr/bin/security`, so the one-time
import reads them with that tool and never writes them. A delete counts only when a read afterwards
finds nothing; on Windows only `ERROR_NOT_FOUND` means "absent", so an access or service error is
never mistaken for a missing item. A host without one of these
stores has no credential store; `server_info.features.credentials` is then false. Mobile apps never
store tracker secrets; they read through the host.

## Sign-in methods

Each connector lists its methods in preference order. **Token always works.** A method that needs
an OAuth client id is hidden until `integrations.oauthClientIds` names one, and a method that needs
a client secret is marked `needs-broker` and never offered: a desktop app cannot keep a secret, and
the app ships none.

| Method    | How it works                                                                                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`   | Paste a personal access token or API token. The host checks it against the provider before saving.                                                                                                              |
| `device`  | OAuth device flow: the host shows a code, the user enters it on the provider's page, the app polls `credentials.complete`.                                                                                      |
| `browser` | OAuth authorization code with PKCE (S256). The redirect is `fulcra://oauth/<flowId>` (the app forwards it) or `http://127.0.0.1:<port>/oauth/<flowId>` on desktop.                                              |
| `cli`     | The existing `gh` login. The forge layer uses it directly. `credentials.list` also shows each signed-in host as a `cli` account named by its login, so the app knows who you are; see `host-github-sign-in.ts`. |

### Provider findings

Checked 2026-09-24 against the providers' own documentation.

| Connector             | Method        | Works without a client secret?                                                                                                                         | Source                                                                                                                                                                                                                                                    |
| --------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub                | device        | **Yes.** The token request takes the client id only; refresh of a device-flow token also needs no secret. The OAuth app must have device flow enabled. | [Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Best practices for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app) |
| GitHub                | browser       | **No** → `needs-broker`. PKCE is supported, but the code exchange still requires `client_secret`.                                                      | [Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)                                                                                                                                           |
| GitHub                | token         | Yes (personal access token, Bearer).                                                                                                                   | [Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)                                                                                                                                           |
| Jira Cloud            | browser (3LO) | **No** → `needs-broker`. The code exchange and every refresh require `client_secret`; PKCE is not documented.                                          | [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)                                                                                                                                                             |
| Jira Cloud            | token         | Yes. Account email + API token over HTTP Basic. New API tokens expire after at most one year.                                                          | [Manage API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)                                                                                                                                   |
| Jira Data Center      | token         | Yes. Personal access token as a Bearer header.                                                                                                         | [Using personal access tokens](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)                                                                                                                                  |
| Bitbucket Cloud       | browser       | **No** → `needs-broker`. The code exchange authenticates as `client_id:secret`; implicit grant is no longer supported.                                 | [Bitbucket OAuth 2.0](https://developer.atlassian.com/cloud/bitbucket/oauth-2/)                                                                                                                                                                           |
| Bitbucket Cloud       | token         | Yes. Atlassian account email + Bitbucket API token over HTTP Basic.                                                                                    | [Using API tokens](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/)                                                                                                                                                                  |
| Bitbucket Data Center | token         | Yes. Project and repository tokens as Bearer; personal tokens as HTTP Basic with the username, which the form accepts as an optional field.            | [HTTP access tokens](https://confluence.atlassian.com/bitbucketserver/http-access-tokens-939515499.html)                                                                                                                                                  |

So v1 offers GitHub device sign-in once a public client id is configured, and token sign-in for
every connector. Browser sign-in for Jira Cloud and Bitbucket Cloud (and GitHub) waits for a hosted
token broker that holds the client secret; that is a product decision, and the flow machinery is
ready for it. GitHub's own guidance is to enable device flow only when needed, because an attacker
can start a device flow with a public client id for phishing.

## Callback validation

A browser sign-in finishes only when the callback:

- is exactly the redirect the host issued: scheme, host, port and path `/oauth/<flowId>` must match;
- carries the `state` issued for that flow (compared in constant time);
- arrives within ten minutes, once. The flow is consumed before the code exchange, so a replayed
  callback cannot trigger a second exchange. A callback with the wrong state or path ends the flow.

The code exchange sends the PKCE verifier and no secret. The loopback listener binds `127.0.0.1`
on an ephemeral port for one flow, answers only `GET /oauth/<uuid>`, echoes nothing from the request,
and closes when the flow ends. Token checks call the provider with `redirect: "error"`, so a
redirect cannot carry a token to another host; a site is a bare host name and is always reached
over https.

## Disconnect and the account lifecycle

Mutations of one account run one at a time, and every account has a generation number.

- **Disconnect is final.** It first marks the account `revoked`, which stops all use by plugins and
  the forge layer and cancels any reconnect in progress, then deletes the secret. Metadata goes only
  after the OS store confirms the deletion. If it cannot, the call fails with "Couldn't remove this
  account from the system keychain; retry Disconnect" and the `revoked` row stays so the user can
  retry.
- **Nothing resurrects it.** A refresh or reconnect that started before Disconnect checks the
  generation before it writes, and drops its result.
- **One refresh at a time.** Concurrent users of an expiring account share one refresh, so a
  rotating refresh token is never spent twice.
- **Each sign-in flow completes at most once.** A second completion or device poll while one is in
  flight is refused, a result that lands after the flow expired or was cancelled is discarded, and
  flows still starting count against the limit of 16. An expiry timer ends an abandoned flow and
  closes its loopback port.

## Refresh and expiry

A device-flow GitHub token with a refresh token is refreshed automatically a minute before it
expires. When refresh fails, or the stored secret is missing, the account becomes `needs-reconnect`
and callers get "reconnect this account in Settings › Integrations". `credentials.reconnect(id)`
starts a new flow that replaces the secret but keeps the account id, so plugin references survive.

## Forge layer

`github-service.ts` asks the credential store for a connected github.com account before each `gh`
call and passes its token as `GH_TOKEN`. If GitHub refuses that token, the call is retried with the
CLI's own login. With no account, nothing changes. The PR panels still need the `gh` binary; GitHub
Enterprise hosts keep using the CLI login.

## Moving a token from plugin secrets

A plugin that stored a tracker token with `security add-generic-password` under
`ai.fulcra.plugin.<runtime id>` calls `server.credentials.importLegacy({ secretName, connector, site?,
email? })` once. The host reads only the calling plugin's namespace, needs the connector in
`requirements.credentials`, copies the token into a new account and records the import, so a
second call returns the same account. The old item is never changed or deleted. After
the user disconnects an imported account, the import is refused rather than repeated: the user
signs in again instead.

## Plugin access

Plugins never receive a secret (CONTRACTS §7.2 v1.7). `server.credentials.request(accountId,
connector, { method, path, query?, headers?, body? })` asks the daemon to call the account's provider
API: `api.github.com`, `https://<site>/rest/api/…` for Jira (plus `/rest/dev-status/…` and
`/rest/agile/1.0/…` for GET only), `api.bitbucket.org/2.0/…` or the
Bitbucket Data Center site's `/rest/…`. The daemon attaches the credential, refuses
plugin-supplied `Authorization`, `Cookie` and other non-allow-listed headers, follows redirects only
within that API, and replaces every form of the secret (token, header value, Basic credential,
URL- and JSON-escaped) in the answer with `[redacted]`. Non-GET methods need
`requirements.credentialsWrite`; each account allows 120 requests a minute.
[plugins.md](plugins.md#use-a-connected-account) owns the author contract.

## Host API

All RPCs are gated on `server_info.features.credentials` and need `daemon.manage`. None returns a
secret. Account management belongs to the app and the operator: from a plugin's own session the
daemon allows only `credentials.list`, filtered to the connectors the plugin's manifest declares.

| RPC                     | Purpose                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `credentials.list`      | Accounts plus a provider summary: methods with `available` / `unavailable` / `needs-broker`, token help.              |
| `credentials.begin`     | Starts a flow: `{ connector, method, site?, redirect? }` → `{ flowId, userCode?, verifyUrl?, authUrl? }`.             |
| `credentials.complete`  | Finishes a flow with `{ kind: "token" }`, `{ kind: "poll" }` or `{ kind: "callback", url }` → pending or the account. |
| `credentials.reconnect` | Starts a flow that replaces an account's secret.                                                                      |
| `credentials.remove`    | Deletes the secret, then the account.                                                                                 |

`PaseoApi.credentials` wraps these for app screens and plugins.
