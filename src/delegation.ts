/**
 * Delegation — an AIN Wallet owner authorising a browser key, signed once.
 *
 * Its own module, and IMPORTING NOTHING, because the browser needs it. `browser.ts` is the boundary that keeps
 * `node:crypto` and ain-js out of the web bundle, and its rule is that a runtime value added there is how that
 * guarantee gets lost. This file has no imports to lose it with: `verifyDelegation` takes the signature check as a
 * parameter, so the node passes ain-util's and the browser passes noble's, and neither drags the other in.
 */
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

// ------------------------------------------------------------------ operator sign-in by signature

/**
 * What an operator signs to prove who they are, instead of typing a password.
 *
 * The node's operator has been a password in `config.json` since the beginning, and on a product whose entire
 * identity model is "a key signs for itself" that is the one place a shared secret survived: it cannot be rotated
 * without a session purge, it is typed into a browser, and the node has to store a hash of it.
 *
 * A signature has none of those problems and the operator already has the key — it is the node's own identity, or
 * an address the operator listed. The nonce comes from the node and is single-use, so a captured signature buys
 * nothing; the node address is in the message, so a signature made for one node is worthless at another.
 */
export function operatorLoginMessage(t: { node: string; nonce: string }): string {
  return ['ainize-login', t.node, t.nonce].join(':');
}

/** How long a login nonce stays usable. Short: the person is standing there. */
export const LOGIN_NONCE_TTL_MS = 2 * 60_000;
