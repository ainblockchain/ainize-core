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
