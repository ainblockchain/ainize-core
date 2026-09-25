/**
 * Teach-mode config (teach mode v2): a config.json written before datasets existed must still load, gain every new
 * block filled with the defaults, and produce a `rowsPerJob` that is the conservative floor until real training runs
 * were measured on THIS node with the gradient backend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TEACH_CONFIG, DATASET_MAX_BYTES_CEILING, ETA_MIN_SAMPLES, buildStamp, coerceConfigValue, configField, configFieldType, defaultConfig,
  deriveRowsPerJob, loadConfig, mergeConfigChanges, nearestConfigKey, percentileOf, teachConfig, validateConfig,
  type NodeConfig, type TeachConfig, type TeachTimingSample,
} from '../src/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-config-test-'));

test('active teach jobs per key keeps the default and allows an explicit parallel workload', () => {
  assert.equal(teachConfig({ teach: undefined }).activeJobsPerKey, 2);
  const field = configField('teach.activeJobsPerKey');
  assert.ok(field);
  assert.equal(field.parse(70), 70);
  for (const invalid of [0, -1, 1.5, 1001, '70']) assert.equal(field.safeParse(invalid).success, false);
  assert.equal(teachConfig({ teach: { activeJobsPerKey: 70 } as TeachConfig }).activeJobsPerKey, 70);
});

test('a v1 config.json (no dataset / effort / check blocks) loads and gains every v2 default', () => {
  const home = join(tmp, 'v1');
  mkdirSync(home, { recursive: true });
  // exactly what a node written before teach mode v2 has on disk: the v1 teach block, nothing else
  const v1: Record<string, unknown> = {
    name: 'old-node', dataDir: join(home, 'data'), port: 3402, host: '0.0.0.0', roles: ['seller'], peers: [],
    ledger: { kind: 'local' }, identity: { privateKey: '00'.repeat(32), address: '0x' + '11'.repeat(20), publicKey: '0x' },
    market: { currency: 'CREDIT', defaultPrice: '0.1', royaltyShare: 0.3, initialCredit: '100' },
    teach: { enabled: true, publish: 'review', factsPerJob: 8, jobsPerKeyPerDay: 3, jobsPerIpPerDay: 5, queueMax: 10, contributorShare: 0.7, draftTtlDays: 7, backend: 'gradient', trainer: { container: 'flashtrain', script: 'train/teach.py', gpus: '4,5,6', maxSteps: 20, timeoutMs: 1_800_000, minFreeGpuMb: 20_000, idleStopMin: 30 }, locality: { prompts: ['a'], minSame: 1 } },
    gossipIntervalMs: 4000, version: '0.1.0',
  };
  writeFileSync(join(home, 'config.json'), JSON.stringify(v1));
  const cfg = loadConfig(home)!;
  const t = cfg.teach!;
  assert.equal(t.enabled, true, 'the v1 values survive');
  assert.equal(t.factsPerJob, 8);
  assert.deepEqual(t.locality, { prompts: ['a'], minSame: 1 }, 'a v1 override of a nested block is not overwritten by the defaults');
  assert.deepEqual(t.dataset, DEFAULT_TEACH_CONFIG.dataset, 'the whole dataset block is filled');
  assert.deepEqual(t.rowsPerJob, { floorGradient: 8, floorStub: 200, ceiling: 1000, safetyFactor: 2 });
  assert.deepEqual(t.effort.balanced, { maxSteps: 20, evalEvery: 2 }, 'balanced = the v1 trainer.maxSteps default');
  assert.equal(t.effort.lr, 2e-3);
  assert.equal(t.check.callBudget, 68);
  assert.equal(t.preflight.sampleRows, 24);
  assert.equal(t.queuedRowsMax, 2000);
  assert.equal(t.dataset.maxBytes, 4_000_000);
  assert.ok(t.dataset.maxBytes < DATASET_MAX_BYTES_CEILING, 'the default is well under the operator ceiling');
});

test('teachConfig merges each nested block key by key, so a partial override keeps the other defaults', () => {
  const merged = teachConfig({ teach: { dataset: { maxRows: 50 }, effort: { quick: { maxSteps: 3 } } } as unknown as TeachConfig });
  assert.equal(merged.dataset.maxRows, 50);
  assert.equal(merged.dataset.maxBytes, DEFAULT_TEACH_CONFIG.dataset.maxBytes, 'the rest of the dataset block is untouched');
  assert.deepEqual(merged.effort.quick, { maxSteps: 3, evalEvery: 2 });
  assert.deepEqual(merged.effort.thorough, DEFAULT_TEACH_CONFIG.effort.thorough);
  // defaultConfig() writes the whole v2 shape for a fresh node
  const fresh: NodeConfig = defaultConfig({ home: join(tmp, 'fresh') });
  assert.deepEqual(fresh.teach!.dataset, DEFAULT_TEACH_CONFIG.dataset);
});

test('rowsPerJob: the floor until it is measured, derived from trainer.timeoutMs after that, always clamped', () => {
  const cfg = teachConfig({ teach: undefined });
  const sample = (total_s: number, rows: number, steps: number, load_s = 10): TeachTimingSample => ({ total_s, load_s, steps, rows_trained: rows, sentences: rows * 4 });

  // 1) no samples → the floor, and the floor is the v1 factsPerJob
  const none = deriveRowsPerJob(cfg, [], { trainerSupportsSampling: true });
  assert.equal(none.rows, 8); assert.equal(none.source, 'default'); assert.equal(none.samples, 0);
  assert.equal(none.rows, cfg.factsPerJob);

  // 2) fewer than ETA_MIN_SAMPLES → still the floor (three measured lessons is the bar everywhere in this design)
  assert.equal(ETA_MIN_SAMPLES, 3);
  const two = deriveRowsPerJob(cfg, [sample(100, 8, 20), sample(110, 8, 20)], { trainerSupportsSampling: true });
  assert.equal(two.rows, 8); assert.equal(two.source, 'default');

  // 3) enough samples, but the trainer has not shown it evaluates a sample → still the floor (design §16)
  const many = [sample(100, 8, 20), sample(110, 8, 20), sample(105, 8, 20)];
  assert.equal(deriveRowsPerJob(cfg, many, {}).rows, 8, 'an unsampled eval at 100 questions would cost more than the training');
  assert.equal(deriveRowsPerJob(cfg, many, { trainerSupportsSampling: false }).source, 'default');

  // 4) measured: (1800 s − 10 s load) / (20 passes × s_per_row_p90) / 2
  const fit = deriveRowsPerJob(cfg, many, { trainerSupportsSampling: true });
  assert.equal(fit.source, 'measured');
  assert.equal(fit.samples, 3);
  const sPerRow = (105 - 10) / (8 * 20);                       // the p90 of {100, 105, 110} s over 8 questions x 20 steps
  assert.equal(fit.s_per_row_p90, sPerRow);
  assert.equal(fit.load_s_p50, 10);
  assert.equal(fit.rows, Math.floor((1800 - 10) / (20 * sPerRow) / 2));
  assert.ok(fit.rows > 8 && fit.rows <= cfg.rowsPerJob.ceiling);

  // 5) a job can never be created that is always killed at the timeout
  const passes = cfg.effort.balanced.maxSteps;
  assert.ok(fit.rows * passes * fit.s_per_row_p90! + fit.load_s_p50! <= cfg.trainer.timeoutMs / 1000, 'the cap fits inside trainer.timeoutMs');

  // 6) very fast samples clamp at the ceiling, very slow ones never fall below the floor
  const fast = deriveRowsPerJob(cfg, [sample(11, 100, 20, 10), sample(11, 100, 20, 10), sample(11, 100, 20, 10)], { trainerSupportsSampling: true });
  assert.equal(fast.rows, cfg.rowsPerJob.ceiling);
  const slow = deriveRowsPerJob(cfg, [sample(3610, 1, 1, 10), sample(3610, 1, 1, 10), sample(3610, 1, 1, 10)], { trainerSupportsSampling: true });
  assert.equal(slow.rows, 8, 'the floor holds even when one question would not fit in the timeout');

  // 7) thorough (40 passes) allows fewer questions than quick (8) for the same measurements
  const quick = deriveRowsPerJob(cfg, many, { effort: 'quick', trainerSupportsSampling: true });
  const thorough = deriveRowsPerJob(cfg, many, { effort: 'thorough', trainerSupportsSampling: true });
  assert.ok(quick.rows > thorough.rows);

  // 8) an operator override wins and disables the derivation
  const forced = deriveRowsPerJob(cfg, many, { override: 25, trainerSupportsSampling: true });
  assert.equal(forced.rows, 25); assert.equal(forced.source, 'operator');
  assert.equal(deriveRowsPerJob(cfg, [], { override: 5000 }).rows, cfg.rowsPerJob.ceiling, 'an override is still clamped to the ceiling');

  // 9) a stub node starts at its own floor — a stub job costs no GPU
  const stub = teachConfig({ teach: { backend: 'stub' } as unknown as TeachConfig });
  assert.equal(deriveRowsPerJob(stub, [], {}).rows, 200);

  // 10) samples with no rows_trained / steps (rows written before the migration) are ignored, not guessed at
  const legacy: TeachTimingSample[] = [{ total_s: 100, load_s: null, steps: null, rows_trained: null, sentences: null }];
  assert.equal(deriveRowsPerJob(cfg, legacy, { trainerSupportsSampling: true }).rows, 8);
});

test('percentileOf is the p50/p90 the whole design quotes', () => {
  assert.equal(percentileOf([], 0.5), null);
  assert.equal(percentileOf([5], 0.9), 5);
  assert.equal(percentileOf([3, 1, 2], 0.5), 2);
  assert.equal(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
});

process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// ------------------------------------------------------------------ the config schema (review-2 item 123)

test('every config this product writes validates, and a v1 config without the teach block does too', () => {
  assert.deepEqual(validateConfig(defaultConfig({ home: join(tmp, 'schema') })), []);
  const home = join(tmp, 'v1');
  assert.deepEqual(validateConfig(loadConfig(home)!), []);
});

test('validateConfig names every value the node cannot boot on, and only warns about keys it does not know', () => {
  const cfg = defaultConfig({ home: join(tmp, 'bad') }) as unknown as Record<string, unknown>;
  cfg.port = 'notanumber';
  cfg.roles = ['admin'];
  cfg.host = '999.999.999.999';
  (cfg.market as Record<string, unknown>).royaltyShare = 47;
  (cfg.verifier as Record<string, unknown>).quorum = -3;
  cfg.strayKey = 'hello';
  const problems = validateConfig(cfg);
  const byKey = Object.fromEntries(problems.map((p) => [p.key, p]));
  assert.equal(byKey['port'].message, 'must be a number');
  assert.equal(byKey['roles.0'].kind, 'invalid');
  assert.match(byKey['host'].message, /^must be an interface to bind/);
  assert.equal(byKey['market.royaltyShare'].message, 'must be a fraction between 0 and 1');
  assert.equal(byKey['verifier.quorum'].message, 'must be at least 1');
  assert.equal(byKey['strayKey'].kind, 'unknown');                 // reported, never a refusal
  assert.equal(problems.filter((p) => p.kind === 'invalid').length, 5);
});

test('a mistyped key is answered with the nearest real one, and a price stays a string', () => {
  assert.equal(nearestConfigKey('verifier.stak'), 'verifier.stake');
  assert.equal(nearestConfigKey('market.defaultprice'), 'market.defaultPrice');
  assert.equal(nearestConfigKey('ledger.knid'), 'ledger.kind');
  assert.equal(nearestConfigKey('typo.that.does.not.exist'), null);
  assert.equal(configField('nope.nope'), null);
  // money is a decimal string everywhere in this product, so `config set market.defaultPrice 9.99` must not store 9.99
  assert.equal(coerceConfigValue(configField('market.defaultPrice')!, '9.99'), '9.99');
  assert.equal(coerceConfigValue(configField('port')!, '3402'), 3402);
  assert.equal(coerceConfigValue(configField('teach.enabled')!, 'false'), false);
  assert.deepEqual(coerceConfigValue(configField('roles')!, 'seller, verifier'), ['seller', 'verifier']);
  assert.equal(configFieldType(configField('teach.publish')!), "one of 'review', 'auto', 'never'");
});

test('mergeConfigChanges folds only what the running node changed onto the file as it is now (item 124)', () => {
  const boot = defaultConfig({ home: join(tmp, 'merge'), name: 'n', port: 3402, ledger: 'local' });
  const live = structuredClone(boot);
  live.peers = ['http://peer:3403'];                       // the console added a peer
  live.operatorPasswordHash = 'hash';                      // …and set the password
  live.name = 'renamed';                                   // …and a display name
  const onDisk = structuredClone(boot);
  onDisk.market.defaultPrice = '9.99';                     // meanwhile `ainize config set` wrote this
  onDisk.verifier!.quorum = 3;
  const merged = mergeConfigChanges(onDisk, boot, live);
  assert.deepEqual(merged.peers, ['http://peer:3403']);
  assert.equal(merged.operatorPasswordHash, 'hash');
  assert.equal(merged.name, 'renamed');
  assert.equal(merged.market.defaultPrice, '9.99', 'the CLI edit is not reverted');
  assert.equal(merged.verifier!.quorum, 3);
  // a node that changed nothing writes the file back unchanged
  assert.deepEqual(mergeConfigChanges(onDisk, boot, structuredClone(boot)), onDisk);
});

test('buildStamp is measured once, when the code is loaded — a rebuild under a running process does not change it (item 141)', () => {
  const first = buildStamp()!;
  assert.match(first, /^\d{4}-\d\d-\d\dT/);
  // `npm run build` replaces the file on disk; the process is still running the code it loaded, and must say so
  const mod = fileURLToPath(new URL('../src/config.ts', import.meta.url));
  const st = statSync(mod);
  utimesSync(mod, st.atime, new Date(Date.parse(first) + 3_600_000));
  try {
    assert.equal(buildStamp(), first, 'the stamp is the build this process loaded, not the file now on disk');
    assert.notEqual(statSync(mod).mtime.toISOString(), first, 'the file really did change underneath');
  } finally { utimesSync(mod, st.atime, st.mtime); }
});
