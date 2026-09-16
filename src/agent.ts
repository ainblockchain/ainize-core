/**
 * Domain agents: which knowledge belongs together, and which agents may ask each other.
 *
 * An agent is a path — `chain`, `chain/ethereum`, `chain/base` — and it is the SAME string an anchor already
 * carries as `topic_path` (`finance/krx`, `law/kr`). That is deliberate: every knowledge published so far is
 * already filed under one of these, so agents are a reading of the catalogue rather than a second registry
 * that can disagree with it. A registry nobody is obliged to keep in sync is how `stake` happened (item 127).
 *
 * Pure, and imports nothing, because three callers need the same answers: the node deciding what an agent
 * knows, the CLI printing a family, and the explorer drawing one. Boost — how much AIN is staked behind an
 * agent — is read from the chain by the caller and passed in, never computed here.
 *
 * ## The three relations, and why a flat list would not do
 *
 * 1. **Inheritance.** `chain/ethereum` sits under `chain`, which holds the vocabulary — what a token, a
 *    contract, an address IS. A child answers with its parent's words, so what the child adds is the
 *    difference between them, and that difference is what a buyer is paying for.
 * 2. **Sibling delegation.** `chain/base` cannot answer an Ethereum question, and it should hand it to
 *    `chain/ethereum` rather than guess. The hand-off is only sound because both descend from `chain` and
 *    therefore mean the same thing by "canonical address" — a common ancestor is what lets two agents that
 *    have never met talk. `delegationTarget` refuses a hand-off between agents that share no ancestor.
 * 3. **Containment.** Asking what `chain` knows must include everything under it; asking what
 *    `chain/ethereum` knows must not leak its sibling's rows. One rule, applied by `agentHolds`.
 *
 * ## Why `/` and not ENS names
 *
 * `vaults.defi.engram.eth` reads right-to-left and resolves over an RPC that may not be reachable. A
 * `topic_path` reads left-to-right, is already on every anchor, and works with no network at all. A name
 * service can be layered on top later — the mapping is mechanical, and `agentPathToName` does it — but
 * nothing here depends on one existing.
 */

/** Longest agent path this product will file knowledge under. Deep enough for `chain/ethereum/defi`. */
export const AGENT_MAX_DEPTH = 6;
/** One path segment: lowercase, because `chain/Base` and `chain/base` must never be two different agents. */
const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** The agent every anchor without a `topic_path` belongs to (`ain-ledger.ts` already defaults to this). */
export const AGENT_ROOT = 'patches';

export interface AgentProblem { path: string; message: string }

/**
 * Normalise an agent path, or say why it is not one.
 *
 * Case and stray slashes are fixed rather than refused — `Chain/Base/` is obviously `chain/base`, and an
 * operator who typed it meant it. Anything else is a refusal with the reason, because an anchor filed under a
 * path nobody can parse is knowledge that belongs to no agent and is found by nobody.
 */
export function parseAgentPath(raw: string | null | undefined): { path: string; segments: string[] } | AgentProblem {
  const input = String(raw ?? '').trim();
  if (!input) return { path: input, message: 'an agent path must not be empty' };
  const segments = input.toLowerCase().split('/').map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return { path: input, message: `${JSON.stringify(input)} has no path segments` };
  if (segments.length > AGENT_MAX_DEPTH) {
    return { path: input, message: `agent paths go at most ${AGENT_MAX_DEPTH} deep; ${JSON.stringify(input)} is ${segments.length}` };
  }
  for (const s of segments) {
    if (!SEGMENT.test(s)) {
      return { path: input, message: `${JSON.stringify(s)} is not a usable path segment: lowercase letters, digits, - and _, starting with a letter or digit, at most 40 characters` };
    }
  }
  return { path: segments.join('/'), segments };
}

/** True when `parseAgentPath` returned a problem rather than a path. */
export function isAgentProblem(v: ReturnType<typeof parseAgentPath>): v is AgentProblem {
  return (v as AgentProblem).message !== undefined;
}

/** The normalised path, or null. For callers that only want the happy answer. */
export function agentPath(raw: string | null | undefined): string | null {
  const r = parseAgentPath(raw);
  return isAgentProblem(r) ? null : r.path;
}

/** Which agent an anchor belongs to. Anchors written before agents existed fall to the root, as the ledger does. */
export function agentOfAnchor(anchor: { topic_path?: string | null } | null | undefined): string {
  return agentPath(anchor?.topic_path) ?? AGENT_ROOT;
}

/** `chain/ethereum` → `chain`. The root has no parent. */
export function agentParent(path: string): string | null {
  const p = agentPath(path);
  if (!p) return null;
  const i = p.lastIndexOf('/');
  return i < 0 ? null : p.slice(0, i);
}

/** Every ancestor, nearest first: `a/b/c` → `['a/b', 'a']`. */
export function agentAncestors(path: string): string[] {
  const out: string[] = [];
  for (let p = agentParent(path); p; p = agentParent(p)) out.push(p);
  return out;
}

/** True when `child` is `ancestor` or sits beneath it. `chain` holds `chain/base`; it does not hold `chainlink`. */
export function isDescendant(child: string, ancestor: string): boolean {
  const c = agentPath(child), a = agentPath(ancestor);
  if (!c || !a) return false;
  return c === a || c.startsWith(`${a}/`);
}

/**
 * Whether an agent should answer with this knowledge: its own rows and everything filed beneath it.
 *
 * Asking `chain` includes `chain/base`; asking `chain/base` must not reach into `chain/ethereum`. The prefix
 * check is on segment boundaries for the same reason the comparison is lowercased — `chain/base` and
 * `chain/basefee` are different agents, and a bare `startsWith` would merge them.
 */
export function agentHolds(agent: string, anchor: { topic_path?: string | null }): boolean {
  return isDescendant(agentOfAnchor(anchor), agent);
}

/** Everything one agent answers with, in catalogue order. */
export function anchorsForAgent<T extends { topic_path?: string | null }>(agent: string, anchors: readonly T[]): T[] {
  return anchors.filter((a) => agentHolds(agent, a));
}

/** The deepest path both descend from: (`chain/base`, `chain/ethereum`) → `chain`. Null when unrelated. */
export function nearestCommonAncestor(a: string, b: string): string | null {
  const x = agentPath(a), y = agentPath(b);
  if (!x || !y) return null;
  const xs = x.split('/'), ys = y.split('/');
  const out: string[] = [];
  for (let i = 0; i < Math.min(xs.length, ys.length) && xs[i] === ys[i]; i++) out.push(xs[i]);
  return out.length ? out.join('/') : null;
}

/**
 * Where an agent should send a question it cannot answer — and why it may.
 *
 * A hand-off is sound only between agents that share an ancestor: the shared vocabulary is what makes the
 * answer mean the same thing on both sides. `chain/base` may pass an Ethereum question to `chain/ethereum`
 * because both are `chain`; it may not pass one to `finance/krx`, which has never agreed what an address is.
 * The refusal is the useful half — an agent that delegates to a stranger has invented a fact with extra steps.
 */
export function delegationTarget(from: string, to: string): { ok: true; via: string } | { ok: false; reason: string } {
  const f = agentPath(from), t = agentPath(to);
  if (!f) return { ok: false, reason: `${JSON.stringify(from)} is not an agent path` };
  if (!t) return { ok: false, reason: `${JSON.stringify(to)} is not an agent path` };
  if (f === t) return { ok: false, reason: `${f} is the agent that was asked — delegating to itself would loop` };
  const via = nearestCommonAncestor(f, t);
  if (!via) {
    return { ok: false, reason: `${f} and ${t} share no ancestor: they have agreed on no vocabulary, so an answer from one is not an answer to a question asked of the other` };
  }
  return { ok: true, via };
}

/** How much is staked behind an agent, as the caller read it from the chain. Never computed here. */
export interface AgentBoost {
  /** AIN backing this agent (`agentBoostedShares` on the staking contract, converted to AIN). */
  boosted: number;
  /** How many addresses boosted it. */
  boosters?: number;
}

export interface AgentSummary {
  path: string;
  /** `chain/ethereum` → `ethereum`; the label a UI shows. */
  label: string;
  parent: string | null;
  ancestors: string[];
  children: string[];
  /** Knowledge filed under exactly this path. */
  own: number;
  /** Knowledge under this path and everything beneath it — what the agent answers with. */
  total: number;
  boost: AgentBoost | null;
  /** This agent's share of all boost across the set, 0–1. Null when nothing anywhere is boosted. */
  boost_share: number | null;
}

/**
 * The agent tree a node actually has: derived from the anchors it holds, never from a list someone maintains.
 *
 * Intermediate paths are materialised even when nothing is filed at them — `chain/base` existing means `chain`
 * exists, and a tree that skipped it would have no place to hang the vocabulary or to route a delegation
 * through. They show `own: 0`, which is the honest description of a node that holds nothing of its own.
 */
export function summariseAgents<T extends { topic_path?: string | null }>(
  anchors: readonly T[],
  boosts: Readonly<Record<string, AgentBoost>> = {},
): AgentSummary[] {
  const own = new Map<string, number>();
  const paths = new Set<string>();
  for (const a of anchors) {
    const p = agentOfAnchor(a);
    own.set(p, (own.get(p) ?? 0) + 1);
    paths.add(p);
    for (const anc of agentAncestors(p)) paths.add(anc);
  }
  for (const k of Object.keys(boosts)) {
    const p = agentPath(k);
    if (!p) continue;
    paths.add(p);
    for (const anc of agentAncestors(p)) paths.add(anc);
  }

  const boostOf = (p: string): AgentBoost | null => {
    for (const [k, v] of Object.entries(boosts)) if (agentPath(k) === p) return v;
    return null;
  };
  const totalBoost = Object.values(boosts).reduce((s, b) => s + (Number(b.boosted) || 0), 0);

  return [...paths].sort().map((path) => {
    const b = boostOf(path);
    return {
      path,
      label: path.slice(path.lastIndexOf('/') + 1),
      parent: agentParent(path),
      ancestors: agentAncestors(path),
      children: [...paths].filter((p) => agentParent(p) === path).sort(),
      own: own.get(path) ?? 0,
      total: anchors.filter((a) => agentHolds(path, a)).length,
      boost: b,
      boost_share: totalBoost > 0 ? (Number(b?.boosted) || 0) / totalBoost : null,
    };
  });
}

/**
 * `chain/ethereum` → `ethereum.chain.engram.eth`, for the day a name service resolves these.
 *
 * Mechanical and one-way on purpose: the path is what the product stores, and the name is a rendering of it.
 * Nothing in this file reads a name back, so a registry that disagrees with the catalogue cannot change what
 * an agent knows — it can only fail to find it.
 */
export function agentPathToName(path: string, root = 'engram.eth'): string | null {
  const p = agentPath(path);
  return p ? `${p.split('/').reverse().join('.')}.${root}` : null;
}
