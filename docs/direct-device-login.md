# Device-key login on direct connections (design, not built)

Status: design note for after 0.2.9. Nothing here is built. Build it as a Paseo core change in the `pairing` ledger patch, and give it the one fresh security review.

## Why

A paired device reaches Command Centre over the relay with its own device key, while the owner's "Allow Command Centre" grant stands ([permissions](permissions.md)). A direct connection (local network or a Tailscale address) still signs in only with the host password (`websocket-server.ts`, password by subprotocol or `Authorization` header). The paired-device login exists only on relay sockets (`pairing/relay-device-gate.ts`).

So a phone or a second Mac that wants the direct path needs the shared host password. One leaked copy gives full owner access, and you cannot revoke it for one device. On 9 Oct 2026 the MacBook app reached the Mac mini this way.

## Design

1. A direct socket may open with the same device handshake the relay uses: the relay v3 client channel, with the device key, the host key and a fresh daemon challenge. The daemon admits it through `RelayDeviceGate.admit`, as for the relay, and applies the same fresh grant checks as `relayAdmissionAllowed`. The device gets its own principal (`device:<id>`), never the owner's.
2. A direct device socket never accepts a pairing claim. Pairing stays on the offer flow.
3. The host password stays for the owner's own clients on the same computer and for recovery. The app stops asking for it when it has a device key for that host and the host supports device login.
4. Protocol: add `server_info.features.directDeviceLogin`. A new app uses device login only when the host says so; an old host keeps the password path. Old apps are not affected. Tag the app fallback `COMPAT(directDeviceLogin)` ([protocol compatibility](protocol-compatibility.md)).
5. Revoking the device, or turning its grant off, closes its direct sockets too, as it does relay sockets.

## Risks

- The direct listener is reachable on the network. Keep the existing host and origin checks, and rate-limit failed device proofs as the relay gate limits claims.
- Device keys on iOS, Android and the browser are not OS-protected ([SECURITY.md](../SECURITY.md)). A stolen device key works on the direct path too, until you revoke it. This is no wider than the relay path today.

## Acceptance

| #   | Check                                                       | Pass means                                                        |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| D1  | Direct socket with the device key, grant on                 | Command Centre works, as that device; no host password entered    |
| D2  | Direct socket with the device key, grant off                | Sessions and chat work; Command Centre is refused with the reason |
| D3  | Revoke the device while a direct socket is open             | The socket closes; the next login is refused                      |
| D4  | A pairing claim on a direct socket                          | Refused                                                           |
| D5  | Old app against a new host, and new app against an old host | Both keep working with the password path                          |
| D6  | Search the app storage of a phone paired this way           | No host password                                                  |
