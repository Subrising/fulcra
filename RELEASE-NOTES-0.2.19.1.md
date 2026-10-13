# Fulcra 0.2.19.1

Agent-scoped `create_agent` sends one durable finish notice to its parent through report-up by default.
`daemon.nativeFinishNotices` defaults to `false`. Native wakes for other purposes still work.
Setting `daemon.nativeFinishNotices` to `true` is unsupported in this release.
FU-154 sidebar and projects changes will join this release.
The compatibility core version remains 0.11.2.
