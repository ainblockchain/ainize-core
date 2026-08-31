/**
 * LocalLedger — signed record DAG stored in SQLite (node:sqlite), replicated by set reconciliation.
 *
 * Record hash = sha256(canonicalJson({kind, body, author, ts, parents})); sig = ecSignMessage(hash).
 * `parents` = hashes of the newest records known when the record was created (causal frontier), which
 * gives a partial order without needing a single writer — suited to many independent peers.
 *
 * Import compatibility: blocks from the reference prototype's ledger.jsonl (linear HMAC chain written by
 * Python) are re-hashed with `pythonJson` so their original `hash` values are preserved and the linear
 * chain can still be verified.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac } from 'node:crypto';
import { canonicalJson, pythonJson, sha256Hex } from './canonical.js';
import { signMessage, verifyMessage } from './identity.js';
import type { Ledger, LedgerEvents, LedgerInfo, RecordBody, SubscriptionRecord, SupersedeRecord } from './ledger.js';
import type {
  Attestation, BranchInfo, Challenge, LedgerRecord, PatchAnchor, PeerInfo, RecordKind, Settlement,
} from './types.js';
import type { Identity } from './identity.js';

/** Secret used by the reference Python prototype for its HMAC "signature" mock. */
const PROTOTYPE_SECRET = 'x402-demo-facilitator';
const PROTOTYPE_AUTHOR = 'prototype:kimminhyun-ai';

export function recordHash(kind: RecordKind, body: unknown, author: string, ts: number, parents: string[]): string {
  return sha256Hex(canonicalJson({ kind, body, author, ts, parents }));
}

export class LocalLedger implements Ledger {
  readonly kind = 'local' as const;
  private db!: DatabaseSync;

  constructor(
    private readonly path: string,
    private readonly identity: Identity,
    private readonly events: LedgerEvents = {},
    private readonly network = 'local',
  ) {}

  async init(): Promise<void> {
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS records (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        hash    TEXT NOT NULL UNIQUE,
        kind    TEXT NOT NULL,
        author  TEXT NOT NULL,
        ts      REAL NOT NULL,
        parents TEXT NOT NULL,
        body    TEXT NOT NULL,
        sig     TEXT NOT NULL,
        legacy  INTEGER NOT NULL DEFAULT 0,
        received_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_records_kind ON records(kind);
      CREATE INDEX IF NOT EXISTS idx_records_ts ON records(ts);
      CREATE INDEX IF NOT EXISTS idx_records_recv ON records(received_at);
    `);
  }

  async close(): Promise<void> { this.db.close(); }

  async info(): Promise<LedgerInfo> {
    const row = this.db.prepare('SELECT COUNT(*) AS n, MAX(seq) AS h FROM records').get() as { n: number; h: number | null };
    const head = this.db.prepare('SELECT hash FROM records ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
    return { kind: 'local', network: this.network, records: row.n, height: row.h ?? 0, head: head?.hash };
  }

  private frontier(limit = 4): string[] {
    const rows = this.db.prepare('SELECT hash FROM records ORDER BY seq DESC LIMIT ?').all(limit) as { hash: string }[];
    return rows.map((r) => r.hash);
  }

  async append<T extends RecordBody>(kind: RecordKind, body: T): Promise<LedgerRecord<T>> {
    const ts = Date.now();
    const parents = this.frontier();
    const hash = recordHash(kind, body, this.identity.address, ts, parents);
    const sig = signMessage(hash, this.identity.privateKey);
    const rec: LedgerRecord<T> = { hash, kind, body, author: this.identity.address, ts, parents, sig };
    this.insert(rec, false);
    this.events.onRecord?.(rec);
    return rec;
  }

  async ingest(record: LedgerRecord): Promise<boolean> {
    if (this.has(record.hash)) return false;
    if (!LocalLedger.validate(record)) throw new Error(`invalid record ${record.hash}`);
    this.insert(record, record.author.startsWith('prototype:'));
    this.events.onRecord?.(record);
    return true;
  }

  static validate(record: LedgerRecord): boolean {
    if (record.author.startsWith('prototype:')) return LocalLedger.validateLegacy(record);
    const expect = recordHash(record.kind, record.body, record.author, record.ts, record.parents);
    if (expect !== record.hash) return false;
    return verifyMessage(record.hash, record.sig, record.author);
  }

  /** Legacy prototype block: {i,t,kind,body,prev,hash,sig(HMAC)} mapped into a record. */
  private static validateLegacy(record: LedgerRecord): boolean {
    const legacy = (record.body as { __legacy?: { i: number; t: number; prev: string } }).__legacy;
    if (!legacy) return false;
    const { __legacy, ...body } = record.body as Record<string, unknown>;
    const raw = pythonJson({ i: legacy.i, t: legacy.t, kind: record.kind, body, prev: legacy.prev });
    if (sha256Hex(raw) !== record.hash) return false;
    const sig = createHmac('sha256', PROTOTYPE_SECRET).update(record.hash).digest('hex');
    return sig === record.sig;
  }

  private has(hash: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM records WHERE hash = ?').get(hash);
  }

  private insert(rec: LedgerRecord, legacy: boolean): void {
    this.db.prepare(
      'INSERT INTO records (hash, kind, author, ts, parents, body, sig, legacy, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(rec.hash, rec.kind, rec.author, rec.ts, JSON.stringify(rec.parents), JSON.stringify(rec.body), rec.sig, legacy ? 1 : 0, Date.now());
  }

  private rowToRecord(r: Record<string, unknown>): LedgerRecord {
    return {
      hash: r.hash as string,
      kind: r.kind as RecordKind,
      author: r.author as string,
      ts: r.ts as number,
      parents: JSON.parse(r.parents as string),
      body: JSON.parse(r.body as string),
      sig: r.sig as string,
    };
  }

  async list(opts: { since?: number; kind?: RecordKind; limit?: number } = {}): Promise<LedgerRecord[]> {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.since !== undefined) { where.push('received_at > ?'); args.push(opts.since); }
    if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
    const sql = `SELECT * FROM records ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ASC ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}`;
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => this.rowToRecord(r));
  }

  async get(hash: string): Promise<LedgerRecord | null> {
    const r = this.db.prepare('SELECT * FROM records WHERE hash = ?').get(hash) as Record<string, unknown> | undefined;
    return r ? this.rowToRecord(r) : null;
  }

  /** Records received after `since` (peer-local receive clock) plus the cursor to continue from. */
  async sync(since = 0, limit = 500): Promise<{ records: LedgerRecord[]; cursor: number }> {
    const rows = this.db.prepare('SELECT * FROM records WHERE received_at > ? ORDER BY received_at ASC, seq ASC LIMIT ?').all(since, limit) as Record<string, unknown>[];
    const records = rows.map((r) => this.rowToRecord(r));
    const cursor = rows.length ? (rows[rows.length - 1].received_at as number) : since;
    return { records, cursor };
  }

  async hashes(since = 0): Promise<string[]> {
    return (this.db.prepare('SELECT hash FROM records WHERE received_at > ? ORDER BY seq').all(since) as { hash: string }[]).map((r) => r.hash);
  }

  private async byKind<T>(kind: RecordKind, filter?: (b: T) => boolean): Promise<LedgerRecord<T>[]> {
    const recs = (await this.list({ kind })) as LedgerRecord<T>[];
    return filter ? recs.filter((r) => filter(r.body)) : recs;
  }

  anchors() { return this.byKind<PatchAnchor>('anchor'); }
  attestations(patchId?: string) { return this.byKind<Attestation>('attest', patchId ? (b) => b.patch_id === patchId : undefined); }
  settlements(patchId?: string) { return this.byKind<Settlement>('settle', patchId ? (b) => b.patch_id === patchId : undefined); }
  challenges(patchId?: string) { return this.byKind<Challenge>('challenge', patchId ? (b) => b.patch_id === patchId : undefined); }
  branches() { return this.byKind<BranchInfo>('branch'); }
  nodes() { return this.byKind<PeerInfo>('node'); }
  supersedes() { return this.byKind<SupersedeRecord>('supersede'); }
  subscriptions() { return this.byKind<SubscriptionRecord>('subscribe'); }

  async verify(): Promise<{ valid: boolean; checked: number; errors: string[] }> {
    const errors: string[] = [];
    const all = await this.list();
    // legacy linear chain check
    let prev = '0'.repeat(64);
    for (const r of all) {
      if (!LocalLedger.validate(r)) errors.push(`bad hash/sig: ${r.hash}`);
      const legacy = (r.body as { __legacy?: { prev: string } }).__legacy;
      if (legacy) {
        if (legacy.prev !== prev) errors.push(`legacy chain broken at ${r.hash}`);
        prev = r.hash;
      }
    }
    return { valid: errors.length === 0, checked: all.length, errors };
  }

  /**
   * Import the reference prototype's ledger.jsonl (Python HMAC chain). Blocks become records whose
   * `hash` is the original block hash; their Python-shaped bodies are normalised onto our schema by the
   * caller (see node/seed.ts) — here we only preserve them verbatim so `verify()` can re-check the chain.
   */
  async importPrototypeLedger(file: string): Promise<number> {
    if (!existsSync(file)) return 0;
    let n = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const blk = JSON.parse(line) as { i: number; t: number; kind: string; body: Record<string, unknown>; prev: string; hash: string; sig: string };
      const kind = (blk.kind === 'settle' || blk.kind === 'attest' || blk.kind === 'anchor') ? blk.kind : 'anchor';
      const rec: LedgerRecord = {
        hash: blk.hash,
        kind,
        body: { ...blk.body, __legacy: { i: blk.i, t: blk.t, prev: blk.prev } },
        author: PROTOTYPE_AUTHOR,
        ts: Math.round(blk.t * 1000),
        parents: blk.prev === '0'.repeat(64) ? [] : [blk.prev],
        sig: blk.sig,
      };
      if (await this.ingest(rec)) n++;
    }
    return n;
  }
}

export type { SupersedeRecord, SubscriptionRecord };
