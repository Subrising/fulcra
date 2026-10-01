# Choosing a relay for Fulcra

Fulcra v0.2 uses the existing Paseo relay at `relay.paseo.sh:443`. Hosts connect outbound; a tailnet and a new inbound host port are not required. The release worker owns switching on the live relay connection. This guide does not authorise deployment or changes to a running host.

## Pointing at another relay later

An operator can run a compatible relay in their own environment and change the endpoint from a local direct owner connection. The pairing panel on the host has a Relay address field. For configuration managed outside the app:

```json
{ "daemon": { "relay": { "enabled": true, "endpoint": "relay.example.com:443", "useTls": true } } }
```

`PASEO_RELAY_ENDPOINT` and `PASEO_RELAY_USE_TLS` override the saved settings. Launch overrides are read-only in the pairing panel. `--no-relay` remains the kill switch. Clearing the address override returns to the existing Paseo endpoint. A phone or hub connection cannot change a host's relay address. Keep direct daemon listeners on loopback unless separately configured for another purpose.

Public endpoints require TLS. Plaintext WebSockets are supported only for loopback, private addresses and `.local`, to allow isolated development. A self-hosted relay must forward both directions and preserve WebSocket text/binary framing. Pairing v3, device admission, fresh challenges and sequence counters run in the daemon and app; they require no Worker changes.

The `packages/relay` code, account, route, cut-over proxy and workflow are unchanged for v0.2. Do not deploy that inherited configuration into somebody else's account. A later hosting task must choose its own account, routes and deployment controls. No Fulcra deploy script or host-slot token is included here.

## Pairing and recovery

Pair new devices from this Mac. Compare the displayed host name and short public-key fingerprint before pairing. Offers last ten minutes by default and can be claimed once. The `fulcra://pair#offer=…` link stays out of a hosted web page. Do not put it in logs, telemetry or support messages. Malformed input errors are fixed messages that do not echo the input.

A device receives owner permissions minus access management and Command Centre management. `paseo daemon devices list` shows paired devices; `paseo daemon devices revoke <id>` removes one and closes its live sockets. Removing an online host from the app also unpairs that device. A changed host key is refused until the old host is explicitly removed and paired again.

For compromised host keys, stop the daemon, run `paseo daemon relay rotate`, then restart and pair each device again. The command refuses a running daemon. Rotation changes the host key and identifier and clears outstanding offers and device records. There is no relay-side credential to rotate.

Pairing locks record a unique owner PID. A confirmed dead owner is recovered automatically; a live owner is never displaced. Missing or malformed owner records fail closed and require inspection with the daemon and local pairing commands stopped. Revocation closes sockets and denies reconnect immediately, then retries persistence for up to one second. If persistence fails, retry online or stop the daemon and run `paseo daemon devices revoke <id> --offline --home <local-home>` before restarting. Keep the daemon stopped during offline edits. Corrupt stores fail closed.

## What the relay can see

The relay sees IP addresses, host identifiers, public handshake keys, timing and frame sizes. It cannot read application contents or device private keys. It can deny service or replace a host transport slot, because the unchanged relay has no host-slot authentication; host-key authentication prevents such replacement from impersonating the host. The encrypted endpoints carry device revocation status because the existing relay masks endpoint WebSocket close reasons.

A copied unused offer can be claimed by whoever uses it first. A stolen app key has that device's authority until revoked. App storage is deliberate in v0.2. There is no forward secrecy against theft of the host private key. Complete adversarial review and integrated acceptance before release.

A paired device can run code as the host user. Revocation is the containment for device access; the RPC permission list is not a sandbox against same-user code and cannot undo already-executed code. Local CLI pairing uses the rule **local user = owner**. Plugin service sessions cannot call pairing, device-management or relay-endpoint RPCs. Command Centre management additionally requires V1.1b authentication evidence.
