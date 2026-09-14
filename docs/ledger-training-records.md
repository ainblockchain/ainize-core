# Native training record authorization

`AinLedger.noteLesson(jobId, value)` writes `/apps/knowledge/market/lessons/<node-address>/<job-id>` using the node's signed ain-js transaction. The writer supplies its own `node`, `job` and `updated_at` fields after the caller's value, so those fields cannot be overridden by a lesson payload.

The market setup/verification table now explicitly includes the lesson path. Its write rule requires the transaction signer to equal the path's node address, an object value, and `node`/`job` metadata matching the path. The same node may update the job as its state changes; another node cannot claim or replace that job. Job IDs must be single path segments of 1–128 ASCII letters, digits, underscores or hyphens. Invalid IDs fail before a chain request.

Earlier builds exposed `noteLesson` but omitted this path from the expected rule table. Actual behavior on those chains depends on inherited or manually installed rules; do not assume those chains already enforced this boundary. Existing chains require the authorized application administrator to apply and verify the updated market rules. Deploying the npm package alone does not prove the chain rules changed.

The rule authenticates the reporter, not the truth of training results or timestamps. AINSCAN should show them as reported native fields. Inclusion, dataset matching and submission-to-block latency must still be checked against the actual transaction/block. The local ledger does not fabricate AIN transactions.

Unit tests: `node --test --import tsx test/lesson-rules.test.ts`. These evaluate the rule expression and path validation; real-chain installation and rule-engine integration require separate verification.
