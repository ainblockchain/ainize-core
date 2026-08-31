import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createIdentity, identityFromPrivateKey } from './identity.js';
import type { NodeConfig, NodeRole, TeachConfig } from './types.js';

export const VERSION = '0.1.0';
export const DEFAULT_HOME = process.env.NGRAM_HOME ?? join(homedir(), '.ngram');

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
  contributorShare: 0.7,
  draftTtlDays: 7,
  backend: 'gradient',
  trainer: { container: 'flashtrain', script: 'train/teach.py', gpus: '4,5,6', maxSteps: 20, timeoutMs: 1_800_000, minFreeGpuMb: 20_000, idleStopMin: 30 },
  locality: { prompts: DEFAULT_LOCALITY_PROMPTS, minSame: 11 },
};

/** Effective teach config: `cfg.teach` merged over the defaults (older config.json files have no `teach` block). */
export function teachConfig(cfg: Pick<NodeConfig, 'teach'>): TeachConfig {
  const t = (cfg.teach ?? {}) as Partial<TeachConfig>;
  return {
    ...DEFAULT_TEACH_CONFIG, ...t,
    trainer: { ...DEFAULT_TEACH_CONFIG.trainer, ...(t.trainer ?? {}) },
    locality: { ...DEFAULT_TEACH_CONFIG.locality, ...(t.locality ?? {}) },
  };
}

export function defaultConfig(opts: InitOptions = {}): NodeConfig {
  const home = opts.home ?? DEFAULT_HOME;
  const identity = opts.privateKey ? identityFromPrivateKey(opts.privateKey) : createIdentity();
  const ledger = opts.ledger ?? 'local';
  return {
    name: opts.name ?? `node-${identity.address.slice(2, 8).toLowerCase()}`,
    dataDir: join(home, 'data'),
    port: opts.port ?? 3402,
    host: opts.host ?? '0.0.0.0',
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
      hookApi: 'http://localhost:8001',
      python: 'python3',
    },
    verifier: { quorum: 2, stake: '5', allowSelfAttest: false, intervalMs: 5000 },
    market: {
      currency: opts.currency ?? (ledger === 'ain' ? 'AIN' : 'CREDIT'),
      defaultPrice: '0.1',
      royaltyShare: 0.3,
      initialCredit: '100',
    },
    teach: structuredClone(DEFAULT_TEACH_CONFIG),
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

/** Environment overrides (handy for docker / multi-node demos). */
export function applyEnv(cfg: NodeConfig, env = process.env): NodeConfig {
  if (env.NGRAM_PORT) cfg.port = Number(env.NGRAM_PORT);
  if (env.NGRAM_HOST) cfg.host = env.NGRAM_HOST;
  if (env.NGRAM_PEERS) cfg.peers = env.NGRAM_PEERS.split(',').map((s) => s.trim()).filter(Boolean);
  if (env.NGRAM_LEDGER === 'ain' || env.NGRAM_LEDGER === 'local') cfg.ledger.kind = env.NGRAM_LEDGER;
  if (env.AIN_PROVIDER_URL) cfg.ledger.ain!.providerUrl = env.AIN_PROVIDER_URL;
  if (env.NGRAM_ROLES) cfg.roles = env.NGRAM_ROLES.split(',') as NodeRole[];
  if (env.NGRAM_PUBLIC_URL) cfg.publicUrl = env.NGRAM_PUBLIC_URL;
  if (env.NGRAM_RUNTIME_REPO) cfg.runtime = { ...cfg.runtime, repo: env.NGRAM_RUNTIME_REPO };
  if (env.NGRAM_RUNTIME_API) cfg.runtime = { ...cfg.runtime, api: env.NGRAM_RUNTIME_API };
  if (env.NGRAM_TEACH_BACKEND === 'stub' || env.NGRAM_TEACH_BACKEND === 'gradient') cfg.teach = { ...teachConfig(cfg), backend: env.NGRAM_TEACH_BACKEND };
  if (env.NGRAM_TEACH_ENABLED === '1' || env.NGRAM_TEACH_ENABLED === '0') cfg.teach = { ...teachConfig(cfg), enabled: env.NGRAM_TEACH_ENABLED === '1' };
  return cfg;
}
