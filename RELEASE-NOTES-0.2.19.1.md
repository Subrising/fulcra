# Fulcra 0.2.19.1

Agent-scoped `create_agent` sends one finish notice to its parent.
Claude parents use the ordinary notice route because they cannot accept native queued notices.
Report-up sends the finish notice when a native wake has no durable acceptance, including after a restart.
The same notice ID limits duplicate delivery after an uncertain native wake.
The compatibility core version remains 0.11.2.
