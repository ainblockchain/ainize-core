/**
 * The shape of config.json, as a schema the CLI and the node can both check against (review-2 item 123).
 *
 * `ainize config set` used to accept any dotted path and any value with a green tick — `port notanumber`,
 * `verifier.stak 5`, `roles admin`, `market.royaltyShare 47` — and the node then booted on whatever was written.
 * This file is the single description of what a config key is, what type it holds and what range it may take:
 *   • `configField(path)`  — the schema of one dotted key, or null when the key does not exist
 *   • `nearestConfigKey()` — "did you mean …?" for a typo
 *   • `coerceConfigValue()` — turn one command-line string into the type the key actually wants
 *   • `validateConfig()`   — every problem in a whole config.json, for `config set` and for start-up
 *
 * Unknown keys are reported, never silently dropped: a config written by a newer build must still boot on an
 * older one, so start-up treats an unknown key as a warning and a wrong *value* as a refusal.
 */
import { z, type ZodType } from 'zod';

const port = z.number().int('must be a whole number').min(1, 'must be between 1 and 65535').max(65535, 'must be between 1 and 65535');
const share = z.number().min(0, 'must be a fraction between 0 and 1').max(1, 'must be a fraction between 0 and 1');
const positive = z.number().int('must be a whole number').min(1, 'must be at least 1');
const nonNegative = z.number().int('must be a whole number').min(0, 'must not be negative');
/** Money is a decimal string everywhere in this product (anchors, receipts, the ledger) — never a JSON number. */
const amount = z.string().regex(/^\d+(\.\d+)?$/, 'must be a decimal amount in quotes, e.g. "0.1"');
const url = z.string().url('must be an http(s) URL');
/** An interface to bind: an IPv4/IPv6 literal or a resolvable-looking hostname — not `999.999.999.999`. */
const host = z.string().refine((v) => {
  if (v === 'localhost' || v === '::' || /^[0-9a-fA-F:]+$/.test(v) && v.includes(':')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v.split('.').every((o) => Number(o) <= 255);
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(v);
}, 'must be an interface to bind: an IP address (0.0.0.0, 127.0.0.1, ::) or a hostname');

export const ROLES = ['seller', 'verifier', 'serving', 'gateway'] as const;

const effortPreset = z.object({ maxSteps: positive, evalEvery: positive });

const teachSchema = z.object({
  enabled: z.boolean(),
  publish: z.enum(['review', 'auto', 'never']),
  factsPerJob: positive,
  jobsPerKeyPerDay: nonNegative,
  jobsPerIpPerDay: nonNegative,
  queueMax: nonNegative,
  contributorShare: share,
  draftTtlDays: positive,
  backend: z.enum(['gradient', 'stub']),
  stubOffline: z.boolean().optional(),
  trainer: z.object({
    container: z.string(),
    script: z.string(),
    gpus: z.string(),
    maxSteps: positive,
    timeoutMs: positive,
    minFreeGpuMb: nonNegative,
    idleStopMin: nonNegative,
    /**
     * The two knobs that decide peak GPU memory. Unset, each is derived from the question count — and both
     * derivations give the LARGEST value to the LARGEST lesson, which is backwards: memory scales with these,
     * not with the row count, so they raise the pressure exactly on the runs that take hours to reach the point
     * of failing. A 119-question lesson got micro 64 and 60 contrast pairs and died at the first training step,
     * twice, an hour into each attempt.
     *
     * `maxContrast` is a real trade and not free head room: contrast is the regulariser that protects unrelated
     * answers, so fewer pairs means less protection. The trainer's notes are written around 24 for 120 facts.
     */
    microBatch: z.number().int().min(1).max(512).optional(),
    maxContrast: z.number().int().min(1).max(512).optional(),
  }),
  locality: z.object({ prompts: z.array(z.string()), minSame: nonNegative }),
  dataset: z.object({
    maxBytes: positive,
    maxSourceLines: positive,
    maxRows: positive,
    perKeyPerDay: nonNegative,
    keptPerKey: nonNegative,
    rowsPerKeyPerDay: nonNegative,
    rowsPerIpPerDay: nonNegative,
    bytesPerKeyPerDay: nonNegative,
    ttlDays: positive,
    stagedTtlHours: positive,
    createsPerIpPerMin: nonNegative,
    declarationRows: nonNegative,
  }),
  rowsPerJob: z.object({ floorGradient: positive, floorStub: positive, ceiling: positive, safetyFactor: positive }),
  effort: z.object({ quick: effortPreset, balanced: effortPreset, thorough: effortPreset, lr: z.number().min(0, 'must not be negative') }),
  check: z.object({
    callBudget: positive, sampleRows: positive, chatFormRows: positive, parentSamplesMax: nonNegative,
    lockTargetMs: positive, lockAbortMs: positive,
    /** how long a lesson waits for a BUSY shared model before it is saved unchecked (item 244) */
    lockGraceMs: positive.optional(),
  }),
  preflight: z.object({ sampleRows: positive, perCall: positive }),
  queuedRowsMax: positive,
  /** run the live side-effect check on a placeholder lesson from the demo trainer (item 247) */
  checkStubLessons: z.boolean().optional(),
  /** teaching keys this node does not ration (item 246) */
  trustedKeys: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be an AIN address (0x + 40 hex)')).optional(),
  /** feature flag — `ainize config set teach.lineage true` (lineage design §18) */
  lineage: z.boolean().optional(),
});

export const nodeConfigSchema = z.object({
  name: z.string().min(1, 'must not be empty'),
  dataDir: z.string().min(1, 'must not be empty'),
  port,
  host,
  publicUrl: url.optional(),
  roles: z.array(z.enum(ROLES)).min(1, 'must name at least one of seller, verifier, serving, gateway'),
  peers: z.array(url),
  ledger: z.object({
    kind: z.enum(['local', 'ain']),
    ain: z.object({
      providerUrl: url,
      eventHandlerUrl: url.nullable().optional(),
      chainId: nonNegative,
      appName: z.string().min(1, 'must not be empty'),
    }).optional(),
  }),
  identity: z.object({ privateKey: z.string(), address: z.string(), publicKey: z.string() }),
  /**
   * REMOVED. Still parsed so an existing config.json loads, and ignored everywhere.
   *
   * The operator was a password from the beginning, and in a product whose entire identity model is "a key signs
   * for itself" it was the one shared secret left: typed into a browser, stored as a hash by the thing it
   * protects, and unrotatable without signing everyone out. Sign-in is a signature now — the node's own key
   * always, and whatever `operatorAddresses` lists.
   *
   * Left in the schema on purpose. Dropping it would make every node that has one fail to start, which is a
   * worse failure than carrying a dead field for a version.
   */
  operatorPasswordHash: z.string().optional(),
  /**
   * Addresses that may sign in as this node's operator instead of typing the password.
   *
   * The node's OWN address is always allowed and is not listed here — whoever holds the node's key already owns
   * everything the node published, so requiring them to also type a password protects nothing. This list is for
   * the other people: an AIN Wallet address on a laptop, a colleague, a second machine.
   *
   * Empty (the default) means signature sign-in is the node's own key only. It is never a way IN for a stranger:
   * an address has to be put here by someone who already has operator access.
   */
  operatorAddresses: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).optional(),
  runtime: z.object({
    repo: z.string().optional(),
    api: url.optional(),
    hookApi: url.optional(),
    python: z.string().optional(),
    patchDir: z.string().optional(),
    /** GPUs the serving instance occupies, e.g. "4,5" — checked against teach.trainer.gpus (item 145) */
    gpus: z.string().optional(),
    sampling: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  verifier: z.object({
    quorum: positive,
    /**
     * Sell knowledge that has NOT met the quorum, at the buyer's risk (ANNOUNCED / VERIFYING).
     *
     * Off by default, and it does not touch the status: an unverified anchor stays ANNOUNCED and is never
     * relabelled VERIFIED. Verification is the one quality signal this marketplace has, and a status that says
     * "verified" when nobody checked would be worth less than no status at all. What this permits is a buyer
     * deciding, with the attestation count in front of them, to take the risk anyway — which is a different
     * thing from the network pretending the risk is not there.
     */
    sellUnverified: z.boolean().optional(),
    /** @deprecated never escrowed (item 127) — kept so configs written before 2026-09 still validate */
    stake: amount.optional(),
    allowSelfAttest: z.boolean(),
    intervalMs: positive,
    auto: z.boolean().optional(),
    /** stop attesting below this balance on a gas-charging chain (item 341); 0 = never stop */
    minBalance: z.number().min(0, 'must not be negative').optional(),
    /** What this node will spend verifying other people's knowledge (items 332 / 333 / 336). */
    includeTest: z.boolean().optional(),
    minPrice: amount.optional(),
    maxPerHour: z.number().int().min(0).optional(),
    maxModelMinutesPerHour: z.number().min(0).optional(),
    window: z.object({ from: z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM'), to: z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM') }).nullable().optional(),
    retainBodies: z.boolean().optional(),
  }).optional(),
  market: z.object({
    currency: z.enum(['AIN', 'CREDIT']),
    defaultPrice: amount,
    royaltyShare: share,
    /** fraction of the seller side paid to the verifiers that attested each sale (item 325); floored at NETWORK_MIN_VERIFIER_SHARE */
    verifierShare: share.optional(),
    initialCredit: amount,
    /** how many addresses this node will hand starting credit to before it stops issuing (item 364) */
    creditGrants: positive.optional(),
  }),
  /** What this node accepts from peer exchange (items 136/137). */
  p2p: z.object({
    acceptExchange: z.boolean().optional(),
    /**
     * Hold blobs that other nodes offer, so a node with no reachable address can still be a seller.
     *
     * Every blob transfer in this protocol is a PULL: a verifier or a buyer goes to whoever holds the bytes
     * (`GET /p2p/blob/:sha`). That works perfectly for a consumer behind a firewall — it is the one making
     * the outbound connection — and not at all for a publisher, because the verifier has to reach IN. The
     * anchor gossips fine, the catalogue shows it, and it sits at ANNOUNCED for ever because nobody can
     * fetch the body. No error is raised anywhere, which is what makes it the most confusing way to fail.
     *
     * With this on, a publisher offers the bytes to a reachable peer (`POST /p2p/blob/:sha`), that peer
     * becomes a holder, and `holders()` hands it to every fetcher unchanged. Accepting is safe because the
     * content is checked against the sha256 the signed anchor already names — a relay cannot be made to
     * serve something other than what the author published.
     *
     * `maxRelayBytes` caps what this node will store on others' behalf; 0 or unset means the feature is off.
     */
    relayBlobs: z.boolean().optional(),
    maxRelayBytes: nonNegative.optional(),
    maxPeers: nonNegative.optional(),
    evictAfterFailures: nonNegative.optional(),
    staleDays: nonNegative.optional(),
  }).optional(),
  server: z.object({ trustProxy: z.union([z.boolean(), z.number(), z.string(), z.array(z.string())]) .optional() }).optional(),
  events: z.object({ retentionDays: positive }).optional(),
  teach: teachSchema.optional(),
  gossipIntervalMs: positive,
  version: z.string().min(1, 'must not be empty'),
  includeTestAnchors: z.boolean().optional(),
});

/** Keys `config set` refuses to touch: the identity is the node's only key pair, the hash is set by `login`. */
export const PROTECTED_CONFIG_KEYS = ['identity', 'identity.privateKey', 'identity.address', 'identity.publicKey', 'operatorPasswordHash'];

// ------------------------------------------------------------------ schema introspection

type AnyZod = ZodType & { def: { type: string; innerType?: AnyZod; shape?: Record<string, AnyZod>; element?: AnyZod; entries?: Record<string, string>; options?: AnyZod[] } };

/** Strip optional / nullable / default wrappers to reach the type that actually describes the value. */
function unwrap(s: AnyZod): AnyZod {
  let cur = s;
  for (let i = 0; i < 8 && cur?.def?.innerType; i++) cur = cur.def.innerType;
  return cur;
}

/** The schema of one dotted config key, or null when no such key exists. */
export function configField(path: string): AnyZod | null {
  let cur = unwrap(nodeConfigSchema as unknown as AnyZod);
  for (const seg of path.split('.')) {
    const shape = cur?.def?.shape;
    if (!shape || !(seg in shape)) return null;
    cur = unwrap(shape[seg] as AnyZod);
  }
  return cur ?? null;
}

/** Every dotted key the config knows, leaves and the objects above them. */
export function configKeys(): string[] {
  const out: string[] = [];
  const walk = (s: AnyZod, prefix: string) => {
    const shape = unwrap(s)?.def?.shape;
    if (!shape) return;
    for (const [k, v] of Object.entries(shape)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.push(p);
      walk(v as AnyZod, p);
    }
  };
  walk(nodeConfigSchema as unknown as AnyZod, '');
  return out;
}

const distance = (a: string, b: string): number => {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
};

/** The closest known key to a typo, or null when nothing is close enough to suggest. */
export function nearestConfigKey(key: string): string | null {
  const lower = key.toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const k of configKeys()) {
    // a pure case difference (market.defaultprice) is the commonest typo of all — always suggest it
    const d = k.toLowerCase() === lower ? 0.5 : distance(lower, k.toLowerCase());
    if (d < bestScore) { bestScore = d; best = k; }
  }
  return best !== null && bestScore <= Math.max(2, Math.ceil(key.length / 3)) ? best : null;
}

/** A human name for what a key holds, for the "expected" half of an error message. */
export function configFieldType(field: AnyZod): string {
  const t = field.def.type;
  if (t === 'enum') return `one of ${Object.values(field.def.entries ?? {}).map((v) => `'${v}'`).join(', ')}`;
  if (t === 'array') {
    const el = unwrap(field.def.element as AnyZod);
    return el?.def?.type === 'enum' ? `a comma list of ${Object.values(el.def.entries ?? {}).map((v) => `'${v}'`).join(', ')}` : 'a comma list';
  }
  if (t === 'union') return 'a boolean, number or string';
  if (t === 'object') return 'an object (set its keys one at a time)';
  return `a ${t}`;
}

/**
 * Turn one command-line string into the type the key wants. Unlike a guessing parser this never stores a number
 * where the product uses a string (prices) or a string where it uses a number.
 */
export function coerceConfigValue(field: AnyZod, raw: string): unknown {
  const t = field.def.type;
  if (t === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
  if (t === 'number') { const n = Number(raw); return raw.trim() !== '' && Number.isFinite(n) ? n : raw; }
  if (t === 'array') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (t === 'union') {
    if (raw === 'true' || raw === 'false') return raw === 'true';
    const n = Number(raw);
    return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
  }
  if (t === 'object' || t === 'record') { try { return JSON.parse(raw); } catch { return raw; } }
  if (raw === 'null') return null;
  return raw;
}

export interface ConfigProblem { key: string; message: string; kind: 'invalid' | 'unknown' }

/**
 * Every problem in a config object: values that break the schema (`invalid`) and keys the schema has never
 * heard of (`unknown`). Start-up refuses on `invalid` and only warns about `unknown`, so a config written by a
 * newer build still boots here.
 */
export function validateConfig(cfg: unknown): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const res = nodeConfigSchema.safeParse(cfg);
  if (!res.success) {
    for (const issue of res.error.issues) {
      const key = issue.path.join('.') || '(root)';
      // prefer the schema's own wording ("must be a fraction between 0 and 1") over zod's generic type sentence
      const field = configField(key.replace(/\.\d+$/, ''));
      const message = /^must /.test(issue.message) ? issue.message
        : /received undefined$/.test(issue.message) ? 'is missing'
        : `must be ${field ? configFieldType(field) : issue.message}`;
      out.push({ key, message, kind: 'invalid' });
    }
  }
  const known = new Set(configKeys());
  const walk = (o: unknown, prefix: string) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!known.has(p)) { out.push({ key: p, message: `unknown config key${nearestConfigKey(p) ? ` — did you mean '${nearestConfigKey(p)}'?` : ''}`, kind: 'unknown' }); continue; }
      if (configField(p)?.def.type === 'object') walk(v, p);
    }
  };
  walk(cfg, '');
  return out;
}
