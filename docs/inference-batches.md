# Native inference batch records

`AinLedger.noteInferenceBatch(batch)` submits a node-signed ain-js write to
`/apps/knowledge/market/inference_batches/<node-address>/<batch-id>`.
This optional ledger method is not an HTTP experiment endpoint. Local ledgers
do not fabricate chain receipts.

Version 1 accepts exactly these fields:

| Field | Meaning |
| --- | --- |
| `version` | `1` |
| `model_id` | Reported serving model identifier, at most 512 characters |
| `request_count` | Positive safe integer count of completed inference requests, not tokens |
| `started_at` | Positive Unix epoch milliseconds at the start of the observation interval |
| `finished_at` | End of that interval, strictly after the start and within the JavaScript date range |
| `receipt_root` | Lowercase 64-character SHA-256 commitment supplied by the producer |

The writer adds `node`. The batch ID is SHA-256 of `canonicalJson` of this complete
value. Identical values have identical paths. The market rule permits only the
path owner to create a previously absent record with matching `node`; it does not
verify the reported count, clock, root, model identity or inference quality.
Existing chains need an authorized administrator to apply and verify this rule.

The SDK validates the payload before submission, rejecting extra fields such as
prompts and answers. The onchain rule is not a schema validator; other clients can
still submit malformed payloads. Readers must validate records independently.

The return value `{ path, tx_hash }` acknowledges submission, not block inclusion
or finality. A failed chain call returns `null`, which can also represent an
uncertain network outcome. Inspect the transaction and path before retrying; the
write-once rule rejects a second accepted write to the same path.

Submission acknowledgement requires a 32-byte hexadecimal transaction hash and
numeric success code `0`. Multi-operation results must contain a nonempty result
list with successful entries throughout (at most 1,000 inspected result objects).
Missing/malformed responses and failed later operations are not acknowledged as
successful writes. This validation also applies to native lesson records; it does
not replace AINSCAN's independent block inclusion and execution checks.

Reported requests per second is `request_count * 1000 / (finished_at - started_at)`.
It is not onchain TPS. Do not sum rates from overlapping intervals or equate server
completion with a client having received the entire stream. A commitment alone
does not prove receipt coverage: producers must supply a documented receipt
format, commitment algorithm and independently verifiable evidence. This SDK
primitive does not yet implement automatic node receipt collection or reconciliation.

Validation: `node --test --import tsx test/inference-record.test.ts` uses a fake
chain writer and evaluates rule expressions. It does not prove live-chain
installation, real inference throughput or marketplace deployment.
