/**
 * The market poll interval is configuration, not a constant.
 *
 * `refresh()` reads the ENTIRE `/apps/knowledge/market` subtree, so its cost is the size of the
 * catalogue rather than the size of what changed. At the 8-second default one node is free and
 * seventy nodes on one chain are seventy full-tree reads every eight seconds — enough to fill a
 * validator's accept queue until it stops answering. A node that mostly publishes its own work
 * can read the network's catalogue far less often, and must be able to say so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeConfigSchema } from '../src/config-schema.js';

const base = () => ({
  providerUrl: 'http://127.0.0.1:8081', eventHandlerUrl: null, chainId: 0, appName: 'knowledge',
});

test('pollMs is accepted and optional', () => {
  const schema = nodeConfigSchema.shape.ledger.shape.ain.unwrap();
  assert.equal(schema.parse(base()).pollMs, undefined);
  assert.equal(schema.parse({ ...base(), pollMs: 120_000 }).pollMs, 120_000);
});

test('pollMs below one second is refused', () => {
  const schema = nodeConfigSchema.shape.ledger.shape.ain.unwrap();
  // A node hammering the chain faster than a block is produced reads the same tree twice for
  // nothing; the floor says so rather than letting a typo take a validator down.
  assert.throws(() => schema.parse({ ...base(), pollMs: 10 }));
  assert.throws(() => schema.parse({ ...base(), pollMs: 0 }));
  assert.throws(() => schema.parse({ ...base(), pollMs: 7_200_000 }));
});
