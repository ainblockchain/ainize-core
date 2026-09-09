#!/usr/bin/env python3
"""Verify that a taught knowledge file really is built ON TOP of the bases it names (design §7.4, §5.4).

Offline: it reads .npz files and recipe.json and needs no GPU, no vLLM and no model — every assertion below is a
property of the bytes.  It is the check to run on the artefacts a `flashtrain` run leaves behind, and the reason it
lives here rather than in the trainer is that a trainer cannot be the only witness to its own contract.

  python3 scripts/lineage-verify.py --child .teach/<job>/lesson.npz --recipe .teach/<job>/recipe.json \
      --parent krx-all-2761=.teach/<job>/parents/0-<sha>.npz [--parent ...] [--model-dir /model] [--json]

--model-dir needs `engram.core` to read the checkpoint shards.  Inside the trainer's container that is /work and is
found automatically; on the host, point ENGRAM_REPO at the qwen3.8 checkout (ENGRAM_REPO=/path/to/qwen3.8).  Without
--model-dir every other check still runs — only the comparison against the disk base is skipped, and it says so.

What is checked
  1  addrs/before/after are int64[N] / float32[N,D] / float32[N,D] and agree on N and D.
  2  the `meta` member parses and carries export, base_stack, pre_state_sha256, trainer_version; `base_stack` is the
     ordered stack for a delta and EMPTY for a squash.
  3  pre_state_sha256 recomputed from the FILE'S OWN addrs+before equals both meta and recipe — the same rule
     packages/core/src/lineage.ts uses and packages/node/src/api.ts recomputes on `patch import`, so a mismatch here
     is a published file whose record cannot be rebuilt from it.
  4  delta: on every address the child shares with a parent, child.before == parent.after in BF16 BITS (the table is
     bf16; a float32 comparison is a different and wrong test).  Stack order is honoured: the LAST parent that owns
     an address is the one whose value must be underneath.
  5  squash: the child's addresses cover every parent address, and on a parent address the child did not move,
     child.after == parent.after in bf16 bits.
  6  with --model-dir: the disk base is read straight from the checkpoint shards (engram.core.read_rows — file I/O,
     no GPU) and a delta's FRESH addresses, or a squash's `before` everywhere, are checked against it.
  7  recipe.json agrees: parents listed and loaded, export matching meta, pre_state_sha256 matching.

Exit code 0 when everything checked passed, 1 on any failure, 2 on a usage or file error.
"""
import argparse, hashlib, json, os, sys
import numpy as np

ROW_DIM = 160


def bf16(a):
    """float32 -> bf16 bits, round-to-nearest-even (engram.core._f32_to_bf16 / patch.py:_bf16 / lineage.ts:bf16Bits)."""
    u = np.ascontiguousarray(a, dtype=np.float32).view(np.uint32)
    return ((u + 0x7FFF + ((u >> 16) & 1)) >> 16).astype("<u2")


def pre_state_sha256(addrs, before):
    """sha256 over the rows sorted by address: addr int64-LE ‖ bf16(before) uint16-LE (design §5.1)."""
    a = np.ascontiguousarray(np.asarray(addrs, dtype=np.int64))
    b = np.ascontiguousarray(np.atleast_2d(np.asarray(before, dtype=np.float32)))
    if len(a) == 0:
        return hashlib.sha256(b"").hexdigest()
    order = np.argsort(a, kind="stable")
    a = np.ascontiguousarray(a[order], dtype="<i8")
    bits = np.ascontiguousarray(bf16(b[order]))
    n, dim = bits.shape
    buf = np.empty((n, 8 + 2 * dim), dtype=np.uint8)
    buf[:, :8] = a.view(np.uint8).reshape(n, 8)
    buf[:, 8:] = bits.view(np.uint8).reshape(n, 2 * dim)
    return hashlib.sha256(buf.tobytes()).hexdigest()


def read_meta(path):
    z = np.load(path)
    try:
        if "meta" not in z.files:
            return None
        return json.loads(bytes(z["meta"].astype(np.uint8)).decode("utf-8"))
    finally:
        z.close()


class Report:
    def __init__(self):
        self.checks = []

    def add(self, name, ok, detail=""):
        self.checks.append(dict(check=name, ok=bool(ok), detail=detail))
        print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}", file=sys.stderr)
        return ok

    def skip(self, name, why):
        self.checks.append(dict(check=name, ok=None, detail=why))
        print(f"  SKIP  {name}  — {why}", file=sys.stderr)

    @property
    def failed(self):
        return [c for c in self.checks if c["ok"] is False]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--child", required=True, help="the lesson .npz the trainer wrote")
    ap.add_argument("--recipe", help="recipe.json next to it")
    ap.add_argument("--parent", action="append", default=[], metavar="ID=PATH",
                    help="a base, in stack order (ancestors first, direct base last); repeatable")
    ap.add_argument("--export", choices=["delta", "squash"], help="what to expect (default: what `meta` says)")
    ap.add_argument("--model-dir", help="checkpoint dir, to read the disk base (file I/O only, no GPU); needs "
                                        "engram.core — set ENGRAM_REPO to the qwen3.8 checkout when off-container")
    ap.add_argument("--json", action="store_true", help="print one JSON object on stdout")
    a = ap.parse_args()

    if not os.path.exists(a.child):
        sys.exit(f"no such file: {a.child}")
    parents = []
    for p in a.parent:
        pid, _, path = p.partition("=")
        if not path or not os.path.exists(path):
            sys.exit(f"--parent {p}: expected ID=PATH with an existing file")
        parents.append((pid, path))

    r = Report()
    z = np.load(a.child)
    addrs = np.asarray(z["addrs"], dtype=np.int64)
    before = np.asarray(z["before"], dtype=np.float32)
    after = np.asarray(z["after"], dtype=np.float32)
    z.close()

    print(f"child {a.child}: {len(addrs)} row(s)", file=sys.stderr)
    r.add("shapes", before.shape == after.shape and before.shape[0] == len(addrs) and before.ndim == 2,
          f"addrs[{len(addrs)}] before{before.shape} after{after.shape}")
    dim = before.shape[1] if before.ndim == 2 else ROW_DIM
    r.add("addresses are unique", len(np.unique(addrs)) == len(addrs))

    meta = read_meta(a.child)
    recipe = json.load(open(a.recipe, encoding="utf-8")) if a.recipe and os.path.exists(a.recipe) else None
    export = a.export or (meta or {}).get("export") or (recipe or {}).get("export") or "delta"

    if parents:
        if r.add("meta member present", meta is not None,
                 "a file trained on a base must say so on its own" if meta is None else json.dumps(meta.get("export"))):
            r.add("meta.export", meta.get("export") == export, f"{meta.get('export')!r} vs expected {export!r}")
            stack = [b.get("patch_id") for b in meta.get("base_stack") or []]
            want = [pid for pid, _ in parents] if export == "delta" else []
            r.add("meta.base_stack", stack == want, f"{stack} vs {want}")
            r.add("meta.trainer_version", bool(meta.get("trainer_version")), str(meta.get("trainer_version")))
            recomputed = pre_state_sha256(addrs, before)
            r.add("pre_state_sha256 recomputes from the file", meta.get("pre_state_sha256") == recomputed,
                  f"{str(meta.get('pre_state_sha256'))[:16]}… vs {recomputed[:16]}…")
    else:
        r.skip("meta member", "no --parent given: a stand-alone build carries no meta")

    # the stack, in order: the last parent that owns an address is the one underneath the child there
    under_addr, under_after = {}, {}
    for pid, path in parents:
        pz = np.load(path)
        pa = np.asarray(pz["addrs"], dtype=np.int64)
        pafter = np.asarray(pz["after"], dtype=np.float32)
        pz.close()
        r.add(f"parent {pid} shapes", pafter.shape == (len(pa), dim), f"{pafter.shape}")
        for i, ad in enumerate(pa.tolist()):
            under_addr[ad] = pid
            under_after[ad] = pafter[i]

    if parents:
        idx = [i for i, ad in enumerate(addrs.tolist()) if ad in under_addr]
        if export == "delta":
            bad = [int(addrs[i]) for i in idx if not np.array_equal(bf16(before[i]), bf16(under_after[int(addrs[i])]))]
            r.add("delta: before == parent.after on every shared address (bf16)", not bad,
                  f"{len(idx)} shared, {len(bad)} differ" + (f", first {bad[:3]}" if bad else ""))
            r.add("delta: the child touches at least one row", len(addrs) > 0)
        else:
            missing = [ad for ad in under_addr if ad not in set(addrs.tolist())]
            r.add("squash: every parent address is carried", not missing, f"{len(missing)} missing")
            moved = [i for i in idx if not np.array_equal(bf16(after[i]), bf16(under_after[int(addrs[i])]))]
            # A squash that CARRIED its parent's rows and one that OVERWROTE them have the same address list, so the
            # count is the only thing that separates them: no more parent rows may have moved than the run touched.
            # `touched_rows` is the trainer's own count of the rows it wrote through (recipe.json); without it this
            # can only be reported, and a report that cannot fail is not a check.
            touched = (recipe or {}).get("touched_rows")
            if isinstance(touched, int):
                r.add("squash: no more parent rows moved than the run actually touched", len(moved) <= touched,
                      f"{len(moved)} moved, {touched} touched, {len(idx) - len(moved)} carried through unchanged")
            else:
                r.skip("squash: parent rows carried through",
                       f"recipe has no touched_rows; {len(idx) - len(moved)} of {len(idx)} unchanged, {len(moved)} moved")

    if a.model_dir:
        repo = os.path.dirname(os.path.dirname(os.path.abspath(a.model_dir)))
        for cand in (os.environ.get("ENGRAM_REPO"), "/work", repo):
            if cand and os.path.exists(os.path.join(cand, "engram", "core.py")):
                sys.path.insert(0, cand)
                break
        os.environ.setdefault("ENGRAM_MODEL_DIR", a.model_dir)
        try:
            from engram.core import read_rows
            fresh = [i for i, ad in enumerate(addrs.tolist()) if ad not in under_addr] if export == "delta" else list(range(len(addrs)))
            if fresh:
                disk = read_rows(addrs[fresh])
                bad = [int(addrs[i]) for k, i in enumerate(fresh) if not np.array_equal(bf16(before[i]), bf16(disk[k]))]
                r.add("before == the disk base where nothing was under it (bf16)", not bad,
                      f"{len(fresh)} row(s) checked, {len(bad)} differ")
            else:
                r.skip("disk base", "every exported row sits on a parent")
        except Exception as e:
            r.skip("disk base", f"{type(e).__name__}: {e}")
    else:
        r.skip("disk base", "pass --model-dir to read the checkpoint shards (no GPU needed)")

    if recipe is not None:
        if parents:
            rp = recipe.get("parents") or []
            r.add("recipe lists every parent as loaded",
                  all(any(x.get("patch_id") == pid and x.get("loaded") for x in rp) for pid, _ in parents),
                  json.dumps([(x.get("patch_id"), x.get("loaded"), x.get("rows")) for x in rp]))
            r.add("recipe.export matches the file", recipe.get("export") == export, str(recipe.get("export")))
            r.add("recipe.pre_state_sha256 matches the file",
                  recipe.get("pre_state_sha256") == pre_state_sha256(addrs, before), str(recipe.get("pre_state_sha256"))[:16] + "…")
            r.add("recipe.known_used is reported", isinstance(recipe.get("known_used"), int), str(recipe.get("known_used")))
        r.add("recipe rows match the file", recipe.get("rows") == len(addrs), f"{recipe.get('rows')} vs {len(addrs)}")
        t = recipe.get("touched_rows")
        if isinstance(t, int):
            # a delta is exactly the rows the run wrote through; a squash is those plus the parent rows it carried
            r.add("recipe.touched_rows agrees with the export mode",
                  t == len(addrs) if export == "delta" else (len(addrs) >= t and len(addrs) <= t + len(under_addr)),
                  f"touched {t}, exported {len(addrs)}, parent rows {len(under_addr)}")
        keep = [s for s in recipe.get("sentences") or [] if s.get("role") == "known"]
        bench = {s.get("prompt") for s in recipe.get("benchmark_samples") or []}
        r.add("keep-set rows are not published as this lesson's benchmark",
              not any(s.get("prefix") in bench for s in keep), f"{len(keep)} keep sentence(s)")
    else:
        r.skip("recipe.json", "not given")

    ok = not r.failed
    print(("PASS" if ok else f"FAIL ({len(r.failed)} check(s))") + f" — {a.child}", file=sys.stderr)
    if a.json:
        print(json.dumps(dict(ok=ok, child=a.child, rows=int(len(addrs)), dim=int(dim), export=export,
                              parents=[pid for pid, _ in parents], checks=r.checks), ensure_ascii=False))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
