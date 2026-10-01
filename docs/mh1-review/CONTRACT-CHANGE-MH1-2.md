# MH1: integration and recovery deviations

The implementation requires narrow supporting edits outside the literal §9.2 hunk list:

- `daemon-client.ts` connection options and relay factory forward the persistent device key pair; new RPC methods alone cannot authenticate reconnects.
- `websocket-server.ts` dispatches device-management and endpoint RPCs because it owns socket identity, local-peer checks and synchronous detachment. Daemon-session-only handlers cannot implement that boundary safely.
- Generated outbound validators include the new RPC response schemas.
- Existing app test configuration has a clipboard stub and missing SVG exports added for isolated Chromium evidence. Tests never read the system clipboard.
- Following the scope change, the relay package and infrastructure references are restored to baseline. Endpoint v3 crypto is now shared from `packages/client/src/relay-v3`; it requires no Worker changes. No desktop package, settings screen, sidebar or background-work changes.

`paseo daemon relay rotate` is deliberately stopped-daemon-only. It refuses a running daemon rather than rotating files underneath in-memory keys and transport state. Stopping first closes sockets; rotation clears offers/devices and changes host keys/server ID; restart then reconnects under the new identity. This conservative recovery workflow differs from the design's implied online rotation and needs acceptance in adversarial review.

The app's persisted `deviceId` is optional only to read legacy records. Every new successful v3 pairing persists it; old records cannot acquire anonymous relay access.

No new RPC or permission was invented for these integration decisions. The wire-freshness addition is recorded separately in CONTRACT-CHANGE-MH1-1.md.

The unchanged relay masks endpoint close codes. An encrypted, sequenced `fulcra.channel.closed` message carries terminal device-unpair status before socket closure. This is an endpoint-only addition; review its delivery and retry behaviour against the unchanged Worker.
