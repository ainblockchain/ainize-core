/**
 * Shapes an operator's tools read back from a node — over HTTP, or in-process when the tool IS the node.
 *
 * These live in core because the CLI receives every one of them as JSON from `/api/me/blobs`, `/api/status`
 * and friends. Importing them from `@ainize/node` made a terminal that only ever talks to a remote node build
 * against express, sqlite and the trainer to name the type of a response it had already parsed.
 */

export interface DiskReport {
  /** Absolute path of the data directory these numbers describe. */
  path: string;
  /** Patch bodies (.npz) fetched or imported into `<dataDir>/blobs`. */
  blobs: number;
  /** Published training sets under `<dataDir>/blobs/datasets`. */
  datasets: number;
  /** Whatever multer wrote for uploads (`<dataDir>/uploads`). */
  uploads: number;
  /** node.sqlite + its WAL/SHM sidecars, and the local ledger file when there is one. */
  db: number;
  /** AINIZE_HOME/node.log, when the node knows its home. */
  log: number;
  /** blobs + datasets + uploads + db + log. */
  total: number;
  /** Free bytes on the filesystem holding the data directory (null when it cannot be read). */
  free: number | null;
  /** Total bytes of that filesystem (null when it cannot be read). */
  size: number | null;
  /** How many body files are in the blob store. */
  blob_files: number;
  /**
   * Bodies this node neither authored nor bought — verification leftovers, re-fetchable from any peer that holds
   * them. What `ainize gc` would remove. Filled in by the market (it needs the catalogue); zero here on its own.
   */
  reclaimable_files: number;
  reclaimable_bytes: number;
}

export interface GcCandidate {
  patch_id: string;
  sha256: string;
  name: string;
  status: string;
  bytes: number;
  path: string;
  /** Why this node has it at all — always 'verification' today; the field exists so a reason can never be implied. */
  reason: 'verification';
  /** Last time this node touched the body (import time). */
  imported_at: number;
  /** Peers advertising the same body: how many places it can be fetched back from. */
  holders: number;
}

export interface SeedOptions { repo?: string; synthetic?: boolean; real?: boolean; prototype?: boolean; announce?: boolean; versions?: boolean; }

export interface SeedReport { imported_prototype: number; created: string[]; branches: string[]; skipped: string[]; missing: string[]; }
