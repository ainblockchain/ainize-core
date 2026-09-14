# Native write acknowledgement verification

## Change

Lesson and inference writers previously accepted a missing SDK response as
`{ path, tx_hash: '' }`. Multi-operation failures after the first entry could also
pass when the top-level result had no error code. Such acknowledgements cannot
identify a successful transaction for AINSCAN. Core now requires a valid hash,
numeric success codes and successful entries throughout bounded result lists.
These are submission checks, not claims of finality. Uncertain writes remain
`null` and are not retried automatically.

## Validation on 2026-09-14

- The new regression test failed against the old implementation: an undefined
  SDK response produced an empty-hash lesson acknowledgement instead of `null`.
- With the fix, `npm test` passed 80 tests, skipped 1 and failed 0.
  `npm run typecheck` also passed. Cases cover both lesson and inference writes,
  malformed hashes, missing codes, nested/later failures, bounded result lists,
  and valid single/multi-operation acknowledgements.
- The isolated chain launcher passed with pinned image
  `sha256:eddd95425bbec1c97bfb6f06371ce22a9a146fee936c90f54f17fe04dd1aa955`.
  It used 2 CPU equivalents, 4 GiB RAM, no extra swap and an internal network;
  its temporary container and network were removed. Existing services were not
  restarted. See `test/evidence/write-acknowledgement-20260914/docker.json`.
- `chain.json` contains the actual synthetic-receipt write, full block 9 and
  transaction `0xb966241731995759b58b0121dab4176f3fe02835ec6c34b385c088bd1bf4cb23`.
  Its execution code is 0 and finalization flag is true. A duplicate write was
  rejected with rule code 12103. `writes.json` preserves submission diagnostics.
- AINSCAN main `c901412`'s `inferenceOverview` and `transactionExecution` parsed
  that block's operation and transaction: one model, one request, no skipped
  record, matching path/root, Succeeded and Finalized. Output is in `ainscan.json`.
  This is parser integration, not a public website deployment test.

## Reproduce

```sh
npm test
npm run typecheck
AIN_TEST_IMAGE=sha256:eddd95425bbec1c97bfb6f06371ce22a9a146fee936c90f54f17fe04dd1aa955 \
  bash scripts/test-inference-chain.sh /absolute/path/to/new-output-directory
```

The image must already exist locally; the ID is not a registry download name.
The RPC-read-safety image build is documented in the blockchain repository's
`docs/rpc-block-read-safety.md`. Node 24 and installed dependencies are required.

Earlier isolated runs returned an unacknowledged inference submission. Two
subsequent runs succeeded, including the strict-validator run above; the earlier
failures' cause remains unproven. The new code/hash diagnostics help distinguish
future failures without retaining credentials or retrying an uncertain write.
The empty-hash bug is separately reproduced, not asserted as their cause.

The synthetic one-request interval is not measured GPU throughput. This does not
prove 70 simultaneous training jobs, 7,000 blockchain TPS, the 240-user/60-worker
inference target, 100 dataset/model pipelines, or public deployment/publication.
