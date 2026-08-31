/**
 * Node identity = an AIN blockchain account (secp256k1). We reuse @ainblockchain/ain-util
 * exactly like the original ainize-cli did for request signing (ecSignMessage / ecVerifySig),
 * so a node's signature over a ledger record is verifiable by any peer with only the address.
 */
import { createRequire } from 'node:module';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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

/** Operator password hashing (scrypt) for the web console login. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, saltHex, keyHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
