/**
 * What a verifier has put at risk to be counted. Pure rules, in a file that imports nothing, because the node
 * enforces them and the CLI and the explorer both have to say the same thing about the same numbers.
 *
 * ## Why this exists, when `verifier.stake` was deleted
 *
 * A `stake` field was on every attestation once, and it was removed (item 127) for a reason that was correct:
 * nothing was ever escrowed, transferred or slashed for it, so it was a number a verifier typed about itself.
 * The argument that replaced it — an attestation is signed onto a permanent public record, and any node may
 * challenge it — is still the right argument about an attestation that is WRONG. Someone stands behind it, the
 * record says who, and a challenge takes the knowledge off sale.
 *
 * It is not an argument about an attestation that is CHEAP. Publishing does not sell until two independent nodes
 * have loaded the patch into the real model and scored it, and independence is counted over the serving instance a
 * verification actually ran on — which defeats a cluster of processes sharing one GPU, and does not touch a person
 * with two machines, or two rented ones. The quorum is a count of signatures, and signatures are free. So the
 * defence against a seller attesting to their own work under other keys was: keys are cheap, and the cost of
 * getting caught is a record nobody is obliged to read.
 *
 * A bond makes the sybil pay rent. It is not a promise of honesty and it does not make a wrong attestation right;
 * it makes the SECOND identity cost as much as the first, which is the only property the quorum ever needed and
 * the one it did not have.
 *
 * ## What is different this time
 *
 * The thing item 127 refused was a self-declared number. This is not one:
 *
 *  - It is **held by the chain, not by us.** A bond is AIN staked on the knowledge app at
 *    `/staking/knowledge/<address>`, which the chain locks and releases on its own schedule. No contract of ours
 *    holds anyone's money, so there is no custodian to trust and none to compromise.
 *  - It is **read, never accepted.** A node asks the chain what an address has staked. Nothing a peer says about
 *    its own bond is worth anything, which is exactly what went wrong with `stake`.
 *  - It is **enforced by each node separately.** `countsTowardQuorum` is applied by whoever is counting, against
 *    the minimum THEY configured. There is no registry, no admission, and nobody who can let a friend in.
 *
 * ## Slashing, and why there is none
 *
 * Burning a bond needs someone who can take it, and that is a custodian — the thing the design above is built to
 * avoid. So a verifier that loses a challenge is barred (`BOND_BAR_MS`) rather than robbed: it earns no verifier
 * share, and its attestations stop counting anywhere, while its bond stays locked through an unbonding period it
 * cannot shorten. The penalty is the bond's opportunity cost plus the lost revenue, and it is paid to nobody —
 * which is worse for the sybil than a fine and unavailable to an attacker as a weapon against an honest node.
 */

/**
 * The floor under a bond, in AIN, for an attestation to count toward a quorum.
 *
 * Not a price on honesty — nobody is deterred from lying by a sum they get back. It is what a SECOND identity
 * costs, and the number that matters is the multiple: a quorum of 2 with a 100k floor cannot be self-attested
 * under 200k of locked AIN, however many machines are rented.
 *
 * An operator may require more of the verifiers it counts (`verifier.requireBond`) and may never require less:
 * a node that accepted unbonded attestations would be counting signatures again, and the knowledge it listed as
 * VERIFIED would travel to peers that hold the floor.
 */
export const NETWORK_MIN_VERIFIER_BOND = 100_000;

/**
 * How long a withdrawal takes once asked for.
 *
 * It is the whole penalty, so it outlasts the thing being punished: longer than a challenge takes to resolve, and
 * long enough that "attest badly, withdraw before anyone notices" is not a strategy. It is also why a bond is not
 * merely a balance check — an address that borrows the float, proves it, and sends it back has proved nothing.
 */
export const BOND_UNBONDING_MS = 21 * 24 * 3600_000;

/** How long a verifier that lost a challenge is not counted. Outlasts the unbonding period on purpose: leaving is
 * not a way to serve the ban out, and coming back means bonding again from the beginning. */
export const BOND_BAR_MS = 90 * 24 * 3600_000;

/** A bond as the chain reports it, plus what this node knows about the address's standing. */
export interface BondState {
  /** AIN staked on the knowledge app by this address. Read from the chain; never taken from a peer's own claim. */
  amount: number;
  /** When `unstake` was asked for, if it has been. Bonded funds stop counting the moment withdrawal begins. */
  unbonding_since?: number | null;
  /** Set when a challenge against this verifier succeeded; it counts nowhere until then. */
  barred_until?: number | null;
}

export type BondStatus = 'none' | 'active' | 'unbonding' | 'barred';

/** What this node requires of the verifiers it counts: its own configuration, floored at the network minimum. */
export function effectiveMinBond(configured?: number | null): number {
  const n = typeof configured === 'number' && Number.isFinite(configured) ? configured : NETWORK_MIN_VERIFIER_BOND;
  return Math.max(NETWORK_MIN_VERIFIER_BOND, n);
}

/**
 * Where a bond stands, in the order the states actually override each other: a barred verifier is barred whatever
 * it holds, and an address on its way out is not bonded however much is still locked.
 */
export function bondStatus(bond: BondState | null | undefined, now = Date.now()): BondStatus {
  if (!bond) return 'none';
  if (typeof bond.barred_until === 'number' && bond.barred_until > now) return 'barred';
  if (typeof bond.unbonding_since === 'number' && bond.unbonding_since > 0) return 'unbonding';
  return Number(bond.amount) > 0 ? 'active' : 'none';
}

/** When an unbonding bond becomes withdrawable. Null when none was asked for. */
export function unbondingReadyAt(bond: BondState | null | undefined): number | null {
  const since = bond?.unbonding_since;
  return typeof since === 'number' && since > 0 ? since + BOND_UNBONDING_MS : null;
}

/**
 * Whether an attestation by this address counts toward a quorum — and, when it does not, the sentence a person
 * gets to read. Refusals say the number and the shortfall: "not bonded" sent an operator to the wrong place more
 * than once, because the commonest cause is a bond that is fine and a withdrawal nobody remembered starting.
 */
export function countsTowardQuorum(
  bond: BondState | null | undefined,
  opts: { minBond?: number | null; now?: number } = {},
): { ok: boolean; status: BondStatus; required: number; reason?: string } {
  const required = effectiveMinBond(opts.minBond);
  const now = opts.now ?? Date.now();
  const status = bondStatus(bond, now);
  const held = Number(bond?.amount ?? 0) || 0;

  if (status === 'barred') {
    const until = new Date(Number(bond?.barred_until)).toISOString();
    return { ok: false, status, required, reason: `this verifier lost a challenge and is not counted until ${until}` };
  }
  if (status === 'unbonding') {
    const ready = unbondingReadyAt(bond);
    return {
      ok: false, status, required,
      reason: `this verifier is withdrawing its bond (${held} AIN, released ${ready ? new Date(ready).toISOString() : 'once the unbonding period ends'})`
        + ' — a bond on its way out backs nothing, so the attestation does not count',
    };
  }
  if (held < required) {
    return {
      ok: false, status, required,
      reason: `this verifier has ${held} AIN bonded and this node counts attestations from ${required} AIN up`
        + ` (short by ${Math.round((required - held) * 1e6) / 1e6}) — stake on the knowledge app to raise it`,
    };
  }
  return { ok: true, status, required };
}

/**
 * Whether THIS node may attest at all, which is the same test read from the other side.
 *
 * Asked before the work rather than after: verification costs a GPU minute and somebody else's gigabyte, and a node
 * that discovers its attestation counts nowhere has already spent both.
 */
export function canAttest(
  bond: BondState | null | undefined,
  opts: { minBond?: number | null; now?: number } = {},
): { ok: boolean; reason?: string } {
  const r = countsTowardQuorum(bond, opts);
  if (r.ok) return { ok: true };
  const mine = r.status === 'none' && Number(bond?.amount ?? 0) === 0
    ? `this node has no bond on the knowledge app and attestations from it count toward no quorum:`
      + ` stake at least ${r.required} AIN (\`ainize bond stake ${r.required}\`) before verifying for strangers`
    : r.reason;
  return { ok: false, reason: mine };
}

/**
 * How many of a set of attestations count — the quorum arithmetic itself, so that no caller re-implements it.
 *
 * `bondOf` is a lookup the caller has already resolved (a chain read per verifier, cached): this file reads nothing
 * and awaits nothing. Self-attestation is refused before a bond is ever looked at, wherever the caller does that
 * today; a bond does not buy the right to verify your own work.
 */
export function quorumCount<T extends { verifier: string }>(
  attestations: readonly T[],
  bondOf: (address: string) => BondState | null | undefined,
  opts: { minBond?: number | null; now?: number } = {},
): { counted: T[]; skipped: { attestation: T; reason: string }[] } {
  const counted: T[] = [];
  const skipped: { attestation: T; reason: string }[] = [];
  const seen = new Set<string>();
  for (const a of attestations) {
    const key = String(a.verifier ?? '').toLowerCase();
    // One address is one voice however many times it signed: a quorum of distinct signatures was the point.
    if (seen.has(key)) {
      skipped.push({ attestation: a, reason: 'this address has already attested to this knowledge' });
      continue;
    }
    const r = countsTowardQuorum(bondOf(a.verifier), opts);
    if (r.ok) { seen.add(key); counted.push(a); }
    else skipped.push({ attestation: a, reason: r.reason ?? 'not bonded' });
  }
  return { counted, skipped };
}
