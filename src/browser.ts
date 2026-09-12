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
// Pure, and it imports nothing but types.js — so the web can show a verification count the same way the CLI does
// instead of reimplementing `Math.min(passed, quorum)` in four places and dropping the `extra` it returns.
export { verificationCount } from './catalog.js';
// Delegation, for the AIN Wallet sign-in: `delegation.ts` imports NOTHING — the signature check is a parameter, so
// the browser passes noble's and the node passes ain-util's, and the boundary above holds either way.
export * from './delegation.js';
export type {
  Ledger, LedgerEvents, LedgerInfo, PayoutRecord, PriceRecord, RecordBody,
  RetireRecord, SubscriptionRecord, SupersedeRecord,
} from './ledger.js';
