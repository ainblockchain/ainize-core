#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT=${1:?Existing isolated-chain evidence directory required}
SOURCE=${AINSCAN_SOURCE:?Set the AINSCAN checkout path}
BUILD=${AINSCAN_BUILD_DIR:?Set the successful production-build output directory}
IMAGE=${AINSCAN_IMAGE:?Set a pinned local Node 24 Docker image ID}
[[ "$IMAGE" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ -f "$OUTPUT/evidence.json" && -f "$BUILD/.next/BUILD_ID" && -f "$SOURCE/node_modules/next/dist/bin/next" ]]
[[ $(git -C "$SOURCE" rev-parse HEAD) == "$(cat "$BUILD/source-commit.txt")" ]]
[[ ! -s "$BUILD/source-status.txt" && -z $(git -C "$SOURCE" status --porcelain) ]]
node -e 'if (JSON.parse(require("fs").readFileSync(process.argv[1])).exitCode !== 0) process.exit(1)' "$BUILD/result.json"
docker image inspect "$IMAGE" >/dev/null
SOURCE=$(cd "$SOURCE" && pwd)
BUILD=$(cd "$BUILD" && pwd)
OUTPUT=$(cd "$OUTPUT" && pwd)
cd "$ROOT"
bash scripts/verify-training-state.sh "$OUTPUT"
PORT=$(node -e 'const server=require("net").createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close()})')
[[ "$PORT" =~ ^[0-9]+$ ]]
NAME="ain-explorer-records-$$-$(date +%s)"
CREATED=false
cleanup() {
  if "$CREATED"; then
    docker logs "$NAME" > "$OUTPUT/explorer-server.log" 2>&1 || true
    docker rm -f "$NAME" >/dev/null
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker create --name "$NAME" --network host --cpus 1 --memory 1g --memory-swap 1g --pids-limit 256 \
  --user "$(id -u):$(id -g)" -e NEXT_TELEMETRY_DISABLED=1 -e AIN_RPC_URL="${AIN_INFERENCE_TEST_URL:?}/json-rpc" \
  -v "$SOURCE:/work:ro" -v "$BUILD/.next:/work/.next:ro" -w /work --entrypoint node \
  "$IMAGE" node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port "$PORT" >/dev/null
CREATED=true
docker inspect "$NAME" --format '{"image":"{{.Image}}","cpuNano":{{.HostConfig.NanoCpus}},"memoryBytes":{{.HostConfig.Memory}},"memorySwapBytes":{{.HostConfig.MemorySwap}},"network":"{{.HostConfig.NetworkMode}}"}' > "$OUTPUT/explorer-docker.json"
docker start "$NAME" >/dev/null
export AINSCAN_TEST_URL="http://127.0.0.1:$PORT"
export AINSCAN_TEST_BUILD_ID
AINSCAN_TEST_BUILD_ID=$(cat "$BUILD/.next/BUILD_ID")
timeout 180 node --import tsx scripts/verify-explorer-records.ts "$OUTPUT"
