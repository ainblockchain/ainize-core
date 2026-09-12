/**
 * The teaching-key signature — the CLIENT half, in core because everything that signs one is a client.
 *
 * A teaching key is the whole identity behind Teach mode: no account, no session, just a key that signs each
 * request. The CLI signs with it, scripts sign with it, the browser mirrors it, and `@ainize/mcp` used to keep
 * a hand-copied six-line duplicate rather than import `@ainize/node` and pull express, sqlite and the trainer
 * into a process that only speaks HTTP. One definition, verified by one test, is what stops those drifting.
 *
 * Header: `x-ainize-auth: <address>:<ts>:<sig>[:v2]`
 * v2 (request-bound, single-use): sig = signMessage("teach:<nodeAddress>:<METHOD>:<path+query>:<ts>[:<sha256(body)>]").
 *   A captured header cannot be replayed to another route, another node, with another body, or a second time.
 * Both forms expire after ±5 min (`TEACH_AUTH_SKEW_MS`).
 *
 * Verification lives in `@ainize/node` (`TeachAuth`): it needs the request object and the replay cache, which
 * only a server has.
 */
import { createHash } from 'node:crypto';
import { signMessage } from './identity.js';

export const TEACH_AUTH_SKEW_MS = 5 * 60_000;
export const TEACH_AUTH_V2 = 'v2';

export interface TeachAuthTarget { node: string; method: string; path: string; body?: string | Uint8Array | null; purpose?: string }

const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The string a v2 client signs. `path` is the request target as sent (path + query); the body hash is appended only when a body is sent. */
export function teachAuthMessage(t: TeachAuthTarget & { ts: number }): string {
  const parts = [t.purpose ?? 'teach', t.node, t.method.toUpperCase(), t.path, String(t.ts)];
  if (t.body !== undefined && t.body !== null && t.body.length > 0) parts.push(sha256(t.body));
  return parts.join(':');
}

/** Build a v2 header for one request (CLI / scripts; the browser helper mirrors this). */
export function teachAuthHeaderFor(key: { privateKey: string; address: string }, t: TeachAuthTarget, ts = Date.now()): string {
  return `${key.address}:${ts}:${signMessage(teachAuthMessage({ ...t, ts }), key.privateKey)}:${TEACH_AUTH_V2}`;
}

// ------------------------------------------------------------------ delegation (AIN Wallet sign-in)

/** Header that carries the delegation, beside the ordinary `x-ainize-auth`. */
export const DELEGATE_HEADER = 'x-ainize-delegate';
/** The longest a node will honour one delegation, however long the owner wrote. */
export const DELEGATION_MAX_MS = 24 * 60 * 60_000;

/**
 * Why delegation exists at all.
 *
 * A teaching key signs EVERY request. That is right for a key the browser holds and wrong for a key a wallet
 * extension holds: `window.ainetwork.signMessage` is a user-facing prompt, so signing per request would put a
 * confirmation dialog in front of every live test, every dataset page and every poll of a running lesson. The
 * alternative people reach for — asking the extension for the private key — does not exist and should not.
 *
 * So the wallet signs ONCE, and what it signs is permission for a freshly generated browser key to act as that
 * address. The browser key signs the requests, exactly as before; the delegation rides alongside and says whose
 * they are.
 *
 * WHAT KEEPS IT HONEST, and each of these is checked in `verifyDelegation`:
 *
 *   it names THIS node       — a delegation shown to one node cannot be replayed at another.
 *   it names THAT key        — a stolen delegation is inert without the browser key it authorises, and that key
 *                              never leaves the browser.
 *   it expires               — and the node caps the window at `DELEGATION_MAX_MS` no matter what the owner
 *                              wrote, so one careless prompt cannot authorise a key for ever.
 *   the per-request proof is unchanged — the v2 signature still comes from the delegate key, so the replay
 *                              cache, the route binding and the body binding all still apply.
 *
 * What it is NOT: a login. The node keeps no session, issues nothing, and forgets the delegation the moment the
 * request ends. Two tabs, a CLI and a script can hold different delegate keys for the same owner at once — which
 * is what makes several lessons under one identity possible, rather than a thing to be worked around.
 */
export function delegateMessage(t: { node: string; delegate: string; expires: number }): string {
  return ['delegate', t.node, t.delegate.toLowerCase(), String(t.expires)].join(':');
}

export interface Delegation { owner: string; expires: number; signature: string }

/** Parse `x-ainize-delegate: <owner>:<expires>:<sig>`. Returns null on anything malformed. */
export function parseDelegation(header: string | undefined | null): Delegation | null {
  if (!header) return null;
  const parts = header.split(':');
  if (parts.length !== 3) return null;
  const [owner, expStr, signature] = parts;
  const expires = Number(expStr);
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner ?? '') || !Number.isFinite(expires) || !signature) return null;
  return { owner, expires, signature };
}

/** The header an owner's wallet produces once, and every delegated request then carries unchanged. */
export function delegateHeader(d: Delegation): string {
  return `${d.owner}:${d.expires}:${d.signature}`;
}

/**
 * The address a delegated request acts as, or null.
 *
 * `verify` is passed in rather than imported so this stays usable from the browser bundle, which verifies with
 * `@noble/secp256k1` and must not pull `@ainblockchain/ain-util` in.
 */
export function verifyDelegation(
  header: string | undefined | null,
  ctx: { node: string; delegate: string; now?: number; maxMs?: number },
  verify: (message: string, signature: string, address: string) => boolean,
): string | null {
  const d = parseDelegation(header);
  if (!d) return null;
  const now = ctx.now ?? Date.now();
  if (d.expires <= now) return null;
  if (d.expires - now > (ctx.maxMs ?? DELEGATION_MAX_MS)) return null;
  if (d.owner.toLowerCase() === ctx.delegate.toLowerCase()) return null;   // a key delegating to itself proves nothing
  const message = delegateMessage({ node: ctx.node, delegate: ctx.delegate, expires: d.expires });
  return verify(message, d.signature, d.owner) ? d.owner : null;
}
