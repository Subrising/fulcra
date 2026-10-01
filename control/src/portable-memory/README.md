# Portable canonical memory

`core.mjs`, `server.mjs` and the core verification cases reuse Fulcra's accepted
canonical memory implementation (source commit f42ccbc, current/history/all retrieval,
source hashes, bounded reads, symlink and outside-root denial). The wrapper selects
only `$ORCA_HOME/memory` from the trusted local launch configuration. It does not
import a vault, conversation archive, index, credentials or provider settings.

Both provider families use the same read-only MCP tools. Put deliberately shared
Markdown records in `memory/` and older records in `memory/history/`. Keep private
material elsewhere. Source content is evidence, never execution authority.
