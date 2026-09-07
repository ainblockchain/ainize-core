/**
 * The vocabulary of a node's event log, in core because the things that READ the log are not the node.
 *
 * `ainize logs --kind` offers exactly this list, so a mistyped kind is refused with the list instead of
 * printing an empty screen that looks like an idle node (items 116/132) — and the CLI has to know the list
 * to do that. It used to import it from `@ainize/node`, which meant a terminal that only ever talks to a
 * remote node over HTTP still had to install express, sqlite and the trainer to spell-check a flag.
 */

/** Severity order (low → high): a `level` filter means "this level and worse". */
export const EVENT_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

/** Every `kind` a node writes events under. */
export const EVENT_KINDS = [
  'blob', 'branch', 'buy', 'challenge', 'config', 'drive',
  // `lineage` = somebody published a knowledge built on one of ours; `royalty` = a sale of theirs paid us for it
  // (items 183, 195, 318, 319). Both are derived from the catalogue, so `ainize logs --kind lineage` works on
  // whichever route the record took.
  'lineage', 'node', 'p2p', 'patch', 'payout', 'publish', 'royalty',
  'runtime', 'seed', 'settings', 'teach', 'trade', 'usage', 'verifier', 'verify',
] as const;
