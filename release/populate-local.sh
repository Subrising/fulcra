#!/bin/sh
set -eu
snapshot=${1:?Usage: release/populate-local.sh /path/to/private/local-snapshot}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ -d "$snapshot/config" ] || { printf '%s\n' 'Snapshot must contain a config directory.' >&2; exit 1; }
umask 077
mkdir -p "$root/local"
for name in machine-values.json host-probes.json activation-releases.json admission-base.json permission-base.json dependency-sides.json components.json native-sources.json personal-patterns.json; do
    [ -f "$snapshot/config/$name" ] || { printf 'Missing snapshot configuration: %s\n' "$name" >&2; exit 1; }
    [ ! -e "$root/local/$name" ] || { printf 'Refusing to overwrite existing local/%s\n' "$name" >&2; exit 1; }
done
for name in machine-values.json host-probes.json activation-releases.json admission-base.json permission-base.json dependency-sides.json components.json native-sources.json personal-patterns.json; do
    cp "$snapshot/config/$name" "$root/local/$name"
    chmod 600 "$root/local/$name"
done
printf '%s\n' 'Private local configuration restored. No service was changed.'
