# Isolated native inference-record integration

This is a real blockchain integration test with one **synthetic** completion
receipt. It is not a GPU inference test, 240-user Locust result or TPS benchmark.
It exercises core → ain-js → signed transaction → chain rule engine → block/state.
The resulting native operation can also be read by AINSCAN's inference parser.

## Prerequisites

- Linux Docker Engine with permission to create an internal bridge network.
- Node 24 and this core checkout's dependencies (`npm ci --ignore-scripts`).
- A locally available, pinned blockchain image containing the 1-node development
  genesis configuration and the local address-discovery fix from blockchain
  commit `b481da01` on `year3/m1-sharding-protocol`.
- At least 2 available CPU equivalents and 4 GiB memory for the temporary chain.

For the recorded check, the base image was
`sha256:90c46c1e44cb734b915c678b786a2964324b8e47b8e50cfa3e35dd5b5807c747`.
The following minimal image build replaces only `common/network-util.js` with the
fixed blockchain source. Run it with the blockchain checkout as build context:

```sh
docker tag sha256:90c46c1e44cb734b915c678b786a2964324b8e47b8e50cfa3e35dd5b5807c747 ain-inference-chain:base-90c46c1
docker build -f /path/to/ainize-core/scripts/Dockerfile.inference-chain \
  --build-arg BASE_IMAGE=ain-inference-chain:base-90c46c1 \
  -t ain-inference-chain:local-ip /path/to/ain-blockchain
docker image inspect ain-inference-chain:local-ip --format '{{.Id}}'
```

The recorded result used derived image
`sha256:cebf14bf492e5f5e39f3e9ae2681c44c28984e36d45b51b8a8a96f539208cef0`.
An image ID is not a downloadable registry reference. On another machine, load
an archived image (`docker save` / `docker load`) or build the required image
from source and record its new ID. Do not silently replace it with `latest`.

## Run and clean up

From the core repository:

```sh
AIN_TEST_IMAGE=sha256:cebf14bf492e5f5e39f3e9ae2681c44c28984e36d45b51b8a8a96f539208cef0 \
  bash scripts/test-inference-chain.sh /absolute/path/to/new-evidence-directory
```

The script creates an isolated internal Docker network, starts one temporary
chain with CPU=2, memory=4 GiB, memory+swap=4 GiB and a 512-process limit, then
uses its private bridge address. No public ports or external peers are configured.
Only the public development genesis key is used; never fund or reuse it on a
public chain. Transaction signature verification remains enabled. The development
gas-fee workaround is enabled; this test establishes no production fee estimate.

The verifier waits for SERVING and serializes accepted application-setup writes
by waiting for each transaction's successful finalization before returning its
SDK response. This fixture-only gate prevents setup transactions from filling
the development account's free transaction pool; it does not serialize workload
writes, raise pool limits, change production SDK behavior or retry submissions.
It checks the installed rule, submits through `AinLedger.noteInferenceBatch`,
finds the hash in a full block, compares the exact operation and current state,
and requires an attempted overwrite to fail with chain rule error **12103**.
`evidence.json` preserves the block, transaction, rule, synthetic receipt and
rejection response. `docker.json` captures the actual image and resource settings.
`evidence.json.writes.json` records SDK submission response codes and transaction
hashes, including when an assertion fails after setup. It deliberately excludes
request bodies, keys, signatures, raw error messages and transport configuration.
An absent numeric code is unknown, not success; a response hash is not finality.
Transport exceptions without a numeric blockchain code are recorded as `null`.
This diagnostic observes each submission once and never retries writes.
It also retains `setupConfirmations`: actual finalized setup transaction hashes,
block numbers, execution/finalization flags and compact chain receipts. These
include multi-operation `result_list` receipts for validating explorer readers,
without retaining setup request bodies or private keys.

An EXIT/INT/TERM cleanup removes the temporary container and its network, including
after assertion failure or the verifier's 180-second timeout. No EC2 instances,
GPU workers or pre-existing containers are started/stopped by this script.

For a separate integration step while this isolated chain remains alive, set
`AIN_TEST_FOLLOWUP` to an existing absolute local shell-script path. The launcher
passes its output directory as the first argument and exports
`AIN_INFERENCE_TEST_URL`. The follow-up executes only after the chain verification
succeeds; its failure is propagated, then normal chain/network cleanup still runs.
The follow-up is responsible for its own resources and timeout. With this option,
the no-GPU-process guarantee above applies to the core launcher, not arbitrary
code in the explicitly selected follow-up.

## Scope of the recorded evidence

The first successful check included the native record in block 9, and the
AINSCAN source parser accepted its actual operation and calculated the declared
one-request/one-second rate. This number is deliberately synthetic, not measured
inference throughput. Earlier attempts exposed an external-IP startup dependency
and an account transaction-pool startup race; those failures were not counted as
passes. The integration evidence does not establish finality guarantees, a
multi-node deployment, node-generated receipt coverage or public AINSCAN deployment.

The final repeat run included its record in block 11 and also rejected the
overwrite with 12103. Its [chain evidence](../test/evidence/inference-chain-20260914/evidence.json)
and [Docker settings](../test/evidence/inference-chain-20260914/docker.json) are
checked into this repository. Both successful temporary chains and their
networks were confirmed removed after the script exited.
