#!/usr/bin/env python3
"""
match_returns.py — restore chart_wNNNN names on files a platform renamed.

WhatsApp and Instagram rename uploads (IMG-20260809-WA0001.jpg), so the link
back to the source chart is lost. Worse, once a platform caps width, several
different source charts can come back at *identical* dimensions, so you cannot
recover the pairing from size alone.

This matches on image content instead: each return is compared against every
source chart at a common resolution, and the best correlation wins. Matching is
done one-to-one (each source used at most once), so a single bad score cannot
cascade into several wrong pairings.

Dry run first, then rename:

    python3 match_returns.py --charts charts/ --dir returns/whatsapp
    python3 match_returns.py --charts charts/ --dir returns/whatsapp --apply

Check the confidence column before applying. 'ok' means the best match was
clearly ahead of the runner-up. 'CHECK' means it was close — look at those by
eye before committing to the rename.
"""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

# Compared at this size: small enough to be robust to resize and JPEG noise,
# large enough to keep the frequency-sweep structure that distinguishes charts.
COMPARE_W, COMPARE_H = 320, 240


def fingerprint(path: Path) -> np.ndarray:
    """Normalised greyscale thumbnail, mean-centred and unit-scaled."""
    with Image.open(path) as im:
        im = im.convert("L").resize((COMPARE_W, COMPARE_H), Image.Resampling.LANCZOS)
        a = np.asarray(im, dtype=np.float64)
    a -= a.mean()
    n = np.linalg.norm(a)
    return a / n if n > 1e-9 else a


def width_from_name(name: str) -> int | None:
    m = re.search(r"_w(\d+)", name)
    return int(m.group(1)) if m else None


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--charts", default="charts", help="directory of source charts")
    ap.add_argument("--dir", required=True, help="one platform's returns directory")
    ap.add_argument("--apply", action="store_true", help="perform the rename (default is dry run)")
    args = ap.parse_args()

    charts_dir, returns_dir = Path(args.charts), Path(args.dir)
    if not returns_dir.is_dir():
        raise SystemExit(f"Not a directory: {returns_dir}")

    sources = []
    for p in sorted(charts_dir.glob("*.png")):
        w = width_from_name(p.name)
        if w:
            sources.append((w, p, fingerprint(p)))
    if not sources:
        raise SystemExit(f"No chart_wNNNN.png files found in {charts_dir}")

    returns = [
        p for p in sorted(returns_dir.iterdir())
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        and not re.match(r"^chart_w\d+\.", p.name)
    ]
    if not returns:
        raise SystemExit(f"No unmatched image files in {returns_dir} (already renamed?)")

    # Score every return against every source.
    scores = np.zeros((len(returns), len(sources)))
    dims = []
    for i, r in enumerate(returns):
        with Image.open(r) as im:
            dims.append((im.width, im.height))
        fr = fingerprint(r)
        for j, (_, _, fs) in enumerate(sources):
            scores[i, j] = float((fr * fs).sum())

    # Greedy one-to-one assignment, strongest pair first.
    pairs: dict[int, int] = {}
    used_src: set[int] = set()
    order = np.dstack(np.unravel_index(np.argsort(-scores, axis=None), scores.shape))[0]
    for i, j in order:
        if i in pairs or j in used_src:
            continue
        pairs[int(i)] = int(j)
        used_src.add(int(j))

    print(f"{'return file':<28} {'dims':>11}  {'-> source':<10} {'score':>6} {'margin':>7}  flag")
    print("-" * 78)
    plan = []
    for i, r in enumerate(returns):
        j = pairs.get(i)
        if j is None:
            print(f"{r.name:<28} {str(dims[i]):>11}  {'(none)':<10}")
            continue
        w = sources[j][0]
        row = np.sort(scores[i])[::-1]
        margin = float(row[0] - row[1]) if row.size > 1 else 1.0
        flag = "ok" if margin > 0.02 else "CHECK"
        dim_s = f"{dims[i][0]}x{dims[i][1]}"
        print(f"{r.name:<28} {dim_s:>11}  chart_w{w:<5} {scores[i, j]:>6.3f} {margin:>7.3f}  {flag}")
        plan.append((r, returns_dir / f"chart_w{w}{r.suffix.lower()}"))

    checks = sum(1 for i, r in enumerate(returns) if pairs.get(i) is not None
                 and (np.sort(scores[i])[::-1][0] - np.sort(scores[i])[::-1][1]) <= 0.02)
    if checks:
        print(f"\n{checks} pairing(s) flagged CHECK — verify by eye before applying.")

    if not args.apply:
        print("\nDry run. Re-run with --apply to rename.")
        return

    for src, dst in plan:
        if dst.exists() and dst != src:
            print(f"skip (target exists): {dst.name}")
            continue
        shutil.move(str(src), str(dst))
        print(f"{src.name}  ->  {dst.name}")
    print(f"\nRenamed {len(plan)} file(s) in {returns_dir}")


if __name__ == "__main__":
    main()
