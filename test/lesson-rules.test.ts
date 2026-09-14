import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AinLedger } from '../src/ain-ledger.js';

test('lesson rules authorize only the path owner and bind node/job metadata', () => {
  const rules = AinLedger.marketRules().filter(([path]) => path === '/apps/knowledge/market/lessons/$node/$job');
  assert.equal(rules.length, 1);
  const accepts = new Function('auth', 'newData', '$node', '$job', 'util', `return (${rules[0][1]});`);
  const util = { isDict: (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) };
  const record = { node: 'owner', job: 'job', status: 'TRAINING' };
  assert.equal(accepts({ addr: 'owner' }, record, 'owner', 'job', util), true);
  assert.equal(accepts({ addr: 'stranger' }, record, 'owner', 'job', util), false);
  assert.equal(accepts({ addr: 'owner' }, { ...record, node: 'stranger' }, 'owner', 'job', util), false);
  assert.equal(accepts({ addr: 'owner' }, { ...record, job: 'other' }, 'owner', 'job', util), false);
  assert.equal(accepts({ addr: 'owner' }, null, 'owner', 'job', util), false);
});

test('invalid lesson IDs cannot escape their single path segment', async () => {
  for (const id of ['', '../other', 'job/other', 'a'.repeat(129)]) {
    await assert.rejects(AinLedger.prototype.noteLesson.call({} as AinLedger, id, {}), /Invalid lesson job ID/);
  }
});
