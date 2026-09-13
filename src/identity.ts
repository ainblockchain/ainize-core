/**
 * Node identity = an AIN blockchain account (secp256k1). We reuse @ainblockchain/ain-util
 * exactly like the original ainize-cli did for request signing (ecSignMessage / ecVerifySig),
 * so a node's signature over a ledger record is verifiable by any peer with only the address.
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import type { SignatureScheme } from './scheme.js';

const require = createRequire(import.meta.url);
// ain-util is CommonJS
const ainUtil = require('@ainblockchain/ain-util') as typeof import('@ainblockchain/ain-util');

export interface Identity {
  privateKey: string;  // hex
  publicKey: string;   // hex (uncompressed, without 04 prefix as ain-util returns)
  address: string;     // checksum address
}

export function createIdentity(): Identity {
  const priv = randomBytes(32);
  const pub = ainUtil.privateToPublic(priv);
  const address = ainUtil.toChecksumAddress(ainUtil.bufferToHex(ainUtil.pubToAddress(pub)));
  return { privateKey: priv.toString('hex'), publicKey: pub.toString('hex'), address };
}

export function identityFromPrivateKey(privHex: string): Identity {
  const priv = Buffer.from(privHex.replace(/^0x/, ''), 'hex');
  const pub = ainUtil.privateToPublic(priv);
  const address = ainUtil.toChecksumAddress(ainUtil.bufferToHex(ainUtil.pubToAddress(pub)));
  return { privateKey: priv.toString('hex'), publicKey: pub.toString('hex'), address };
}

export function signMessage(message: string, privHex: string): string {
  return ainUtil.ecSignMessage(message, Buffer.from(privHex.replace(/^0x/, ''), 'hex'));
}

export function verifyMessage(message: string, signature: string, address: string): boolean {
  try {
    return ainUtil.ecVerifySig(message, signature, address);
  } catch {
    return false;
  }
}

/**
 * ─── HUMANS SIGN EIP-191, KEYS SIGN AIN ───────────────────────────────────────────────────────────────────
 *
 * `verifyMessage` above is the product's universal scheme and it is deliberately NOT widened. It verifies
 * teach headers, delegations, publish claims, x402 payment proofs, p2p headers and every local-ledger record —
 * all of them produced by a key this product generated, several of them firing per minute. Making that one
 * function accept a second signature shape would widen every one of those surfaces at once.
 *
 * What a browser wallet gives us is different in kind: a PERSON, present, approving one thing, with a prompt
 * in front of them. That happens a handful of times — sign-in, claiming a node, approving a device — so it
 * gets its own verifier and its own call sites.
 *
 * The two schemes differ twice over, and both differences are fatal to interop:
 *
 *   AIN      keccak256(keccak256( varint(26) ‖ 'AINetwork Signed Message:\n' ‖ varint(str.length) ‖ bytes ))
 *            wire: 0x ‖ hash(32) ‖ r(32) ‖ s(32) ‖ v(1)   — the digest travels WITH the signature
 *   EIP-191  keccak256( '\x19Ethereum Signed Message:\n' ‖ byteLength ‖ bytes )
 *            wire: 0x ‖ r(32) ‖ s(32) ‖ v(1)              — 65 bytes, no embedded digest
 *
 * Note the length: AIN counts UTF-16 code units (JS `.length`), EIP-191 counts UTF-8 bytes. For "한글" that is
 * 2 against 6, so a Korean message hashes differently even before the prefix is considered.
 *
 * The ADDRESS is the same in both worlds — same curve, same keccak-of-pubkey derivation — which is the whole
 * reason this works: a MetaMask account names exactly one AIN address. Measured, not assumed: the same private
 * key yields 0x00ADEc28… under both `privateToAddress` and Ethereum's rules.
 */

/** The EIP-191 personal-message digest MetaMask signs. Byte length, not string length. */
export function hashEip191(message: string): Buffer {
  const bytes = Buffer.from(message, 'utf8');
  return ainUtil.keccak(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${bytes.length}`, 'utf8'), bytes])) as Buffer;
}

/**
 * Did `address` sign `message` with a browser wallet (MetaMask and every EIP-1193 wallet)?
 *
 * Rejects anything that is not a bare 65-byte signature, so an AIN signature — which carries its own 32-byte
 * digest in front and is therefore 97 bytes — cannot be smuggled in here and silently verified under the wrong
 * rules. `v` is accepted as 27/28 (what wallets send) or 0/1 (what some libraries send).
 */
export function verifyEip191(message: string, signature: string, address: string): boolean {
  try {
    const raw = Buffer.from(signature.replace(/^0x/, ''), 'hex');
    if (raw.length !== 65) return false;
    const r = raw.subarray(0, 32);
    const s = raw.subarray(32, 64);
    const vRaw = raw[64]!;
    const v = vRaw >= 27 ? vRaw : vRaw + 27;
    if (v !== 27 && v !== 28) return false;
    const pub = ainUtil.ecRecoverPub(hashEip191(message), r, s, v);
    const recovered = ainUtil.toChecksumAddress(ainUtil.bufferToHex(ainUtil.pubToAddress(pub.subarray(1))));
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Which scheme produced a signature. The definition lives in `scheme.ts`, which imports nothing, because
 * `delegation.ts` needs the same name and that file is what keeps node:crypto out of the browser bundle.
 */
export type AuthScheme = SignatureScheme;

/**
 * Verify a signature under a NAMED scheme.
 *
 * The scheme is always stated by the caller and never guessed from the signature's shape. A verifier that
 * tried both would accept whichever passed, which means an attacker picks the scheme — and the two have
 * different security properties at the call site (a wallet prompt a human saw, versus a key acting on its own).
 */
export function verifyAuth(scheme: AuthScheme, message: string, signature: string, address: string): boolean {
  return scheme === 'eip191' ? verifyEip191(message, signature, address) : verifyMessage(message, signature, address);
}

export function isAddress(value: string): boolean {
  try {
    return ainUtil.isValidAddress(value);
  } catch {
    return false;
  }
}

export function checksum(address: string): string {
  return ainUtil.toChecksumAddress(address);
}


