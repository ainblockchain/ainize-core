#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT=${1:?Existing isolated-chain evidence directory required}
cd "$ROOT"
timeout 240 node --import tsx scripts/verify-training-state.ts "$OUTPUT/training-state.json"
