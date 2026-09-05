/**
 * HTTP 402 (x402) helpers shared by node (server side) and cli/agent (client side).
 *
 * Wire format is compatible with ain-js `knowledge.access()`:
 *   402 response carries `x-payment-required: base64(JSON requirements[])` and body `{ requirements }`.
 *   Client retries with `X-PAYMENT: base64(JSON payload)`; server answers 200 with the gated
 *   content and `x-payment-tx-hash` / `x-payment-currency` headers.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { sha256Hex } from './canonical.js';
import type { X402Payload, X402Requirement } from './types.js';

export const X402_HEADER_REQUIRED = 'x-payment-required';
export const X402_HEADER_PAYMENT = 'x-payment';
export const X402_HEADER_TX = 'x-payment-tx-hash';
export const X402_HEADER_CURRENCY = 'x-payment-currency';
export const X402_HEADER_RESPONSE = 'x-payment-response';

export function encodeRequirements(reqs: X402Requirement[]): string {
  return Buffer.from(JSON.stringify(reqs)).toString('base64');
}

export function decodeRequirements(header: string | null | undefined, body?: unknown): X402Requirement[] {
  if (header) {
    try { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { /* fallthrough */ }
    try { return JSON.parse(header); } catch { /* fallthrough */ }
  }
  const b = body as { requirements?: X402Requirement[]; accepts?: X402Requirement[] } | undefined;
  return b?.requirements ?? b?.accepts ?? [];
}

export function encodePayload(p: X402Payload): string {
  return Buffer.from(JSON.stringify(p)).toString('base64');
}

export function decodePayload(header: string | null | undefined): X402Payload | null {
  if (!header) return null;
  try { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { /* fallthrough */ }
  try { return JSON.parse(header); } catch { return null; }
}

export function newNonce(): string {
  return randomBytes(12).toString('hex');
}

/** local-credit scheme: facilitator proof = HMAC(secret, resource:amount:nonce:payer). */
export function localCreditProof(secret: string, resource: string, amount: string, nonce: string, payer: string): string {
  return createHmac('sha256', secret).update(`${resource}:${amount}:${nonce}:${payer}`).digest('hex');
}

/**
 * Deterministic transfer key so a seller can look up /transfer/$from/$to/$key without an index — and, since the
 * nonce is in it, so the seller can tell WHICH quote a transfer was made against. An AIN transfer carrying any
 * other key is money that arrived for no particular reason: it buys nothing (finding 344).
 */
export function transferKeyFor(resource: string, nonce: string): string {
  return `x402_${nonce}_${resource.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40)}`;
}

/**
 * The key a ROYALTY transfer is written under (finding 314): `/transfer/$seller/$creator/payout_<settle>_<to>`.
 *
 * The buyer's payment is bound to its quote by `transferKeyFor`, and the seller's onward transfers to the creators
 * had no key at all — one anonymous push id per creator, no memo, nothing joining it to the sale it honoured. So
 * 34 reported royalties, 29 the seller claimed and 8 visible in chain state could be reconciled by nobody: an
 * ancestor had no evidence to dispute with and an honest seller had none to show. Derived from the settle hash, so
 * either party can look the transfer up without an index.
 */
export function payoutKeyFor(settleHash: string, to: string): string {
  return `payout_${settleHash.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}_${to.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}`;
}

/**
 * What an ain-transfer payer signs so the seller knows the person presenting the tx hash is the person who paid.
 * Every transfer on an AIN chain is public, so the hash alone is a bearer ticket; this digest is not (finding 344).
 */
export function ainPaymentDigest(txHash: string, nonce: string): string {
  return sha256Hex(`x402-ain:${txHash}:${nonce}`);
}
