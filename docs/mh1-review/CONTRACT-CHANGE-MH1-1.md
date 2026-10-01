# MH1: daemon freshness for handshake v3

Design §4.2B binds keys to a client ephemeral key and device key but no daemon-generated freshness. A hostile relay can replay a captured hello and then its encrypted application frames into a new socket; the daemon derives the same keys and resets receive counters. Per-connection counters alone do not stop this.

Proposed strengthening: daemon `e2ee_ready` v3 includes a new 32-byte random base64 `challenge`. Both sides append those bytes to the root KDF input after the serverId. Client hello remains as specified. The client must wait for ready before encrypting its first frame. Each daemon channel uses a new challenge. Duplicate hello only re-sends the same ready within that socket. This changes no authority or persisted schema.

Implementation and acceptance must include captured-hello/session replay, in addition to duplicate-frame replay. No live protocol compatibility is promised for v2.
