# Production explorer and native-chain record integration

This procedure connects a built AINSCAN server to a fresh isolated blockchain.
It creates one synthetic inference batch and three synthetic lesson records using
core and ain-js, then reads actual Next-rendered pages. No React, Next router,
RPC response or blockchain write is mocked. It is not GPU training, inference
load testing, a 70-job concurrency test or a public website deployment.

## Prepare the explorer build

Use clean AINSCAN source with installed dependencies and its existing constrained
production-build wrapper. Set a local pinned Node 24 image ID:

```sh
cd /path/to/ainscan
AINSCAN_BUILD_IMAGE=sha256:52e634617c0fad0207eeba4262ecdf142fc886649253ac42e4730ce75bd04dd5 \
  bash scripts/verify-production-build.sh /absolute/path/to/new-build-directory
```

Image IDs identify locally available images, not downloadable registry references.
On another machine build/load the required images and supply their actual IDs.
The follow-up refuses a failed build, dirty build source, or a checkout whose
commit differs from the build's recorded source commit.

## Run from ainize-core

Node 24, installed core dependencies and Docker access are required. Set absolute
paths and choose a new evidence directory:

```sh
export AINSCAN_SOURCE=/absolute/path/to/ainscan
export AINSCAN_BUILD_DIR=/absolute/path/to/new-build-directory
export AINSCAN_IMAGE=sha256:52e634617c0fad0207eeba4262ecdf142fc886649253ac42e4730ce75bd04dd5
export AIN_TEST_IMAGE=sha256:eddd95425bbec1c97bfb6f06371ce22a9a146fee936c90f54f17fe04dd1aa955
export AIN_TEST_FOLLOWUP="$PWD/scripts/verify-explorer-records.sh"
bash scripts/test-inference-chain.sh /absolute/path/to/new-evidence-directory
```

The blockchain image contains the isolated local-address and block-read fixes
described in `inference-chain-reproduction.md` and the blockchain repository's
`docs/rpc-block-read-safety.md`. The public development genesis key is used only
inside the fresh private chain; never reuse or fund it on a public network.

## Checks and artifacts

- The existing chain integration verifies the inference rule, included batch and
  duplicate-write rejection. The training-state step records three finalized,
  successful native lesson writes, including their full blocks.
- The production explorer runs in a temporary Docker container with CPU=1,
  memory=1 GiB and no additional swap. It uses host networking to reach the private
  chain bridge but binds its HTTP server only to `127.0.0.1` on a temporary port.
  The chain retains CPU=2, memory=4 GiB and its internal Docker network.
- The explorer proxy's genesis hash must match a direct full-genesis read from
  the same private chain. No hash-only genesis reads are used.
- Knowledge, Recent Transactions, the containing block and transaction detail
  must respond HTTP 200 with their expected native fields. Assertions remove
  script elements first, so values hidden only in a serialized React payload do
  not count as rendered fields. Transaction detail must display Succeeded,
  Finalized and the exact reported-submission-to-block latency.
- `explorer-records.json` identifies the build, genesis, hashes, expected fields
  and checked routes. `explorer-*.html` preserves complete rendered responses;
  `explorer-docker.json` and `explorer-server.log` capture the temporary server.

The follow-up has a 180-second verifier timeout. EXIT/INT/TERM cleanup removes
its own explorer container; the parent launcher removes its own blockchain
container and network even if the follow-up fails. Existing services, cloud
instances and public deployments are not modified. This is HTTP/SSR integration,
not a browser auto-refresh test or an end-to-end performance measurement.

## Recorded result, 2026-09-14

AINSCAN source `5471d37`, production build `0rYJk5jvtMTuxrGwM5YoF`, passed all
four route checks against the real temporary chain. Training transaction
`0x15b69d9d9422ae7f910ec647340342dee00314f1ab22d0101fd6730db4bc06d2`
appeared in block 22; its displayed **317 ms** matched the recorded submission
timestamp and containing block timestamp. Its status displayed Succeeded and
Finalized. Inference transaction
`0x8017f18a41967adf6c08a771ed1d1e6e9656783a7a925d25217469f5460d59f6`
appeared in block 18 and in the ordinary transaction list and Knowledge view.
Artifacts are retained in `test/evidence/explorer-native-records-20260914/`.
The HTML references build assets; it preserves server output, not a self-contained
styled screenshot. Full chain blocks and native values are retained separately.

An initial attempt failed during application setup with chain code **10716**:
the development account's free transaction pool was full. A second attempt
exposed a verifier assumption that finalized multi-operation receipts always
have a top-level code; the chain instead supplies per-operation `result_list`
codes. The final run waits for successful setup-write finalization and checks
those codes. It does not increase pool limits or retry rejected/uncertain writes.
This explains these recorded attempts, not every previously observed failure.

The latest production build passed with the existing Browserslist and
KnowledgeGraph hook warnings. Shell syntax and the explorer verifier's TypeScript
check passed. All temporary explorer/chain containers and networks were removed.
The core suite also passed 80 tests with 1 skipped and 0 failures.
The 317 ms value describes one synthetic lesson record, not the required average
of 70 real training jobs and not a performance-target pass.
