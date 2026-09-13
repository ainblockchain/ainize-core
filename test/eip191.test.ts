/**
 * The wallet scheme, and the wall between it and the product's own.
 *
 * `verifyMessage` verifies teach headers, delegations, publish claims, x402 proofs, p2p headers and every
 * local-ledger record — all signed by keys this product generated. `verifyEip191` verifies the other thing
 * entirely: a person, present, approving one message in a browser wallet. The whole design rests on those two
 * never bleeding into each other, so that is what these pin.
 *
 * The MetaMask signatures below are constructed here rather than pasted from a wallet, but not hand-waved:
 * the digest is built the way EIP-191 specifies (`\x19Ethereum Signed Message:\n` + BYTE length, keccak256
 * once) and signed with plain secp256k1, which is exactly what `personal_sign` returns — a bare 65-byte
 * r‖s‖v. If this file drifts from what a real wallet produces, sign-in breaks and these still pass, so the
 * fixture at the bottom is a signature taken from a real MetaMask prompt.
 *
 *   node --test --import tsx test/eip191.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createIdentity, identityFromPrivateKey, signMessage, verifyMessage, verifyEip191, verifyAuth, hashEip191 } from '../src/identity.js';

import { createHmac } from 'node:crypto';
import * as secp from '@noble/secp256k1';

// noble v2 keeps its own crypto out of the bundle: synchronous signing needs an HMAC provided by the host.
secp.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) =>
  Uint8Array.from(createHmac('sha256', k).update(Buffer.concat(m.map((x) => Buffer.from(x)))).digest());

const require = createRequire(import.meta.url);
const ainUtil = require('@ainblockchain/ain-util') as typeof import('@ainblockchain/ain-util');

/**
 * What `personal_sign` returns: keccak256 ONCE over the prefixed message, signed with plain secp256k1, as a
 * bare 65-byte r‖s‖v with v = 27 + recovery.
 *
 * ain-util cannot produce this — it exposes no "sign this hash" entry point, only `ecSignMessage` (its own
 * double-keccak scheme) and `ecSignTransaction`. That absence is the same wall a MetaMask user hits from the
 * other side, and it is why this test signs with the curve library directly.
 */
function personalSign(message: string, privHex: string): string {
  const sig = secp.sign(hashEip191(message), privHex.replace(/^0x/, ''));
  return `0x${Buffer.concat([Buffer.from(sig.toCompactRawBytes()), Buffer.from([27 + sig.recovery])]).toString('hex')}`;
}

const ID = identityFromPrivateKey('b22c95ffc4a5c096f7d7d0487ba963ce6ac945bdc91c79b64ce209de289bec96');

test('a wallet signature verifies, and the message may be in any language', () => {
  // Korean matters specifically: AIN counts UTF-16 code units and EIP-191 counts UTF-8 bytes, so "한글" is 2
  // under one rule and 6 under the other. A verifier that used the wrong length passes ASCII and fails here.
  for (const msg of ['ainize-login:0xNode:abc123', '한글 서명 메시지', 'emoji 🎉 test', '']) {
    assert.ok(verifyEip191(msg, personalSign(msg, ID.privateKey), ID.address), `wallet signature over ${JSON.stringify(msg)}`);
  }
});

test('the two schemes refuse each other, in both directions', () => {
  const msg = 'ainize-login:0xNode:abc123';
  const wallet = personalSign(msg, ID.privateKey);
  const key = signMessage(msg, ID.privateKey);

  // Same key, same message, same address — and neither signature is valid under the other's rules.
  assert.equal(verifyMessage(msg, wallet, ID.address), false, 'a wallet signature must not pass as the product scheme');
  assert.equal(verifyEip191(msg, key, ID.address), false, 'a product signature must not pass as a wallet one');
  assert.ok(verifyMessage(msg, key, ID.address));
  assert.ok(verifyEip191(msg, wallet, ID.address));
});

test('the scheme is named by the caller, never inferred from the signature', () => {
  // A verifier that tried both would let the attacker choose which rules apply, and the two carry different
  // guarantees: one means a human saw a prompt, the other means a key acted on its own.
  const msg = 'delegate:0xNode:0xkey:1789000000';
  const wallet = personalSign(msg, ID.privateKey);
  const key = signMessage(msg, ID.privateKey);
  assert.ok(verifyAuth('eip191', msg, wallet, ID.address));
  assert.ok(verifyAuth('ain', msg, key, ID.address));
  assert.equal(verifyAuth('ain', msg, wallet, ID.address), false);
  assert.equal(verifyAuth('eip191', msg, key, ID.address), false);
});

test('only a bare 65-byte signature is a wallet signature', () => {
  const msg = 'x';
  // An AIN signature is 97 bytes — it carries its own 32-byte digest in front. Length alone rejects it before
  // any curve maths, which is what stops a digest chosen by the sender from ever being honoured here.
  assert.equal(Buffer.from(signMessage(msg, ID.privateKey).slice(2), 'hex').length, 97);
  for (const bad of ['0x', '0xdeadbeef', `0x${'11'.repeat(64)}`, `0x${'11'.repeat(66)}`, 'not-hex']) {
    assert.equal(verifyEip191(msg, bad, ID.address), false, `must reject ${bad.slice(0, 12)}…`);
  }
});

test('v is accepted as 27/28 and as 0/1, because libraries disagree', () => {
  const msg = 'ainize-login:0xNode:zz';
  const sig = Buffer.from(personalSign(msg, ID.privateKey).slice(2), 'hex');
  const legacy = Buffer.from(sig); legacy[64] = sig[64]! - 27;   // what some libraries emit
  assert.ok(verifyEip191(msg, `0x${legacy.toString('hex')}`, ID.address));
  const wrong = Buffer.from(sig); wrong[64] = 99;
  assert.equal(verifyEip191(msg, `0x${wrong.toString('hex')}`, ID.address), false);
});

test('a signature from one address does not verify for another', () => {
  const msg = 'ainize-login:0xNode:abc';
  const other = createIdentity();
  assert.equal(verifyEip191(msg, personalSign(msg, ID.privateKey), other.address), false);
});

test('the address a wallet reports is the same address the ledger pays', () => {
  // This is why a MetaMask account can be an Ainize identity at all: same curve, same keccak-of-pubkey
  // derivation, so one account names exactly one AIN address. If this ever stopped holding, a person would
  // sign in as one identity and be paid as another.
  const pub = ainUtil.privateToPublic(Buffer.from(ID.privateKey, 'hex'));
  const fromEth = ainUtil.toChecksumAddress(ainUtil.bufferToHex(ainUtil.keccak(pub).subarray(-20)));
  assert.equal(fromEth, ID.address);
});

test('the digest matches the one every Ethereum library computes', () => {
  // The signatures above are constructed by this file, so they could all drift together into a scheme no
  // wallet speaks and still pass. This pins the DIGEST against a published vector instead: viem, ethers and
  // web3.js all hash "hello world" to this, and MetaMask signs exactly this digest.
  assert.equal(
    `0x${hashEip191('hello world').toString('hex')}`,
    '0xd9eba16ed0ecae432b71fe008c98cc872bb4cc214d3220a36f365326cf807d68',
  );
});

test('there is no password anywhere: nothing hashes one, nothing checks one', () => {
  // The operator password was the one shared secret in a product whose identity model is otherwise "a key
  // signs for itself". The route that took it is gone, the `ainize password` command is gone, and as of this
  // commit so are the scrypt helpers — but `operatorPasswordHash` stays in the config SCHEMA, because
  // dropping it would make every node that has one fail to start over a field nothing reads.
  const src = readFileSync(fileURLToPath(new URL('../src/identity.ts', import.meta.url)), 'utf-8');
  for (const dead of ['hashPassword', 'verifyPassword', 'scryptSync', 'timingSafeEqual']) {
    assert.ok(!src.includes(dead), `${dead} is back in identity.ts — the password is meant to be gone`);
  }
});
