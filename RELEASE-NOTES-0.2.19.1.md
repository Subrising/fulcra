# Fulcra 0.2.19.1

Agent-scoped `create_agent` sends one finish notice to its parent.
Claude parents use the ordinary notice route because they cannot accept native queued notices.
The ordinary route also handles a known native wake refusal.
The compatibility core version remains 0.11.2.
