import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createIdentity, identityFromPrivateKey } from './identity.js';
import type { NodeConfig, NodeRole } from './types.js';

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
    verifier: { quorum: 2, stake: '5', allowSelfAttest: false, intervalMs: 5000, auto: true },
    market: {
      currency: opts.currency ?? (ledger === 'ain' ? 'AIN' : 'CREDIT'),
      defaultPrice: '0.1',
      royaltyShare: 0.3,
      initialCredit: '100',
    },
    gossipIntervalMs: 4000,
    version: VERSION,
  };
}

export function loadConfig(home = DEFAULT_HOME): NodeConfig | null {
  const p = configPath(home);
  if (!existsSync(p)) return null;
  const cfg = JSON.parse(readFileSync(p, 'utf8')) as NodeConfig;
  cfg.dataDir = resolve(cfg.dataDir);
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
  return cfg;
}
