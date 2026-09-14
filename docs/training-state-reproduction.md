# Native training-state integration

This test uses the isolated-chain bootstrap from
[inference-chain reproduction](inference-chain-reproduction.md), then calls the
real `AinLedger.noteLesson` adapter for three synthetic lesson records. The adapter
uses ain-js to submit signed transactions. It does not run training or inference,
contact public chains, modify existing nodes, or prove concurrent pipelines.

With the documented pinned blockchain image available locally and dependencies
installed, run from this repository using Node 24:

```sh
AIN_TEST_IMAGE=sha256:cebf14bf492e5f5e39f3e9ae2681c44c28984e36d45b51b8a8a96f539208cef0 \
AIN_TEST_FOLLOWUP="$PWD/scripts/verify-training-state.sh" \
bash scripts/test-inference-chain.sh /absolute/path/to/new-evidence
```

The bootstrap creates an internal Docker network and an isolated chain container
limited to two CPUs and four GiB memory, with no extra swap and no published ports.
It first verifies an inference batch and installs native market rules. The follow-up
then submits each lesson once, waits for executed/finalized status and receipt code
zero, checks the full containing block and reads publisher discovery plus lesson
state. It has a 240-second process limit; the outer bootstrap removes its container
and network on success or failure. The public development genesis identity must
not be used for a real network. No npm release or deployment is performed.

The actual 2026-09-14 run is retained in
[`test/evidence/training-state-20260914`](../test/evidence/training-state-20260914).
Its three lesson transactions were included in blocks 13, 16 and 19 with successful
finalized execution. Publisher discovery returned the native `#state_ph` shallow
shape. The full state was also passed through AINSCAN's `trainingOverview` parser:
three lessons, two distinct dataset IDs, two distinct model IDs and two current
`TRAINING` labels, with no skipped records or truncation. These are synthetic
state values, not evidence of two active training processes or model support.

`training-state.json` retains transaction responses, full containing blocks,
publisher discovery and state. `docker.json` records the actual image and resource
limits. The temporary chain was removed; its hashes cannot be found in a public
explorer connected to a different chain. AINSCAN's current publisher view is
`/knowledge?publisher=<node-address>#training-records`, with no experiment API.
