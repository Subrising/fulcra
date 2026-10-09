# Security

Fulcra follows a client-server architecture, similar to Docker. The daemon runs on your machine and manages your coding agents. Clients (the mobile app, CLI, or web interface) connect to the daemon to monitor and control those agents.

Workspaces and agent processes run on the selected host. Connected clients receive the content you view, and provider CLIs may send prompts and code to their configured services. Local-first does not mean provider requests stay offline.

## Architecture

The Fulcra daemon can run anywhere you want to execute agents: your laptop, a Mac Mini, a VPS, or a Docker container. The daemon listens for connections and manages agent lifecycles.

Clients connect to the daemon over WebSocket. There are two ways to establish this connection:

- **Relay connection** — The daemon connects outbound to an existing Fulcra relay by default, and clients meet it there. No open ports required.
- **Direct connection** — The daemon listens on a network address and clients connect directly.

## Relay threat model

Fulcra v0.2 defaults to the retained upstream endpoint `relay.paseo.sh:443`; it is not an owned Fulcra relay service. A local direct owner can configure another endpoint. The relay Worker is unchanged. Hosts connect outbound to it. The relay sees IP addresses, host identifiers, connection timing, frame sizes, public handshake keys and a fresh session challenge. It does not receive private encryption keys or plaintext application messages.

Pairing v3 uses an out-of-band `fulcra://pair#offer=…` link or QR code. The offer pins the host's Curve25519 public key and carries a single-use secret with a ten-minute default expiry. The daemon stores only the secret hash; claiming consumes it before the reply. At most four offers are outstanding. A new app refuses version-2 offers with an update instruction. An old app against a v3 host can still receive a masked relay close and retry without that clear instruction.

Each app installation keeps a long-lived device key. The desktop app keeps it in the Electron main process, wrapped with safeStorage (the app's keychain entry on macOS); an older plaintext copy in renderer storage moves there unchanged on first use and is then deleted, so paired hosts keep admitting the device. iOS, Android and the browser still keep it unencrypted in app storage: anyone who can read that storage can act as the device to every paired host until you revoke it. Don't describe these device keys as OS-protected. Both parties derive session keys from the client ephemeral key, device key, host key, host identifier and a fresh daemon challenge. Separate direction keys and strictly increasing 64-bit counters reject reflection, duplicated frames, counter gaps and captured-session replay. The daemon admits a session only after decrypting a device proof and checking its registry or a valid pairing claim.

A paired device can run code as the host user through terminals and agents, like any local process running as that user. **Revocation, not the permission list, is the containment for paired-device access.** RPC restrictions are not an OS-user sandbox and cannot undo code already executed or persistence a hostile device installed. The local CLI `paseo daemon pair` mints directly under the rule **local user = owner**. Plugin service sessions are excluded from pairing, device-management and relay-endpoint RPCs. Command Centre management remains separately fenced by V1.1b cryptographic authentication evidence; neither a device principal nor unpassworded loopback carries that evidence.

A paired device receives owner permissions except `command-centre.manage` and `access.manage`; it retains `daemon.manage`. A device principal cannot resume the local owner's session. Registry parsing also strips the two excluded permissions. A device principal gets management authentication evidence only on its own relay sockets, and only while this Mac's owner allows Command Centre for that device ([permissions](docs/permissions.md)). New offers and relay endpoint changes require a local direct owner connection.

Revocation immediately denies the device in memory, detaches and closes its sockets, and cleans up its sessions before waiting for registry persistence. Admission checks that in-memory denial across registry instances. Persistence retries for up to one second; a failure keeps the device denied until the daemon stops, and the owner must retry or stop the daemon and revoke offline before restarting. Pairing shows the host name and a 128-bit public-key fingerprint. Malformed offer and handshake errors never echo the raw input. The app refuses a changed host key for a known host identifier; removing the old host and pairing again is an explicit action.

The unchanged relay has no authenticated host-slot token. It can replace a transport slot, drop traffic, delay it or prevent connections; endpoint host-key authentication still prevents impersonation. A leaked unused offer can be claimed by an attacker before its owner uses it. A stolen paired device is a powerful host operator until revoked. App storage is not OS-protected secret storage in this version, and a stolen host private key can expose captured traffic: forward secrecy against host-key theft is not provided. A hostile process running as the daemon's OS user remains inside the local trust boundary.

See [self-hosting and recovery](docs/relay-self-host.md). Identity rotation requires a stopped daemon and unpairs every device.

Relay admission requires the paired-device handshake and its fresh owner grants. A password or anonymous `hello` never substitutes for the device identity.

## Local daemon trust boundary

By default, the daemon binds to `127.0.0.1`. With no password configured, anything that can reach the daemon socket can control the daemon. Loopback is reachable by other users on the machine and by some forwarding tools.

The daemon supports an optional shared-secret password (set via `auth.password` in `config.json` or the `PASEO_PASSWORD` env var; stored bcrypt-hashed). WebSocket clients send the password in `hello`; the daemon sends no session data before admission. Direct connections still accept bearer headers and WebSocket bearer subprotocols for older clients. HTTP stays bearer-header based. Health (`GET /api/health`) and CORS preflight (`OPTIONS`) are exempt; `/api/files/download` and `/mcp/agents` use their own capability tokens.

The daemon writes a new `$PASEO_HOME/local-credential` on every run with mode `0600` and removes it on shutdown. The CLI and desktop main process read it only for the daemon whose PID lock `listen` matches their connection target. A same-user process can read this credential, so the password protects against network clients and other OS users, not processes running as the daemon user. Protect `$PASEO_HOME` accordingly. Relay traffic remains end-to-end encrypted independently of password admission.

Connected clients are trusted operators of the daemon user. File previews follow that authority: a preview request may read any regular file the daemon process can read, while keeping path normalization and symlink checks in the daemon file service. Workspace-relative paths remain a UI convenience, not a security boundary.

When Fulcra checks out a change request from a different repository, it does not run that workspace's `paseo.json` setup, automatic terminals, named scripts, or teardown until you explicitly run setup for that workspace. The decision lasts for the workspace and does not re-prompt after new commits. Same-repository changes, ordinary branches, local workspaces, agent launches, terminals, explicit shell commands, and metadata-generation instructions are outside this gate.

If you expose the daemon beyond loopback, such as by binding to `0.0.0.0`, forwarding it through a tunnel or reverse proxy, or publishing it from a Docker container, you are responsible for restricting and securing that access. Setting a password is strongly recommended in that case.

The included Dockerfile runs the daemon and agents as the non-root
compatibility user `paseo` when you build that image. No official Fulcra registry
image is advertised for this source-only release. Mounted workspaces and
credentials remain available to code run inside the container.

For remote access, use the relay connection. It is the supported path for reaching the daemon off-machine, and it adds end-to-end encryption plus a pairing handshake before commands are accepted.

Host header validation and CORS origin checks are defense-in-depth controls for localhost exposure. They help block DNS rebinding and browser-based attacks, but they do not replace network isolation.

## DNS rebinding protection

CORS is not a complete security boundary. It controls which browser origins can make requests, but does not prevent a malicious website from resolving its domain to your local machine (DNS rebinding).

Fulcra validates the `Host` header on every HTTP request and every WebSocket upgrade against an allowlist (Vite-style semantics). By default, only `localhost`, `*.localhost`, and any literal IP address (IPv4 or IPv6) are accepted. Additional hostnames can be configured via `hostnames` in `config.json` or the `PASEO_HOSTNAMES` env var (comma-separated; entries beginning with `.` match a domain and its subdomains; the value `true` disables the allowlist entirely). Requests with unrecognized hosts are rejected with `403 Host not allowed`.

## HTML file preview

Previewing an `.html` file in the file pane renders it as a page, so markup an agent wrote — or markup that arrived with a repo you cloned — executes when you open it. The preview is built to contain that, not to trust it.

The document loads with an opaque origin and a policy that permits inline script and style and refuses everything else: no remote script, font, image, or media; no `fetch`, XHR, WebSocket, or beacon; no form posts; no plugins; no nested frames. It has no access to Fulcra's DOM, and storage and cookie APIs throw inside it rather than returning anything. It cannot navigate the top window, and it cannot open popups. It cannot read any file but itself.

One gap remains on web and desktop: a sandboxed document may navigate _itself_, and no CSP directive in current browsers prevents that. `navigate-to` was dropped from CSP Level 3 and is not enforced, and `<meta http-equiv="refresh">` needs no script at all. A hostile page can therefore reach a server by navigating away, carrying data available inside the preview, such as its own contents, browser and device properties, user input inside the page, and your IP address. It cannot read Fulcra, another file, storage, or cookies.

Native builds narrow this gap rather than closing it outright. The WebView refuses every navigation after the initial document, but that decision is made in the app's JavaScript, and on Android the WebView falls back to allowing a navigation when the decision doesn't come back in time. Treat it as a strong mitigation, not a guarantee: if the JS thread is stalled at the moment a page navigates, the same leak is possible there too.

If you don't trust a page, read it in `Source`, which executes nothing. Source is available as an editable view on supported web hosts and a read-only view everywhere else.

## Agent authentication

Fulcra uses installed provider CLIs and their authentication. Accounts & Defaults also manages pooled Claude/Codex accounts on the host: Claude credentials are held in Fulcra-owned Keychain items and supplied to the CLI environment; Codex uses account-specific authentication state. Client account-management views are not a credential export. Same-user processes are trusted, and agents execute in the host user context.

**Codex Full Access runs commands without approval prompts. Fulcra cannot pre-check credential access, destructive Git actions or publishing in this mode.** The accepted v0.2.0 native Codex limitation does not waive Claude approvals, host-sync authorization or future-release requirements. See [permissions and trust](README.md#permissions-and-trust).

## Forge host trust

Fulcra only talks to a forge host that is either a known cloud host or one the forge CLI is already authenticated to. It never probes or routes credentials to an unauthenticated, remote-derived host.

## Reporting vulnerabilities

Use the repository [Security tab](https://github.com/Subrising/fulcra/security) and its private vulnerability reporting option when enabled. If that option is unavailable, open a minimal [issue](https://github.com/Subrising/fulcra/issues) asking a maintainer for a private contact route, without disclosing the vulnerability, credentials or personal data. No Fulcra security email is advertised. Do not send fork-specific reports to upstream maintainers unless the issue also affects their project.
