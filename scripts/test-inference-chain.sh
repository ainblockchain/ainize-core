#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${AIN_TEST_IMAGE:?Set AIN_TEST_IMAGE to a locally available pinned blockchain image ID}
OUTPUT=${1:?Usage: test-inference-chain.sh NEW_OUTPUT_DIRECTORY}
[[ "$IMAGE" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'A pinned local image ID is required' >&2; exit 1; }
[[ ! -e "$OUTPUT" ]] || { echo 'Output directory already exists' >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null
mkdir -m 700 -p "$OUTPUT"
OUTPUT=$(cd -- "$OUTPUT" && pwd)
NAME="ain-inference-check-$$-$(date +%s)"
CREATED_NETWORK=false
CREATED_CONTAINER=false
cleanup() {
  if "$CREATED_CONTAINER"; then docker rm -f "$NAME" >/dev/null; fi
  if "$CREATED_NETWORK"; then docker network rm "$NAME" >/dev/null; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker network create --internal "$NAME" >/dev/null
CREATED_NETWORK=true
docker create --name "$NAME" --network "$NAME" --cpus 2 --memory 4g --memory-swap 4g --pids-limit 512 \
  -e BLOCKCHAIN_CONFIGS_DIR=blockchain-configs/1-node \
  -e UNSAFE_PRIVATE_KEY=b22c95ffc4a5c096f7d7d0487ba963ce6ac945bdc91c79b64ce209de289bec96 \
  -e PORT=8081 -e P2P_PORT=5001 -e STAKE=10000000 -e HOSTING_ENV=local -e SYNC_MODE=full \
  -e ENABLE_GAS_FEE_WORKAROUND=true -e ENABLE_TX_SIG_VERIF_WORKAROUND=false \
  -e ENABLE_STATUS_REPORT_TO_TRACKER=false -e ENABLE_EXPRESS_RATE_LIMIT=false \
  -e CONSOLE_LOG=false "$IMAGE" --max-old-space-size=2048 client/index.js >/dev/null
CREATED_CONTAINER=true
docker inspect "$NAME" --format '{"image":"{{.Image}}","cpuNano":{{.HostConfig.NanoCpus}},"memoryBytes":{{.HostConfig.Memory}},"memorySwapBytes":{{.HostConfig.MemorySwap}},"networkMode":"{{.HostConfig.NetworkMode}}"}' > "$OUTPUT/docker.json"
[[ $(docker network inspect "$NAME" --format '{{.Internal}}') == true ]]
docker start "$NAME" >/dev/null
ADDRESS=$(docker inspect "$NAME" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
[[ "$ADDRESS" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
export AIN_INFERENCE_TEST_URL="http://$ADDRESS:8081"
export AIN_INFERENCE_TEST_IMAGE="$IMAGE"
cd "$ROOT"
timeout 180 node --import tsx scripts/verify-inference-chain.ts "$OUTPUT/evidence.json"
if [[ -n "${AIN_TEST_FOLLOWUP:-}" ]]; then
  [[ "$AIN_TEST_FOLLOWUP" = /* && -f "$AIN_TEST_FOLLOWUP" ]] || { echo 'Follow-up must be an existing absolute local script path' >&2; exit 1; }
  bash "$AIN_TEST_FOLLOWUP" "$OUTPUT"
fi
