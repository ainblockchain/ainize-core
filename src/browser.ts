/**
 * Everything a browser may import from core — and nothing that could drag ain-js into a bundle.
 *
 * `index.js` is the barrel, and it reaches identity, the ledgers and `node:module`'s createRequire through
 * them. A browser chunk that touched it shipped "(0 , C.createRequire) is not a function" and rendered an
 * empty #root. This module is the boundary that makes that unrepresentable rather than merely discouraged:
 * `types.js` imports nothing, and the ledger shapes below are re-exported with `export type`, so no runtime
 * import of `ledger.js` is emitted at all.
 *
 * Adding a runtime value here is how the guarantee gets lost. Types are free; values are not.
 */
export * from './types.js';
export type {
  Ledger, LedgerEvents, LedgerInfo, PayoutRecord, PriceRecord, RecordBody,
  RetireRecord, SubscriptionRecord, SupersedeRecord,
} from './ledger.js';
