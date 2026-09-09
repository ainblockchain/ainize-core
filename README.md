# ainize-core — shared ground

The types, rules and signatures every other [Ainize](https://github.com/ainblockchain/ainize) package
agrees on. It depends on nothing in this organisation; everything else depends on it.

- **Domain types** — patches, anchors, benchmarks, catalogue entries, billing, subscription terms
- **Identity and signing** — key handling, `signMessage` / `verifyMessage`, the teaching-key header
  (`teachAuthMessage`, `teachAuthHeaderFor`) that the CLI, the MCP server and the browser all produce
- **Lineage** — the parent/child rules a derived patch must satisfy, and the pre-state hash the trainer
  and the node compute independently and compare
- **Ledger** — local and on-chain (AIN) record writers, and the x402 payment envelope
- **Config** — the node config schema, defaults and env overlay (`AINIZE_*`)

```bash
npm install && npm run build && npm test
```

Nothing here opens a socket, a database or a model. If a helper needs a request object or a replay
cache it belongs in [ainize-node](https://github.com/ainblockchain/ainize-node) instead — that split is
what lets a CLI talk to a remote node without installing a server.
