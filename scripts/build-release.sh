#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
go_cmd=${GO:-go}
mkdir -p dist
for target in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64; do
  target_os=${target%/*}
  target_arch=${target#*/}
  name="relay-${target_os}-${target_arch}"
  directory="dist/${name}"
  mkdir -p "$directory"
  for command in relay relay-coordinator relay-fake-backend; do
    CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" "$go_cmd" build \
      -trimpath -ldflags='-s -w' -o "$directory/$command" "./cmd/$command"
  done
  cp README.md "$directory/README.md"
  cp THIRD_PARTY_NOTICES.md "$directory/THIRD_PARTY_NOTICES.md"
  cp -R docs examples "$directory/"
  mkdir -p "$directory/protocol"
  cp protocol/schema.json "$directory/protocol/"
  tar -czf "dist/${name}.tar.gz" -C dist "$name"
  printf 'Built %s\n' "$name"
done
python3 - <<'PY'
import hashlib, pathlib
root = pathlib.Path('dist')
with (root / 'SHA256SUMS').open('w') as f:
    for p in sorted(root.glob('relay-*.tar.gz')):
        f.write(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n')
PY
