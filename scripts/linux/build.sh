#!/usr/bin/env bash
set -euo pipefail
project_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$project_root"
builder=theprivator-linux-builder:jammy
container="theprivator-linux-build-$$"
output="$project_root/src-tauri/target/release/bundle/linux"
docker build -t "$builder" scripts/linux
docker create --name "$container" -v "$project_root:/source:ro" "$builder" bash -lc '
  set -euo pipefail
  cd /source
  tar --exclude=target --exclude=binaries --exclude=gen --exclude=__pycache__ \
    -cf - package.json package-lock.json index.html tsconfig.json vite.config.ts vitest.setup.ts \
    requirements.txt requirements-dev.txt src src-tauri public scripts theprivator_sidecar tests \
    README.md CHANGELOG.md LICENSE | tar -xf - -C /work
  cd /work
  uv venv --python 3.12 .venv
  uv pip install --python .venv/bin/python -r requirements.txt -r requirements-dev.txt
  npm ci
  npm run verify:release
  npm run tauri build
  npm run verify:sidecar
  mkdir -p /work/artifacts
  cp src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/rpm/*.rpm /work/artifacts/
  cd /work/artifacts
  sha256sum *.deb *.rpm > SHA256SUMS
'
trap 'docker rm -f "$container" >/dev/null' EXIT
docker start -a "$container"
status=$(docker inspect --format '{{.State.ExitCode}}' "$container")
if [ "$status" != 0 ]; then exit "$status"; fi
mkdir -p "$output"
docker cp "$container:/work/artifacts/." "$output/"
printf 'Linux packages: %s\n' "$output"
