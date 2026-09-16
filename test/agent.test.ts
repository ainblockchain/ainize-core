/**
 * Domain agents derived from `topic_path`.
 *
 * Two properties carry the file. Containment must hold on segment boundaries — `chain/base` and
 * `chain/basefee` are different agents, and the cheap prefix check merges them into one that answers with
 * the other's rows. And delegation must REFUSE between agents that share no ancestor: an agent that hands a
 * question to a stranger has invented a fact with extra steps, which is the failure the whole hierarchy is
 * built to prevent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_MAX_DEPTH, AGENT_ROOT,
  agentAncestors, agentHolds, agentOfAnchor, agentParent, agentPath, agentPathToName, anchorsForAgent,
  delegationTarget, isAgentProblem, isDescendant, nearestCommonAncestor, parseAgentPath, summariseAgents,
} from '../src/index.js';

const anchor = (topic_path: string | null, id = topic_path ?? 'none') => ({ id, topic_path });

test('parseAgentPath: case and stray slashes are fixed; unparseable paths are refused with a reason', () => {
  for (const [raw, want] of [['chain/base', 'chain/base'], ['Chain/Base/', 'chain/base'],
    ['  chain / ethereum ', 'chain/ethereum'], ['//chain//base//', 'chain/base'], ['patches', 'patches']] as const) {
    const r = parseAgentPath(raw);
    assert.ok(!isAgentProblem(r), `${raw} should parse`);
    assert.equal(r.path, want);
  }
  for (const bad of ['', '   ', '/', 'chain/Base!', 'chain/-lead', 'a'.repeat(41), 'a/b/c/d/e/f/g']) {
    assert.ok(isAgentProblem(parseAgentPath(bad)), `${JSON.stringify(bad)} should be refused`);
  }
  const deep = parseAgentPath('a/b/c/d/e/f/g');
  assert.ok(isAgentProblem(deep) && deep.message.includes(String(AGENT_MAX_DEPTH)), 'says what the limit is');
  assert.equal(agentPath('nope!'), null);
});

test('agentOfAnchor: knowledge published before agents existed belongs to the root, as the ledger already defaults', () => {
  assert.equal(agentOfAnchor(anchor('chain/base')), 'chain/base');
  assert.equal(agentOfAnchor(anchor(null)), AGENT_ROOT);
  assert.equal(agentOfAnchor({}), AGENT_ROOT);
  assert.equal(agentOfAnchor(undefined), AGENT_ROOT);
  assert.equal(agentOfAnchor(anchor('FINANCE/KRX')), 'finance/krx', 'one agent, whatever the case it was filed in');
});

test('lineage: parent, ancestors and containment on SEGMENT boundaries', () => {
  assert.equal(agentParent('chain/ethereum'), 'chain');
  assert.equal(agentParent('chain'), null);
  assert.deepEqual(agentAncestors('a/b/c'), ['a/b', 'a']);
  assert.deepEqual(agentAncestors('a'), []);

  assert.ok(isDescendant('chain/base', 'chain'));
  assert.ok(isDescendant('chain', 'chain'), 'an agent holds its own rows');
  assert.ok(!isDescendant('chain', 'chain/base'), 'a parent is not beneath its child');
  // the bug a bare startsWith would introduce
  assert.ok(!isDescendant('chain/basefee', 'chain/base'));
  assert.ok(!isDescendant('chainlink', 'chain'));
});

test('agentHolds / anchorsForAgent: a parent answers with everything beneath it, a child never with its sibling', () => {
  const anchors = [anchor('chain'), anchor('chain/ethereum'), anchor('chain/base'), anchor('chain/basefee'),
    anchor('finance/krx'), anchor(null, 'legacy')];
  assert.deepEqual(anchorsForAgent('chain', anchors).map((a) => a.id),
    ['chain', 'chain/ethereum', 'chain/base', 'chain/basefee']);
  assert.deepEqual(anchorsForAgent('chain/base', anchors).map((a) => a.id), ['chain/base'],
    'chain/base does not reach chain/ethereum, nor chain/basefee');
  assert.deepEqual(anchorsForAgent(AGENT_ROOT, anchors).map((a) => a.id), ['legacy']);
  assert.ok(agentHolds('chain', anchor('chain/ethereum')));
  assert.ok(!agentHolds('chain/ethereum', anchor('chain/base')));
});

test('nearestCommonAncestor: the shared vocabulary, or nothing', () => {
  assert.equal(nearestCommonAncestor('chain/base', 'chain/ethereum'), 'chain');
  assert.equal(nearestCommonAncestor('a/b/c', 'a/b/d'), 'a/b');
  assert.equal(nearestCommonAncestor('chain/base', 'chain/base'), 'chain/base');
  assert.equal(nearestCommonAncestor('chain/base', 'finance/krx'), null);
  assert.equal(nearestCommonAncestor('chain/base', 'chainlink/x'), null, 'segment boundaries here too');
});

test('delegationTarget: siblings may hand off through their ancestor; strangers may not, and self-delegation loops', () => {
  const ok = delegationTarget('chain/base', 'chain/ethereum');
  assert.deepEqual(ok, { ok: true, via: 'chain' });

  const stranger = delegationTarget('chain/base', 'finance/krx');
  assert.equal(stranger.ok, false);
  assert.match((stranger as { reason: string }).reason, /share no ancestor/);

  const self = delegationTarget('chain/base', 'chain/base');
  assert.equal(self.ok, false);
  assert.match((self as { reason: string }).reason, /loop/);

  assert.equal(delegationTarget('chain/base', 'not a path!').ok, false);
  // a child may delegate UP to its own parent — they share the parent
  assert.deepEqual(delegationTarget('chain/base', 'chain'), { ok: true, via: 'chain' });
});

test('summariseAgents: intermediate paths are materialised, counts separate own from inherited, boost shares sum to 1', () => {
  const anchors = [anchor('chain/ethereum', 'e1'), anchor('chain/ethereum', 'e2'), anchor('chain/base', 'b1')];
  const boosts = { 'chain/ethereum': { boosted: 300, boosters: 3 }, 'chain/base': { boosted: 100, boosters: 1 } };
  const s = summariseAgents(anchors, boosts);
  const by = Object.fromEntries(s.map((x) => [x.path, x]));

  assert.ok(by['chain'], 'chain is materialised even though nothing is filed at it');
  assert.equal(by['chain'].own, 0);
  assert.equal(by['chain'].total, 3, 'a parent answers with everything beneath it');
  assert.deepEqual(by['chain'].children, ['chain/base', 'chain/ethereum']);
  assert.equal(by['chain'].boost, null);

  assert.equal(by['chain/ethereum'].own, 2);
  assert.equal(by['chain/ethereum'].total, 2);
  assert.equal(by['chain/ethereum'].label, 'ethereum');
  assert.equal(by['chain/ethereum'].parent, 'chain');
  assert.equal(by['chain/ethereum'].boost?.boosted, 300);
  assert.equal(by['chain/ethereum'].boost_share, 0.75);
  assert.equal(by['chain/base'].boost_share, 0.25);

  const shares = s.map((x) => x.boost_share ?? 0).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(shares * 1e6) / 1e6, 1);

  // nothing boosted anywhere: a share of nothing is unknown, not zero
  assert.equal(summariseAgents(anchors).every((x) => x.boost_share === null), true);
  // an agent that is boosted but holds nothing yet still appears — that is the case a launch starts in
  const fresh = summariseAgents([], { 'chain/base': { boosted: 10 } });
  assert.deepEqual(fresh.map((x) => x.path), ['chain', 'chain/base']);
  assert.equal(fresh.find((x) => x.path === 'chain/base')?.total, 0);
});

test('agentPathToName: a one-way rendering, so a registry can never change what an agent knows', () => {
  assert.equal(agentPathToName('chain/ethereum'), 'ethereum.chain.engram.eth');
  assert.equal(agentPathToName('chain'), 'chain.engram.eth');
  assert.equal(agentPathToName('chain/base', 'ainize.eth'), 'base.chain.ainize.eth');
  assert.equal(agentPathToName('bad!'), null);
});
