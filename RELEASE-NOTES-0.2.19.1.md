# Fulcra 0.2.19.1

Agent-scoped `create_agent` sends one durable finish notice to its parent through report-up by default.
`daemon.nativeFinishNotices` defaults to `false`. Native wakes for other purposes still work.
Setting `daemon.nativeFinishNotices` to `true` is unsupported in this release.
The sidebar groups Sessions by host and shows each host's session count.
Projects use the lead's label for their sessions. `fulcra project ls` groups projects by label.
The Progress board shows saved projects. Project cleanup checks each saved entry and writes registry backups.
The compatibility core version remains 0.11.2.
