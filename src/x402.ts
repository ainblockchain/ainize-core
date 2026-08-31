/**
 * HTTP 402 (x402) helpers shared by node (server side) and cli/agent (client side).
 *
 * Wire format is compatible with ain-js `knowledge.access()`:
 *   402 response carries `x-payment-required: base64(JSON requirements[])` and body `{ requirements }`.
 *   Client retries with `X-PAYMENT: base64(JSON payload)`; server answers 200 with the gated
 *   content and `x-payment-tx-hash` / `x-payment-currency` headers.
 */
import { createHmac, randomBytes } from 'node:crypto';
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

/** Deterministic transfer key so a seller can look up /transfer/$from/$to/$key without an index. */
export function transferKeyFor(resource: string, nonce: string): string {
  return `x402_${nonce}_${resource.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40)}`;
}
