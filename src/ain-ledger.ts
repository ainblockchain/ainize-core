/**
 * AinLedger — AI Network blockchain backend built on @ainblockchain/ain-js.
 *
 * Mapping (see 10-출원명세서 §4 원장·거래부, 청구항 11-1..11-3, 19):
 *  - anchor   → knowledge.explore(): gated exploration (price + gateway_url = this node's x402 endpoint),
 *               content = patch manifest JSON → content_hash on-chain; parentEntry → `extends` graph edge
 *               (lineage / royalty), relatedEntries → `related` edges (branch siblings, conflicts).
 *               Public patch metadata mirrors to /apps/knowledge/market/patches/$id (author-only write rule).
 *  - attest   → /apps/knowledge/market/attestations/$id/$verifier/$created_at   (rule: auth.addr === $verifier && data === null — write-once, item 331)
 *  - settle   → /apps/knowledge/market/settlements/$id/$tx           (rule: buyer or seller)
 *               + ain-js access receipt (/apps/knowledge/access/$buyer/…) written by the buyer after download (recordAccess).
 *  - challenge→ /apps/knowledge/market/challenges/$id/$challenger
 *  - branch   → /apps/knowledge/market/branches/$name                 (rule: owner)
 *  - node     → /apps/knowledge/market/nodes/$addr                    (rule: auth.addr === $addr)
 *  - supersede→ /apps/knowledge/market/supersedes/$old/$new
 *  - subscribe→ /apps/knowledge/market/subscriptions/$node/$branch
 *
 * Permissions are enforced by the chain's rule engine, not by this process. Every write is a
 * signed transaction from the node identity, so records carry the chain tx hash as `sig`.
 */
import { createRequire } from 'node:module';
import { canonicalJson, sha256Hex } from './canonical.js';
import { MAX_CONTRIBUTORS } from './types.js';
import type { Ledger, LedgerEvents, LedgerInfo, PayoutRecord, PriceRecord, RecordBody, RetireRecord, SubscriptionRecord, SupersedeRecord } from './ledger.js';
import type {
  Attestation, BranchInfo, Challenge, Dispute, LedgerRecord, PatchAnchor, PeerInfo, RecordKind, Settlement,
} from './types.js';
import type { Identity } from './identity.js';

const require = createRequire(import.meta.url);
// ain-js is CommonJS with `exports.default`
const AinCtor = (require('@ainblockchain/ain-js') as { default: any }).default;

/** Genesis account of the 1-node local dev chain (blockchain-configs/1-node) — public test key, dev only. */
export const LOCAL_GENESIS = {
  address: '0x00ADEc28B6a845a085e03591bE7550dd68673C1C',
  privateKey: 'b22c95ffc4a5c096f7d7d0487ba963ce6ac945bdc91c79b64ce209de289bec96',
};

/** Fund an address from the local dev chain's genesis account. Refuses non-local providers. */
export async function fundFromGenesis(providerUrl: string, to: string, amount: number): Promise<{ tx_hash: string; balance: number }> {
  const u = new URL(providerUrl);
  if (!['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname)) throw new Error('fundFromGenesis only works against a local dev chain');
  const ain = new AinCtor(providerUrl, null, 0);
  ain.wallet.addAndSetDefaultAccount(LOCAL_GENESIS.privateKey);
  const res = await ain.wallet.transfer({ to, value: amount, nonce: -1 });
  if (!res?.tx_hash) throw new Error(`transfer failed: ${JSON.stringify(res).slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 1500));
  return { tx_hash: res.tx_hash, balance: await ain.wallet.getBalance(to) };
}

/** Quick reachability probe for an AIN node. */
export async function ainReachable(providerUrl: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const r = await fetch(`${providerUrl.replace(/\/$/, '')}/node_status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const j = (await r.json()) as { result?: { health?: boolean; state?: string } };
    return !!j.result?.health && j.result?.state === 'SERVING';
  } catch { return false; }
}

export interface AinLedgerOptions {
  providerUrl: string;
  eventHandlerUrl?: string | null;
  chainId: number;
  appName?: string;          // ain-js hard-codes '/apps/knowledge'
  gasPrice?: number;
}

const APP = '/apps/knowledge';
const MARKET = `${APP}/market`;

function keyOf(path: string): string {
  return path.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * AIN state values cannot hold JS arrays (only objects/primitives) and empty objects are pruned.
 * toAin(): arrays → {"0":…,"1":…}; empty arrays/objects → null (key omitted); undefined → omitted.
 * fromAin(): objects whose keys are exactly 0..n-1 → arrays. Our record schemas never use such keys otherwise.
 */
export function toAin(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (Array.isArray(v)) {
    if (!v.length) return null;
    const o: Record<string, unknown> = {};
    v.forEach((x, i) => { const y = toAin(x); if (y !== undefined) o[String(i)] = y; });
    return Object.keys(o).length ? o : null;
  }
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const y = toAin(x);
      if (y !== undefined && y !== null) o[k] = y;
    }
    return Object.keys(o).length ? o : null;
  }
  return v;
}

export function fromAin(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length && keys.every((k, i) => k === String(i))) return keys.map((k) => fromAin(o[k]));
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = fromAin(o[k]);
  return out;
}

/**
 * Restore array fields that `toAin()` dropped because they were empty. Every record kind is handled with an explicit
 * per-field line below (a generic field list cannot tell an anchor's `parents` from a branch's `patch_ids`).
 */
export function withEmptyArrays<T>(body: T): T {
  if (!body || typeof body !== 'object') return body;
  const b = body as Record<string, unknown>;
  if ('author' in b && 'patch_sha256' in b) {
    // anchor
    b.parents = b.parents ?? []; b.parent_authors = b.parent_authors ?? [];
    b.contributors = Array.isArray(b.contributors) ? b.contributors.slice(0, MAX_CONTRIBUTORS) : [];
    // lineage fields (design §5.1): the three arrays inside them are restored only when the parent object exists,
    // so a pre-lineage anchor reads back exactly as it was written
    const dv = b.derivation as Record<string, unknown> | undefined;
    if (dv && typeof dv === 'object') dv.bases = dv.bases ?? [];
    const bs = b.base as Record<string, unknown> | undefined;
    if (bs && typeof bs === 'object') bs.stack = bs.stack ?? [];
    const ds = b.dataset as Record<string, unknown> | undefined;
    if (ds && typeof ds === 'object' && ds.access !== undefined) ds.parents = ds.parents ?? [];
  }
  if ('benchmark' in b && b.benchmark && typeof b.benchmark === 'object') { const bm = b.benchmark as Record<string, unknown>; bm.format = bm.format ?? []; bm.samples = bm.samples ?? []; }
  if ('roles' in b || 'endpoint' in b) { b.roles = b.roles ?? []; b.branches = b.branches ?? []; b.blobs = b.blobs ?? []; b.datasets = b.datasets ?? []; }
  if ('context' in b && 'owner' in b) { b.patch_ids = b.patch_ids ?? []; b.context = b.context ?? {}; }
  if ('action' in b && 'branch' in b) { b.patch_ids = b.patch_ids ?? []; }
  if ('royalty' in b) { b.royalty = b.royalty ?? {}; }
  if ('score' in b) { b.score = b.score ?? {}; }
  return body;
}

/**
 * Rebuild ledger records from the decoded /apps/knowledge/market subtree (pure; used by refresh() and unit tests).
 * Records are sorted oldest → newest by `ts`. Supersede and subscription values written before `created_at`
 * existed carry no timestamp of their own: a supersede is dated right after the newest attestation (or the
 * anchor) of the *new* patch — it is written the moment that patch reaches quorum — and authored by that
 * patch's author; a subscription is dated right after its branch was created.
 */
export function recordsFromMarketState(market: any): LedgerRecord[] {
  const recs: LedgerRecord[] = [];
  const push = (kind: RecordKind, ref: string, rawBody: any, author: string, ts: number) => {
    const body = withEmptyArrays(rawBody);
    recs.push({ hash: sha256Hex(`${ref}:${canonicalJson(body)}`), kind, body, author, ts, parents: [], sig: '' });
  };
  const anchorTs = new Map<string, number>();
  const anchorAuthor = new Map<string, string>();
  const attestTs = new Map<string, number>();
  const branchTs = new Map<string, number>();
  for (const [id, a] of Object.entries<any>(market?.patches ?? {})) if (a && typeof a.patch_sha256 === 'string' && a.author) {
    push('anchor', `${MARKET}/patches/${id}`, a, a.author, a.created_at ?? 0);
    anchorTs.set(id, a.created_at ?? 0); anchorAuthor.set(id, a.author);
  }
  for (const [id, m] of Object.entries<any>(market?.attestations ?? {}))
    for (const [v, slot] of Object.entries<any>(m)) {
      // Two shapes live under one verifier (item 331). Records written before 2026-09 are a single value at
      // `…/$id/$verifier`, overwritten in place by every re-verification. Records written since are one write-once
      // child per `created_at`, so a PASS that was challenged and re-passed leaves both on the chain — which is what
      // `effectiveAttestation` needs to choose among, and the only history a verifier can be held to.
      const legacy = slot && typeof slot.passed === 'boolean';
      const records: [string, any][] = legacy ? [['', slot]] : Object.entries<any>(slot ?? {});
      for (const [key, at] of records) {
        if (!at || at.patch_id !== id || at.verifier !== v || typeof at.passed !== 'boolean') continue;
        // the legacy ref is kept exactly as it was: the record hash is derived from it
        push('attest', legacy ? `${MARKET}/attestations/${id}/${v}` : `${MARKET}/attestations/${id}/${v}/${key}`, at, v, at.created_at ?? 0);
        attestTs.set(id, Math.max(attestTs.get(id) ?? 0, at.created_at ?? 0));
      }
    }
  for (const [id, m] of Object.entries<any>(market?.settlements ?? {}))
    for (const [k, s] of Object.entries<any>(m)) push('settle', `${MARKET}/settlements/${id}/${k}`, s, s.seller, s.created_at ?? 0);
  for (const [id, m] of Object.entries<any>(market?.challenges ?? {}))
    for (const [c, ch] of Object.entries<any>(m)) push('challenge', `${MARKET}/challenges/${id}/${c}`, ch, c, ch.created_at ?? 0);
  for (const [k, b] of Object.entries<any>(market?.branches ?? {})) {
    push('branch', `${MARKET}/branches/${k}`, b, b.owner, b.created_at ?? 0);
    if (typeof b.name === 'string') branchTs.set(b.name, b.created_at ?? 0);
  }
  for (const [addr, n] of Object.entries<any>(market?.nodes ?? {})) push('node', `${MARKET}/nodes/${addr}`, n, addr, n.last_seen ?? 0);
  for (const [o, m] of Object.entries<any>(market?.supersedes ?? {}))
    for (const [nw, slot] of Object.entries<any>(m)) {
      // Two shapes, as with attestations: the legacy slot IS the record (nobody's address in the path, so the
      // best `author` available is the new anchor's — which is exactly what a reader has to check it against),
      // and the current one is keyed by the address that wrote it, which the rule engine enforces.
      const legacy = slot && typeof slot.old_patch_id === 'string';
      const entries: [string, any][] = legacy ? [['', slot]] : Object.entries<any>(slot ?? {});
      for (const [writer, s] of entries) {
        if (!s || typeof s !== 'object') continue;
        const related = Math.max(attestTs.get(nw) ?? 0, anchorTs.get(nw) ?? 0);
        const ts = typeof s.created_at === 'number' && s.created_at > 0 ? s.created_at : related ? related + 1 : 0;
        push('supersede', legacy ? `${MARKET}/supersedes/${o}/${nw}` : `${MARKET}/supersedes/${o}/${nw}/${writer}`,
          s, legacy ? anchorAuthor.get(nw) ?? '' : writer, ts);
      }
    }
  for (const [id, per] of Object.entries<any>(market?.prices ?? {}))
    for (const [author, slots] of Object.entries<any>(per ?? {}))
      for (const [key, p] of Object.entries<any>(slots ?? {})) if (p && typeof p.price === 'string')
        push('price', `${MARKET}/prices/${id}/${author}/${key}`, p, author, p.created_at ?? 0);
  for (const [hash, per] of Object.entries<any>(market?.payouts ?? {}))
    for (const [to, p] of Object.entries<any>(per ?? {})) if (p && typeof p.tx_hash === 'string')
      push('payout', `${MARKET}/payouts/${hash}/${to}`, p, p.seller ?? '', p.created_at ?? 0);
  for (const [id, m] of Object.entries<any>(market?.retires ?? {}))
    for (const [author, r] of Object.entries<any>(m)) if (r && typeof r.patch_id === 'string')
      push('retire', `${MARKET}/retires/${id}/${author}`, r, author, r.created_at ?? 0);
  for (const [id, m] of Object.entries<any>(market?.disputes ?? {}))
    for (const [settleHash, per] of Object.entries<any>(m ?? {}))
      for (const [author, d] of Object.entries<any>(per ?? {})) if (d && typeof d.reason === 'string')
        push('dispute', `${MARKET}/disputes/${id}/${settleHash}/${author}`, d, author, d.created_at ?? 0);
  for (const [node, m] of Object.entries<any>(market?.subscriptions ?? {}))
    for (const [b, s] of Object.entries<any>(m)) {
      const related = branchTs.get(s?.branch) ?? 0;
      const ts = typeof s.created_at === 'number' && s.created_at > 0 ? s.created_at : related ? related + 1 : 0;
      push('subscribe', `${MARKET}/subscriptions/${node}/${b}`, s, node, ts);
    }
  recs.sort((x, y) => x.ts - y.ts);
  return recs;
}

export class AinLedger implements Ledger {
  readonly kind = 'ain' as const;
  readonly ain: any;
  private cache: LedgerRecord[] = [];
  private lastPoll = 0;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: AinLedgerOptions,
    private readonly identity: Identity,
    private readonly events: LedgerEvents = {},
    private readonly pollMs = 8000,
  ) {
    this.ain = new AinCtor(opts.providerUrl, opts.eventHandlerUrl ?? null, opts.chainId);
    this.ain.wallet.addAndSetDefaultAccount(identity.privateKey);
  }

  get address(): string { return this.identity.address; }

  async init(): Promise<void> {
    await this.refresh();
    this.pollTimer = setInterval(() => { this.refresh().catch(() => undefined); }, this.pollMs);
    this.pollTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  async info(): Promise<LedgerInfo> {
    let height: number | undefined;
    try { height = Number(await this.ain.getLastBlockNumber()); } catch { height = undefined; }
    return {
      kind: 'ain', network: `ain:${this.opts.chainId === 0 ? 'local' : 'mainnet'}`, provider: this.opts.providerUrl,
      app: APP, height, records: this.cache.length, valid: true,
    };
  }

  /**
   * `/apps/knowledge/market/lessons/$node/$job` — the training run itself, on chain.
   *
   * Written at transitions, not per step: a progress bar is 20 writes a lesson and this is a blockchain. The value
   * replaces itself, so the path holds the latest state and the chain holds the history of how it got there.
   *
   * Failures are swallowed to a `null`. A chain that is down, out of gas or refusing the write must not fail the
   * training run that is otherwise going fine — but the caller is told it did not happen, rather than being handed
   * a path nothing is at.
   */
  async noteLesson(jobId: string, value: Record<string, unknown>): Promise<{ path: string; tx_hash: string } | null> {
    const path = `${MARKET}/lessons/${this.identity.address}/${jobId}`;
    try {
      const tx_hash = await this.set(path, { ...value, node: this.identity.address, job: jobId, updated_at: Date.now() });
      return { path, tx_hash };
    } catch { return null; }
  }

  // ---------------------------------------------------------------- chain helpers
  private tx(extra: Record<string, unknown> = {}) {
    return { nonce: -1, gas_price: this.opts.gasPrice ?? 0, ...extra };
  }

  private async set(ref: string, value: unknown): Promise<string> {
    const encoded = toAin(value);
    const res = await this.ain.db.ref(ref).setValue({ value: encoded, ...this.tx() });
    this.noteGas(res);                                   // what this write cost, measured (finding 366)
    return AinLedger.assertOk(res, ref);
  }

  /**
   * What this node's chain writes have actually cost (finding 366).
   *
   * The publish form gives no pricing guidance and the default price is 0.1, while the product's own estimate is
   * ~0.19 AIN of gas around a 0.1 AIN purchase at `min_gas_price 500` — so on a real network the default price
   * makes every sale a loss. Nothing here is estimated: `gas_cost_total` comes back on every write this node
   * makes, and this is the average of the ones it has seen. The dev chain sends `gas_price 0`, so it measures 0
   * and the warning correctly says nothing.
   */
  private gas = { writes: 0, total: 0 };
  gasStats(): { writes: number; total: number; avg: number } | null {
    return this.gas.writes ? { writes: this.gas.writes, total: Math.round(this.gas.total * 1e6) / 1e6, avg: Math.round((this.gas.total / this.gas.writes) * 1e6) / 1e6 } : null;
  }
  private noteGas(res: any): void {
    const cost = Number(res?.result?.gas_cost_total ?? res?.result?.result_list?.['0']?.gas_cost_total ?? NaN);
    if (Number.isFinite(cost)) { this.gas.writes++; this.gas.total += cost; }
  }

  private static assertOk(res: any, what: string): string {
    const code = res?.result?.code ?? res?.result?.result_list?.['0']?.code;
    if (res?.result?.message && code !== 0 && code !== undefined) {
      throw new Error(`AIN write rejected (${what}): ${res.result.message}`);
    }
    if (res?.result?.code && res.result.code !== 0) throw new Error(`AIN write rejected (${what}): code ${res.result.code}`);
    return res?.tx_hash ?? '';
  }

  async getValue(ref: string): Promise<any> {
    return fromAin(await this.ain.db.ref(ref).getValue());
  }

  /** AIN balance; an address the chain has never seen has no account yet (getBalance → null) and counts as 0. */
  async balance(address = this.identity.address): Promise<number> {
    const raw = (await this.ain.wallet.getBalance(address)) as number | string | null | undefined;
    return Number(raw ?? 0) || 0;
  }

  /**
   * Send AIN. With `key`, the transfer is written at /transfer/$from/$to/$key instead of a random push id, which is
   * how an x402 payment is bound to the quote it answers: the seller recomputes the key from (resource, nonce) and
   * refuses a transfer that carries any other one (finding 344). Without `key` this is ain-js's own push behaviour,
   * used by the royalty payouts, which answer no quote.
   */
  async transfer(to: string, value: number, key?: string): Promise<{ tx_hash: string; key: string }> {
    if (!key) {
      const res = await this.ain.wallet.transfer({ to, value, nonce: -1 });
      return { tx_hash: AinLedger.assertOk(res, `transfer→${to}`), key: '' };
    }
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(key)) throw new Error(`invalid transfer key ${JSON.stringify(key)}`);
    if (!(value > 0)) throw new Error(`non-positive transfer value ${value}`);
    const from = this.identity.address;
    const res = await this.ain.db.ref(`/transfer/${from}/${to}/${key}/value`).setValue({ value, ...this.tx() });
    this.noteGas(res);
    return { tx_hash: AinLedger.assertOk(res, `transfer→${to}`), key };
  }

  /**
   * Several transfers in ONE transaction (finding 366).
   *
   * A sale with three ancestors wrote three separate transfers, each paying its own gas — the product's own
   * estimate is ~0.19 AIN of gas around a 0.1 AIN purchase at `min_gas_price 500`, so a family of three
   * multiplied the loss by three. One `SET` with an op_list per payee costs one write.
   */
  async transferMany(items: { to: string; value: number; key: string }[]): Promise<{ tx_hash: string }> {
    if (!items.length) throw new Error('no transfers to make');
    const from = this.identity.address;
    for (const it of items) {
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(it.key)) throw new Error(`invalid transfer key ${JSON.stringify(it.key)}`);
      if (!(it.value > 0)) throw new Error(`non-positive transfer value ${it.value}`);
    }
    const op_list = items.map((it) => ({ type: 'SET_VALUE', ref: `/transfer/${from}/${it.to}/${it.key}/value`, value: it.value }));
    const res = await this.ain.sendTransaction({ operation: { type: 'SET', op_list }, ...this.tx() });
    this.noteGas(res);
    return { tx_hash: AinLedger.assertOk(res, `transfer x${items.length}`) };
  }

  /** The chain's own minimum gas price, straight from `/blockchain_params` — measured, never assumed (finding 366). */
  async minGasPrice(): Promise<number | null> {
    try {
      const v = await this.getValue('/blockchain_params/resource/min_gas_price');
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch { return null; }
  }

  /** Verify an AIN transfer by tx hash: returns {from,to,value} if finalized/executed. */
  async verifyTransfer(txHash: string): Promise<{ from: string; to: string; value: number; key: string } | null> {
    const info = await this.ain.getTransactionByHash(txHash);
    const op = info?.transaction?.tx_body?.operation;
    if (!op || op.type !== 'SET_VALUE') return null;
    const m = /^\/transfer\/([^/]+)\/([^/]+)\/([^/]+)\/value$/.exec(op.ref ?? '');
    if (!m) return null;
    if (!(info.is_executed || info.is_finalized)) return null;
    if (info.exec_result?.code && info.exec_result.code !== 0) return null;
    return { from: m[1], to: m[2], key: m[3], value: Number(op.value) };
  }

  /** Total AIN staked on the knowledge app (state/bandwidth budget is proportional to app stake). */
  async appStake(): Promise<number> {
    const v = await this.ain.db.ref('/staking/knowledge/balance_total').getValue();
    return Number(v ?? 0);
  }

  /** Stake AIN on the knowledge app from this identity (apps on the free tier are capped at ~100 KB of state). */
  async stakeApp(amount: number): Promise<string> {
    const ref = `/staking/knowledge/${this.identity.address}/0/stake/${Date.now()}/value`;
    const res = await this.ain.db.ref(ref).setValue({ value: amount, ...this.tx() });
    return AinLedger.assertOk(res, 'stake knowledge app');
  }

  /**
   * One-time app setup (run by the first node = app admin): ain-js setupApp() + market rules + app stake.
   * Idempotent: if the app exists and we are not admin, only the stake top-up (if we can afford it) is attempted.
   */
  async setupApp(opts: { stake?: number } = {}): Promise<{ created: boolean; tx?: string; admin?: string; staked?: number }> {
    const cfg = await this.ain.db.ref('/manage_app/knowledge/config').getValue();
    let created = false; let tx: string | undefined; let admin: string | undefined;
    if (!cfg) {
      const res = await this.ain.knowledge.setupApp({ nonce: -1 });
      tx = AinLedger.assertOk(res, 'setupApp');
      await this.setMarketRules();
      created = true; admin = this.identity.address;
    } else {
      admin = Object.keys(cfg.admin ?? {})[0];
      if (cfg.admin?.[this.identity.address]) await this.setMarketRules().catch(() => undefined);
    }
    let staked: number | undefined;
    const want = opts.stake ?? 100;
    try {
      const current = await this.appStake();
      if (current < want) {
        const bal = await this.balance();
        if (bal > want + 10) { await this.stakeApp(want); staked = want; }
      }
    } catch { /* staking is best effort */ }
    return { created, tx, admin, staked };
  }

  private async setMarketRules(): Promise<void> {
    const rules = AinLedger.marketRules();
    const op_list = rules.map(([ref, write]) => ({ type: 'SET_RULE', ref, value: { '.rule': { write } } }));
    const res = await this.ain.sendTransaction({ operation: { type: 'SET', op_list }, ...this.tx() });
    AinLedger.assertOk(res, 'market rules');
  }

  /** The write rules this build sets, and the ones `verify()` holds the chain to. One table, so they cannot drift. */
  static marketRules(): [string, string][] {
    return [
      [`${MARKET}/patches/$patch_id`, "auth.addr === newData.author && (data === null || data.author === auth.addr)"],
      [`${MARKET}/attestations/$patch_id/$verifier`, 'auth.addr === $verifier'],
      // item 331 — one slot per measurement, and a written slot is immutable. Without `data === null` a verifier
      // could silently rewrite what it had signed: a FAIL that became a PASS left no trace of either.
      [`${MARKET}/attestations/$patch_id/$verifier/$created_at`, 'auth.addr === $verifier && data === null'],
      [`${MARKET}/settlements/$patch_id/$tx_hash`, 'auth.addr === newData.seller || auth.addr === newData.buyer'],
      [`${MARKET}/challenges/$patch_id/$challenger`, 'auth.addr === $challenger'],
      [`${MARKET}/branches/$branch`, "auth.addr === newData.owner && (data === null || data.owner === auth.addr)"],
      [`${MARKET}/nodes/$addr`, 'auth.addr === $addr'],
      // A supersede said `auth.addr !== ''` — any address at all could mark ANYBODY's anchor superseded, and the
      // record then sat on the permanent public record where every node applied it. The writer goes in the path,
      // the way `retires` and `disputes` already do it, so the rule engine can name them; readers then check that
      // writer against the two anchors' author, which is the rule a supersede actually has (items 151, 363).
      [`${MARKET}/supersedes/$old_id/$new_id`, "auth.addr !== ''"],
      [`${MARKET}/supersedes/$old_id/$new_id/$author`, 'auth.addr === $author && data === null'],
      [`${MARKET}/subscriptions/$node/$branch`, 'auth.addr === $node'],
      [`${MARKET}/retires/$patch_id/$author`, 'auth.addr === $author'],
      // item 347 — a contested sale and the seller's answer to it, one write-once slot per party.
      [`${MARKET}/disputes/$patch_id/$settle_hash/$author`, 'auth.addr === $author && data === null'],
      // item 278 — only the anchor's own author re-prices it, and every price ever set stays on the record.
      [`${MARKET}/prices/$patch_id/$author/$created_at`, 'auth.addr === $author && data === null'],
      // item 314 — the seller's own record of the royalty transfer that honoured a settlement, keyed by settle hash.
      // `|| data === null` let ANY address create the first payout record for any settlement — a fabricated proof
      // that a seller had paid royalties it never paid — and the first clause with no `data === null` let the
      // seller rewrite one afterwards. Every sibling write-once rule here uses `&&`; this one meant to.
      [`${MARKET}/payouts/$settle_hash/$to`, 'auth.addr === newData.seller && data === null'],
    ];
  }

  // ---------------------------------------------------------------- Ledger API
  async append<T extends RecordBody>(kind: RecordKind, body: T): Promise<LedgerRecord<T>> {
    const ts = Date.now();
    let txHash = '';
    let ref = '';
    switch (kind) {
      case 'anchor': {
        const a = body as unknown as PatchAnchor;
        ref = `${MARKET}/patches/${a.id}`;
        if ((a.contributors?.length ?? 0) > MAX_CONTRIBUTORS) throw new Error(`anchor carries more than ${MAX_CONTRIBUTORS} contributors`);
        // 1) knowledge graph entry with lineage edges (parentEntry = first parent, others related)
        const parentAnchors = await this.anchors();
        const findEntry = (pid: string) => parentAnchors.find((r) => r.body.id === pid)?.body as (PatchAnchor & { entry_id?: string }) | undefined;
        const parentEntry = a.parents[0] ? findEntry(a.parents[0]) : undefined;
        const related = a.parents.slice(1).map(findEntry).filter(Boolean) as (PatchAnchor & { entry_id?: string })[];
        const manifest = canonicalJson({ id: a.id, patch_sha256: a.patch_sha256, model: a.model, benchmark_hash: a.benchmark_hash, rows: a.rows, size_bytes: a.size_bytes });
        const gateway = (a as PatchAnchor & { gateway_url?: string }).gateway_url ?? '';
        const ex = await this.ain.knowledge.explore({
          topicPath: a.topic_path || 'patches',
          title: a.name,
          content: manifest,
          summary: a.description.slice(0, 500),
          depth: Math.min(5, Math.max(1, a.parents.length + 1)),
          tags: `patch,${a.model.id_M},${a.benchmark.schema}${a.branch ? ',' + a.branch : ''}`,
          price: a.price,
          gatewayUrl: gateway || null,
          parentEntry: parentEntry?.entry_id ? { ownerAddress: parentEntry.author, topicPath: parentEntry.topic_path, entryId: parentEntry.entry_id } : null,
          relatedEntries: related.filter((r) => r.entry_id).map((r) => ({ ownerAddress: r.author, topicPath: r.topic_path, entryId: r.entry_id!, type: 'related' as const })),
        }, { nonce: -1 });
        AinLedger.assertOk(ex.txResult, 'knowledge.explore');
        (a as PatchAnchor & { entry_id?: string; node_id?: string }).entry_id = ex.entryId;
        (a as PatchAnchor & { entry_id?: string; node_id?: string }).node_id = ex.nodeId;
        // 2) public metadata mirror (rule: author only, write-once) — includes the entry id so buyers can knowledge.access() it
        txHash = await this.set(ref, a);
        break;
      }
      case 'attest': {
        const at = body as unknown as Attestation;
        // One write-once slot per measurement (item 331). The old ref held ONE value per verifier and the rule let its
        // author overwrite it, so a re-verification erased what this node had signed before the challenge — the only
        // asset a verifier accumulates is a history it can be held to, and it was silently rewritable by itself.
        ref = `${MARKET}/attestations/${at.patch_id}/${this.identity.address}/${keyOf(String(at.created_at || ts))}`;
        txHash = await this.set(ref, at);
        break;
      }
      case 'settle': {
        const s = body as unknown as Settlement;
        ref = `${MARKET}/settlements/${s.patch_id}/${keyOf(s.tx_hash || String(ts))}`;
        txHash = await this.set(ref, s);
        break;
      }
      case 'dispute': {
        const d = body as unknown as Dispute;
        ref = `${MARKET}/disputes/${d.patch_id}/${keyOf(d.settle_hash)}/${this.identity.address}`;
        txHash = await this.set(ref, d);
        break;
      }
      case 'challenge': {
        const c = body as unknown as Challenge;
        ref = `${MARKET}/challenges/${c.patch_id}/${this.identity.address}`;
        txHash = await this.set(ref, c);
        break;
      }
      case 'branch': {
        const b = body as unknown as BranchInfo;
        ref = `${MARKET}/branches/${keyOf(b.name)}`;
        txHash = await this.set(ref, b);
        break;
      }
      case 'node': {
        ref = `${MARKET}/nodes/${this.identity.address}`;
        const info = body as unknown as PeerInfo;
        txHash = await this.set(ref, { ...info, blobs: info.blobs.slice(0, 40) });
        break;
      }
      case 'supersede': {
        const s = body as unknown as SupersedeRecord;
        ref = `${MARKET}/supersedes/${s.old_patch_id}/${s.new_patch_id}/${this.identity.address}`;
        txHash = await this.set(ref, s);
        break;
      }
      case 'subscribe': {
        const s = body as unknown as SubscriptionRecord;
        ref = `${MARKET}/subscriptions/${this.identity.address}/${keyOf(s.branch)}`;
        txHash = await this.set(ref, s);
        break;
      }
      // A takedown of one's own knowledge: the write rule keys it by the retiring address, and only a record whose
      // author is the anchor's author is honoured when the catalogue is derived (node/market.ts).
      case 'retire': {
        const r = body as unknown as RetireRecord;
        ref = `${MARKET}/retires/${keyOf(r.patch_id)}/${this.identity.address}`;
        txHash = await this.set(ref, r);
        break;
      }
      // A re-pricing of one's own knowledge (item 278). One write-once child per `created_at`, so the whole price
      // history is on the chain and a discount can be checked against the price it was discounted from.
      case 'price': {
        const p = body as unknown as PriceRecord;
        ref = `${MARKET}/prices/${keyOf(p.patch_id)}/${this.identity.address}/${keyOf(String(p.created_at || ts))}`;
        txHash = await this.set(ref, p);
        break;
      }
      // What the seller actually transferred for one settlement (item 314) — the join between a promise and money.
      case 'payout': {
        const p = body as unknown as PayoutRecord;
        ref = `${MARKET}/payouts/${keyOf(p.settle_hash)}/${keyOf(p.to)}`;
        txHash = await this.set(ref, { ...p, seller: this.identity.address });
        break;
      }
    }
    const rec: LedgerRecord<T> = {
      hash: sha256Hex(`${ref}:${txHash}`), kind, body, author: this.identity.address, ts, parents: [], sig: txHash,
    };
    this.cache.push(rec);
    this.events.onRecord?.(rec);
    return rec;
  }

  /** Records are authoritative on-chain; peers don't push them to us. */
  async ingest(): Promise<boolean> { return false; }

  /** Re-read the market subtree and rebuild the record cache. */
  async refresh(): Promise<void> {
    const market = (fromAin(await this.ain.db.ref(MARKET).getValue()) as any) ?? {};
    const recs = recordsFromMarketState(market);
    const known = new Set(this.cache.map((r) => r.hash));
    for (const r of recs) if (!known.has(r.hash)) this.events.onRecord?.(r);
    this.cache = recs;
    this.lastPoll = Date.now();
  }

  async list(opts: { since?: number; kind?: RecordKind; limit?: number } = {}): Promise<LedgerRecord[]> {
    if (Date.now() - this.lastPoll > this.pollMs) await this.refresh().catch(() => undefined);
    let out = this.cache;
    if (opts.kind) out = out.filter((r) => r.kind === opts.kind);
    if (opts.since !== undefined) out = out.filter((r) => r.ts > opts.since!);
    if (opts.limit) out = out.slice(-opts.limit);
    return out;
  }
  async get(hash: string) { return this.cache.find((r) => r.hash === hash) ?? null; }
  async hashes(since = 0) { return (await this.list({ since })).map((r) => r.hash); }

  private async byKind<T>(kind: RecordKind, f?: (b: T) => boolean): Promise<LedgerRecord<T>[]> {
    const recs = (await this.list({ kind })) as LedgerRecord<T>[];
    return f ? recs.filter((r) => f(r.body)) : recs;
  }
  anchors() { return this.byKind<PatchAnchor>('anchor'); }
  attestations(patchId?: string) { return this.byKind<Attestation>('attest', patchId ? (b) => b.patch_id === patchId : undefined); }
  settlements(patchId?: string) { return this.byKind<Settlement>('settle', patchId ? (b) => b.patch_id === patchId : undefined); }
  challenges(patchId?: string) { return this.byKind<Challenge>('challenge', patchId ? (b) => b.patch_id === patchId : undefined); }
  disputes(patchId?: string) { return this.byKind<Dispute>('dispute', patchId ? (b) => b.patch_id === patchId : undefined); }
  branches() { return this.byKind<BranchInfo>('branch'); }
  nodes() { return this.byKind<PeerInfo>('node'); }
  supersedes() { return this.byKind<SupersedeRecord>('supersede'); }
  subscriptions() { return this.byKind<SubscriptionRecord>('subscribe'); }

  /**
   * What this node can actually check about the chain it trusts.
   *
   * Consensus guarantees that the records are the ones that were written. It guarantees nothing about WHO was
   * allowed to write them: that is the rule engine, and the rules can only be set by the app admin — the address
   * that happened to run `chain setup` first. This used to read one rule and only ask whether it existed, so an
   * admin who relaxed `attestations` to let anyone sign anyone's verdict, or `patches` to let anyone overwrite
   * anyone's anchor, changed the meaning of every record on the chain and no node said a word.
   *
   * So the rules are compared with the ones this build expects, and a difference is an error naming both. It is
   * not a defence — an admin can still change them — but it is the difference between a silent change and a
   * visible one, which is the most a participant can have while one address owns the rule engine.
   */
  async verify() {
    const errors: string[] = [];
    try {
      const expected = AinLedger.marketRules();
      let seen = 0;
      for (const [ref, want] of expected) {
        const got = await this.ain.db.ref(ref).getRule() as { '.rule'?: { write?: unknown } } | null;
        const write = got?.['.rule']?.write;
        if (write === undefined || write === null) { errors.push(`no write rule on ${ref} (run \`ainize chain setup\`)`); continue; }
        seen++;
        if (String(write) !== want) errors.push(`the write rule on ${ref} is not the one this build expects — on chain: ${String(write).slice(0, 160)} / expected: ${want.slice(0, 160)}`);
      }
      if (!seen) errors.push('market rules not set (run `ainize chain setup`)');
    } catch (e) { errors.push(`chain unreachable: ${(e as Error).message}`); }
    return { valid: errors.length === 0, checked: this.cache.length, errors };
  }

  /**
   * Buyer-side access receipt, exactly where ain-js `knowledge.access()` / `hasAccess()` look:
   * /apps/knowledge/access/$buyer/{owner}_{topicKey}_{entryId} (write rule: auth.addr === $buyer).
   */
  async recordAccess(anchor: PatchAnchor & { entry_id?: string }, amount: string, currency: string, txHash: string): Promise<string | null> {
    if (!anchor.entry_id) return null;
    const topicKey = (anchor.topic_path || 'patches').replace(/\//g, '|');
    const entryKey = `${anchor.author}_${topicKey}_${anchor.entry_id}`;
    const receipt = { seller: anchor.author, topic_path: anchor.topic_path, entry_id: anchor.entry_id, amount, currency, tx_hash: txHash, accessed_at: Date.now() };
    return this.set(`${APP}/access/${this.identity.address}/${entryKey}`, receipt);
  }

  /** Has `buyer` an on-chain access receipt for this patch (ain-js hasAccess semantics)? */
  async hasAccess(buyer: string, anchor: PatchAnchor & { entry_id?: string }): Promise<boolean> {
    if (!anchor.entry_id) return false;
    const topicKey = (anchor.topic_path || 'patches').replace(/\//g, '|');
    return this.ain.knowledge.hasAccess(buyer, `${anchor.author}_${topicKey}_${anchor.entry_id}`);
  }

  /** Knowledge-graph view (nodes/edges) straight from ain-js. */
  async graph(): Promise<{ nodes: Record<string, any>; edges: Record<string, Record<string, any>> }> {
    return this.ain.knowledge.getGraph();
  }

  /** Access receipts of a buyer (ain-js). */
  async receipts(buyer: string): Promise<Record<string, any> | null> {
    return this.ain.knowledge.getAccessReceipts(buyer);
  }
}
