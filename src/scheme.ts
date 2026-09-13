/**
 * Which rules a signature was made under. One name, in a file that imports nothing, because both sides need it.
 *
 * `ain` is `@ainblockchain/ain-util`'s personal-message scheme: keccak256 twice over a length-prefixed message,
 * with the length counted in UTF-16 code units, and a 97-byte wire form that carries its own digest. Every key
 * this product generates signs that way — teaching keys, node identities, the CLI.
 *
 * `eip191` is what a browser wallet produces for `personal_sign`: keccak256 once over
 * `\x19Ethereum Signed Message:\n<byte length>`, UTF-8, and a bare 65-byte r‖s‖v. MetaMask signs only this.
 *
 * Same curve and the same address from one key, so the two are easy to mistake for interchangeable. They are not:
 * a signature valid under one verifies under neither the other's rules. And they do not mean the same thing —
 * `eip191` says a person read a prompt and approved it, `ain` says a key acted on its own — which is why the
 * scheme travels as a NAME beside the signature and is never inferred from its shape. A verifier that tried both
 * would let whoever presents a signature choose which of those two claims gets recorded.
 *
 * It lives here rather than in `identity.ts` because `delegation.ts` needs it and imports nothing on purpose:
 * that file is what keeps `node:crypto` and ain-js out of the browser bundle.
 */
export type SignatureScheme = 'ain' | 'eip191';

/** The scheme a header or body means when it names none. Everything written before schemas existed is `ain`. */
export const DEFAULT_SCHEME: SignatureScheme = 'ain';

/** Narrow an untrusted string to a scheme, or null. Never defaults: a caller that sent junk did not mean `ain`. */
export function asScheme(value: unknown): SignatureScheme | null {
  return value === 'ain' || value === 'eip191' ? value : null;
}
