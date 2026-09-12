import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createIdentity, identityFromPrivateKey } from './identity.js';
import { NETWORK_MIN_ROYALTY_SHARE, NETWORK_MIN_VERIFIER_SHARE } from './types.js';
import type { NodeConfig, NodeRole, TeachConfig, TeachEffort } from './types.js';

export const VERSION = '0.1.0';

/**
 * When the running code was last built. Measured — the mtime of this very module — never a string frozen into a
 * config file: after an upgrade `version` alone (unchanged for a year) cannot tell two builds apart (item 141).
 *
 * Measured ONCE, when the module is loaded: the file is read then, so that is the code this process runs. A
 * `npm run build` under a running node replaces the file on disk but not the code in memory — stat'ing it again
 * on every call made a node started at 09:04 report the 11:36 build it had never loaded.
 */
const BUILD_STAMP: string | undefined = (() => {
  try { return statSync(fileURLToPath(import.meta.url)).mtime.toISOString(); } catch { return undefined; }
})();
export function buildStamp(): string | undefined { return BUILD_STAMP; }
export const DEFAULT_HOME = process.env.AINIZE_HOME ?? join(homedir(), '.ainize');

export function configPath(home = DEFAULT_HOME): string {
  return join(home, 'config.json');
}

export interface InitOptions {
  home?: string;
  name?: string;
  port?: number;
  host?: string;
  roles?: NodeRole[];
  peers?: string[];
  ledger?: 'local' | 'ain';
  ainProviderUrl?: string;
  ainEventUrl?: string | null;
  ainChainId?: number;
  privateKey?: string;
  runtimeRepo?: string;
  runtimeApi?: string;
  runtimePatchDir?: string;
  currency?: 'AIN' | 'CREDIT';
  publicUrl?: string;
}

/** Twelve fixed locality prompts (prose / code / digits / general knowledge). Greedy answers must stay identical on ≥ minSame. */
export const DEFAULT_LOCALITY_PROMPTS: string[] = [
  'What is the capital of France?',
  'Write one sentence about the ocean.',
  'Translate "good morning" into Spanish.',
  'What is 17 + 25?',
  'Name three primary colors.',
  'Write a Python function that returns the square of a number.',
  'What year did the first human land on the Moon?',
  'Summarize the water cycle in one sentence.',
  'What is the chemical symbol for gold?',
  'List the days of the week.',
  '대한민국의 수도는 어디입니까?',
  '1부터 10까지 더하면 얼마입니까?',
];

/** Teach-mode defaults (spec §7.4): disabled, review-before-publish, gradient trainer in the `flashtrain` container. */
export const DEFAULT_TEACH_CONFIG: TeachConfig = {
  enabled: false,
  publish: 'review',
  factsPerJob: 8,
  jobsPerKeyPerDay: 3,
  jobsPerIpPerDay: 5,
  queueMax: 10,
  activeJobsPerKey: 2,
  contributorShare: 0.7,
  draftTtlDays: 7,
  backend: 'gradient',
  stubOffline: false,
  // `gpus` is deliberately UNSET (item 145). It used to ship as '4,5,6' — a claim about one host that was wrong for
  // the cluster this repo ships, which serves the model on GPUs 4,5: the trainer's own free-memory pre-check then
  // watched the GPUs vLLM was holding and blocked every lesson with a megabyte figure that never named the cause.
  // An operator naming the trainer's GPUs is the only way this can be right, and gradient training refuses without it.
  trainer: { container: 'flashtrain', script: 'train/teach.py', gpus: '', maxSteps: 20, timeoutMs: 1_800_000, minFreeGpuMb: 20_000, idleStopMin: 30 },
  locality: { prompts: DEFAULT_LOCALITY_PROMPTS, minSame: 11 },
  dataset: {
    maxBytes: 4_000_000, maxSourceLines: 50_000, maxRows: 2_000,
    perKeyPerDay: 10, keptPerKey: 20,
    rowsPerKeyPerDay: 300, rowsPerIpPerDay: 500, bytesPerKeyPerDay: 20_000_000,
    ttlDays: 7, stagedTtlHours: 24, createsPerIpPerMin: 10, declarationRows: 100,
  },
  rowsPerJob: { floorGradient: 8, floorStub: 200, ceiling: 1_000, safetyFactor: 2 },
  effort: { quick: { maxSteps: 8, evalEvery: 2 }, balanced: { maxSteps: 20, evalEvery: 2 }, thorough: { maxSteps: 40, evalEvery: 4 }, lr: 2e-3 },
  check: { callBudget: 68, sampleRows: 24, chatFormRows: 8, parentSamplesMax: 20, lockTargetMs: 300_000, lockAbortMs: 480_000, lockGraceMs: 30 * 60_000 },
  preflight: { sampleRows: 24, perCall: 8 },
  queuedRowsMax: 2_000,
  checkStubLessons: false,
  trustedKeys: [],
  lineage: false,
};

/**
 * What a verifier will spend on unpaid work for strangers (items 332 / 333 / 336). Every one of these was
 * unbounded: the round verified hidden test listings, held the shared model in front of the node's own visitors,
 * and kept every body it ever downloaded.
 */
export const DEFAULT_VERIFIER_BUDGET = {
  /**
   * Stop attesting below this balance where the chain charges gas (item 341). An attestation is a write the VERIFIER
   * signs and pays for — the plan's "seller pays gas" cannot hold for a record the verifier signs — so the unpaid
   * role becomes a net-paying one the moment gas is real, and `verifier.auto` would spend the account to nothing,
   * taking announce, settle and payout with it. No effect on the local ledger, which has no gas.
   */
  minBalance: 1,
  includeTest: false,
  minPrice: '0',
  maxPerHour: 40,
  maxModelMinutesPerHour: 10,
  window: null,
  retainBodies: false,
} as const;

/** `cfg.verifier` with the budget defaults filled in (a config.json written before they existed has none of them). */
export function verifierConfig(cfg: Pick<NodeConfig, 'verifier'>): NonNullable<NodeConfig['verifier']> {
  const v = cfg.verifier ?? { quorum: 2, allowSelfAttest: false, intervalMs: 5000 };
  return { ...DEFAULT_VERIFIER_BUDGET, ...v };
}

/** Operator ceiling for `dataset.maxBytes` — a node may not accept an upload larger than this whatever the config says. */
export const DATASET_MAX_BYTES_CEILING = 20_000_000;

/** Effective teach config: `cfg.teach` merged over the defaults (older config.json files have no `teach` block). */
export function teachConfig(cfg: Pick<NodeConfig, 'teach'>): TeachConfig {
  const t = (cfg.teach ?? {}) as Partial<TeachConfig>;
  const d = DEFAULT_TEACH_CONFIG;
  return {
    ...d, ...t,
    trainer: { ...d.trainer, ...(t.trainer ?? {}) },
    locality: { ...d.locality, ...(t.locality ?? {}) },
    dataset: { ...d.dataset, ...(t.dataset ?? {}) },
    rowsPerJob: { ...d.rowsPerJob, ...(t.rowsPerJob ?? {}) },
    effort: {
      ...d.effort, ...(t.effort ?? {}),
      quick: { ...d.effort.quick, ...(t.effort?.quick ?? {}) },
      balanced: { ...d.effort.balanced, ...(t.effort?.balanced ?? {}) },
      thorough: { ...d.effort.thorough, ...(t.effort?.thorough ?? {}) },
    },
    check: { ...d.check, ...(t.check ?? {}) },
    preflight: { ...d.preflight, ...(t.preflight ?? {}) },
    queuedRowsMax: t.queuedRowsMax ?? d.queuedRowsMax,
    checkStubLessons: t.checkStubLessons ?? d.checkStubLessons,
    trustedKeys: t.trustedKeys ?? d.trustedKeys,
    lineage: t.lineage ?? d.lineage,
  };
}

/** One measured lesson, as `teach_stats` records it (design §6.5). Only `backend: 'gradient'` rows may drive a visitor-facing number. */
export interface TeachTimingSample {
  total_s: number;
  load_s: number | null;
  steps: number | null;
  rows_trained: number | null;
  sentences: number | null;
}

/** How many questions per lesson, and whether the number was measured (design §D1). */
export interface RowsPerJobResult {
  rows: number;
  source: 'default' | 'measured' | 'operator';
  /** p50 seconds per question per pass, gradient samples only; null until the fit exists. */
  s_per_row_p50: number | null;
  s_per_row_p90: number | null;
  load_s_p50: number | null;
  samples: number;
}

export const ETA_MIN_SAMPLES = 3;

export function percentileOf(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

/**
 * How many questions one lesson may train on this node (design §D1).
 *
 *   s_per_row_p90 = p90( (total_s − load_s) / (rows_trained × steps) )   over gradient samples only
 *   max_rows      = floor( (timeoutMs/1000 − load_s_p90) / (passes × s_per_row_p90) / safetyFactor )
 *   rowsPerJob    = clamp(floor, max_rows, ceiling)
 *
 * The whole derivation is skipped — the floor is used — while fewer than `ETA_MIN_SAMPLES` gradient samples exist, or
 * while the trainer has not shown that it supports sampled evaluation (design §16: an unsampled eval at 100 questions
 * would spend more time probing than training). An operator override disables the derivation entirely.
 */
export function deriveRowsPerJob(
  cfg: TeachConfig,
  samples: TeachTimingSample[],
  opts: { effort?: TeachEffort; override?: number | null; trainerSupportsSampling?: boolean } = {},
): RowsPerJobResult {
  const floor = cfg.backend === 'stub' ? cfg.rowsPerJob.floorStub : cfg.rowsPerJob.floorGradient;
  const ceiling = Math.max(floor, cfg.rowsPerJob.ceiling);
  const passes = cfg.effort[opts.effort ?? 'balanced'].maxSteps;
  const usable = samples.filter((s) => Number.isFinite(s.total_s) && (s.rows_trained ?? 0) > 0 && (s.steps ?? 0) > 0);
  const perRow = usable.map((s) => (s.total_s - (s.load_s ?? 0)) / (s.rows_trained! * s.steps!)).filter((x) => Number.isFinite(x) && x > 0);
  const loads = usable.map((s) => s.load_s).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const s50 = percentileOf(perRow, 0.5);
  const s90 = percentileOf(perRow, 0.9);
  const l50 = percentileOf(loads, 0.5);
  const base: Omit<RowsPerJobResult, 'rows' | 'source'> = { s_per_row_p50: s50, s_per_row_p90: s90, load_s_p50: l50, samples: perRow.length };
  if (typeof opts.override === 'number' && opts.override > 0) return { rows: Math.min(ceiling, Math.max(1, Math.floor(opts.override))), source: 'operator', ...base };
  if (perRow.length < ETA_MIN_SAMPLES || s90 === null || opts.trainerSupportsSampling !== true) return { rows: floor, source: 'default', ...base };
  const budget_s = cfg.trainer.timeoutMs / 1000 - (l50 ?? 0);
  const maxRows = Math.floor(budget_s / (passes * s90) / Math.max(1, cfg.rowsPerJob.safetyFactor));
  return { rows: Math.min(ceiling, Math.max(floor, maxRows)), source: 'measured', ...base };
}

/** `"4,5"` / `"0,1,2,3"` → a set of GPU indices; anything unparseable is simply not in the set. */
export function gpuSet(spec: string | undefined | null): Set<string> {
  return new Set((spec ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * The GPUs `teach.trainer.gpus` and `runtime.gpus` have in common (item 145).
 *
 * deploy/README states the rule — "never let the two sets overlap: the trainer loads a second copy of the model's
 * memory table and would starve vLLM" — and nothing in the code checked it. The shipped default named the very GPUs
 * the shipped cluster serves on, and the README then invited the operator to switch gradient training on.
 */
export function gpuOverlap(servingGpus: string | undefined | null, trainerGpus: string | undefined | null): string[] {
  const serving = gpuSet(servingGpus);
  return [...gpuSet(trainerGpus)].filter((g) => serving.has(g));
}

/** How long raw `events` rows are kept when the operator has not said otherwise (item 128). */
export const DEFAULT_EVENTS_RETENTION_DAYS = 90;

/**
 * What a fresh node accepts from peer exchange (items 136/137). Discovery stays ON — a marketplace whose nodes only
 * ever talk to a hand-written list is not a network — but it is now bounded, marked and reversible: learned peers
 * are labelled `learned` in `ainize peers ls`, capped at `maxPeers`, dropped when they stop answering, and an
 * endpoint the operator removes stays removed until they add it back.
 */
export const DEFAULT_P2P_CONFIG = { acceptExchange: true, maxPeers: 50, evictAfterFailures: 60, staleDays: 7 };

export function defaultConfig(opts: InitOptions = {}): NodeConfig {
  const home = opts.home ?? DEFAULT_HOME;
  const identity = opts.privateKey ? identityFromPrivateKey(opts.privateKey) : createIdentity();
  const ledger = opts.ledger ?? 'local';
  return {
    name: opts.name ?? `node-${identity.address.slice(2, 8).toLowerCase()}`,
    dataDir: join(home, 'data'),
    port: opts.port ?? 3402,
    // Loopback by default (item 121). Between `start` and the first `login` a node has no operator password, and a
    // node bound to every interface is claimed by whoever scans the port first — `POST /api/auth/setup` hands them
    // a session that can announce, buy, spend the wallet and change the payout address. Going public is a decision
    // the operator makes on purpose: `ainize init --host 0.0.0.0` (or `--public`), or AINIZE_HOST.
    host: opts.host ?? '127.0.0.1',
    publicUrl: opts.publicUrl,
    roles: opts.roles ?? ['seller', 'verifier', 'serving'],
    peers: opts.peers ?? [],
    ledger: {
      kind: ledger,
      ain: {
        providerUrl: opts.ainProviderUrl ?? 'http://localhost:8081',
        eventHandlerUrl: opts.ainEventUrl ?? null,
        chainId: opts.ainChainId ?? 0,
        appName: 'knowledge',
      },
    },
    identity,
    runtime: {
      repo: opts.runtimeRepo ?? (existsSync('/mnt/newdata/qwen3.8') ? '/mnt/newdata/qwen3.8' : undefined),
      api: opts.runtimeApi ?? 'http://localhost:8000',
      patchDir: opts.runtimePatchDir,
      hookApi: 'http://localhost:8001',
      python: 'python3',
    },
    verifier: { quorum: 2, allowSelfAttest: false, intervalMs: 5000, auto: true, ...DEFAULT_VERIFIER_BUDGET },
    market: {
      currency: opts.currency ?? (ledger === 'ain' ? 'AIN' : 'CREDIT'),
      defaultPrice: '0.1',
      royaltyShare: NETWORK_MIN_ROYALTY_SHARE,
      verifierShare: NETWORK_MIN_VERIFIER_SHARE,
      initialCredit: '100',
      creditGrants: 100,
    },
    teach: structuredClone(DEFAULT_TEACH_CONFIG),
    p2p: { ...DEFAULT_P2P_CONFIG },
    server: { trustProxy: false },
    events: { retentionDays: DEFAULT_EVENTS_RETENTION_DAYS },
    gossipIntervalMs: 4000,
    version: VERSION,
  };
}

export function loadConfig(home = DEFAULT_HOME): NodeConfig | null {
  const p = configPath(home);
  if (!existsSync(p)) return null;
  const cfg = JSON.parse(readFileSync(p, 'utf8')) as NodeConfig;
  cfg.dataDir = resolve(cfg.dataDir);
  cfg.teach = teachConfig(cfg);
  return cfg;
}

export function saveConfig(cfg: NodeConfig, home = DEFAULT_HOME): string {
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg.dataDir, { recursive: true });
  const p = configPath(home);
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return p;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Fold the changes a running node made to its own config (`boot` → `live`: the operator password, a peer added or
 * removed in the console, a display name) onto whatever is on disk NOW, instead of writing the node's whole
 * start-up snapshot over it. Without this, one click in the console silently reverted every `ainize config set`
 * made since the node started (item 124).
 */
export function mergeConfigChanges(onDisk: NodeConfig, boot: NodeConfig, live: NodeConfig): NodeConfig {
  const out = structuredClone(onDisk) as unknown as Record<string, unknown>;
  const walk = (b: Record<string, unknown> | undefined, l: Record<string, unknown> | undefined, target: Record<string, unknown>) => {
    for (const k of new Set([...Object.keys(b ?? {}), ...Object.keys(l ?? {})])) {
      const bv = b?.[k];
      const lv = l?.[k];
      if (JSON.stringify(bv) === JSON.stringify(lv)) continue;      // the node did not touch it — the disk wins
      if (lv === undefined) { delete target[k]; continue; }
      if (isPlainObject(bv) && isPlainObject(lv)) {
        if (!isPlainObject(target[k])) target[k] = {};
        walk(bv, lv, target[k] as Record<string, unknown>);
      } else {
        target[k] = structuredClone(lv);
      }
    }
  };
  walk(boot as unknown as Record<string, unknown>, live as unknown as Record<string, unknown>, out);
  return out as unknown as NodeConfig;
}

/** Environment overrides (handy for docker / multi-node demos). */
export function applyEnv(cfg: NodeConfig, env = process.env): NodeConfig {
  if (env.AINIZE_PORT) cfg.port = Number(env.AINIZE_PORT);
  if (env.AINIZE_HOST) cfg.host = env.AINIZE_HOST;
  if (env.AINIZE_PEERS) cfg.peers = env.AINIZE_PEERS.split(',').map((s) => s.trim()).filter(Boolean);
  if (env.AINIZE_LEDGER === 'ain' || env.AINIZE_LEDGER === 'local') cfg.ledger.kind = env.AINIZE_LEDGER;
  if (env.AIN_PROVIDER_URL) cfg.ledger.ain!.providerUrl = env.AIN_PROVIDER_URL;
  if (env.AINIZE_ROLES) cfg.roles = env.AINIZE_ROLES.split(',') as NodeRole[];
  if (env.AINIZE_PUBLIC_URL) cfg.publicUrl = env.AINIZE_PUBLIC_URL;
  if (env.AINIZE_RUNTIME_REPO) cfg.runtime = { ...cfg.runtime, repo: env.AINIZE_RUNTIME_REPO };
  if (env.AINIZE_RUNTIME_API) cfg.runtime = { ...cfg.runtime, api: env.AINIZE_RUNTIME_API };
  if (env.AINIZE_RUNTIME_PATCH_DIR) cfg.runtime = { ...cfg.runtime, patchDir: env.AINIZE_RUNTIME_PATCH_DIR };
  if (env.AINIZE_TEACH_BACKEND === 'stub' || env.AINIZE_TEACH_BACKEND === 'gradient') cfg.teach = { ...teachConfig(cfg), backend: env.AINIZE_TEACH_BACKEND };
  if (env.AINIZE_TEACH_ENABLED === '1' || env.AINIZE_TEACH_ENABLED === '0') cfg.teach = { ...teachConfig(cfg), enabled: env.AINIZE_TEACH_ENABLED === '1' };
  if (env.AINIZE_TRUST_PROXY !== undefined) cfg.server = { ...(cfg.server ?? {}), trustProxy: parseTrustProxy(env.AINIZE_TRUST_PROXY) };
  if (env.AINIZE_TEACH_STUB_OFFLINE === '1' || env.AINIZE_TEACH_STUB_OFFLINE === '0') cfg.teach = { ...teachConfig(cfg), stubOffline: env.AINIZE_TEACH_STUB_OFFLINE === '1' };
  return cfg;
}

/** `AINIZE_TRUST_PROXY`: `0|false` → off, `1|2|…` → hop count, `true` → every proxy (only behind a proxy that overwrites X-Forwarded-For), anything else → Express IP/CIDR/`loopback` list. */
export function parseTrustProxy(v: string): boolean | number | string {
  const s = v.trim();
  if (s === '' || s === '0' || s.toLowerCase() === 'false') return false;
  if (s.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(s)) return Number(s);
  return s;
}
