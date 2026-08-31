/**
 * Canonical JSON — deterministic serialization used for hashing and signing.
 *
 * Two flavours:
 *  - `canonicalJson`: compact, sorted keys (our native format).
 *  - `pythonJson`: reproduces Python's `json.dumps(obj, sort_keys=True, ensure_ascii=False)`
 *    (", " and ": " separators) so records imported from the reference prototype's
 *    ledger.jsonl re-hash to the same values.
 */
import { createHash } from 'node:crypto';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function sortKeysDeep(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object') {
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = sortKeysDeep(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value as Json;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function pyFloat(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // JS shortest round-trip repr matches Python's repr for doubles except exponent formatting.
  let s = String(n);
  if (s.includes('e')) {
    // Python: 1e-07 style (two-digit exponent, explicit sign)
    const [m, e] = s.split('e');
    const sign = e.startsWith('-') ? '-' : '+';
    const digits = e.replace(/^[-+]/, '').padStart(2, '0');
    s = `${m}e${sign}${digits}`;
  }
  return s;
}

function pyDump(value: Json): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return pyFloat(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyDump).join(', ')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${pyDump(value[k])}`).join(', ')}}`;
}

export function pythonJson(value: unknown): string {
  return pyDump(sortKeysDeep(value));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
