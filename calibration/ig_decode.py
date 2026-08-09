#!/usr/bin/env python3
"""
ig_decode.py — recover payloads from platforms that rescale unconditionally.

Instagram does not merely cap width like WhatsApp and Telegram do; it resamples
every upload onto its own 1440x1440 canvas. Measured: 1080x1080 in, 1440x1440
out. A 1.333x rescale changes the spacing of the 8x8 DCT grid, so a block-
aligned decoder samples across block boundaries and reads noise (~42-50% BER,
i.e. nothing).

The fix does not need a new embedding scheme. Rescaling is deterministic and
roughly invertible: resample the received image back to the size it was
embedded at, and the grid lines up again. Recovery is imperfect -- raw bit
error lands around 1-4% rather than the 0.3% seen on WhatsApp -- which is above
what RS(64) alone can absorb, since a few percent of bit errors becomes a much
larger fraction of BYTE errors. The repetition layer closes that gap: a 3-way
majority vote drops the effective rate back under 1%.

So the repetition factor, which looks like dead weight on WhatsApp, is exactly
what makes Instagram work.

The decoder tries the received size first, then each candidate embedded size,
and keeps whichever recovers. That means one code path for every platform
rather than a separate Instagram mode.

    python3 ig_decode.py --manifest sq/manifest.json --returns sq_ig/
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

from round2 import (ZIGZAG, fwd, q_det, slots_for, frame, unframe, to_bits,
                    from_bits, pillow_table, read_id)

RESAMPLERS = [
    ("lanczos", Image.Resampling.LANCZOS),
    ("bicubic", Image.Resampling.BICUBIC),
]


def attempt(im: Image.Image, var: dict, qt: np.ndarray, nsym: int,
            target: tuple[int, int] | None, resampler) -> tuple[bool, float]:
    """Decode one variant at one geometry. Returns (recovered, raw BER)."""
    work = im.convert("RGB")
    if target is not None and (work.width, work.height) != target:
        work = work.resize(target, resampler)
    y = np.asarray(work.convert("YCbCr").split()[0], dtype=np.float64)

    co = fwd(y, qt)
    slots = slots_for(co.shape[0], co.shape[1], var["lo"], var["hi"])
    per = var["cw_len"] * 8
    n = min(var["bits"], len(slots))
    if n < per:
        return False, 1.0

    raw = [q_det(float(co[a][b][ZIGZAG[z][0]][ZIGZAG[z][1]]), var["delta"])
           for a, b, z in slots[:n]]
    want = bytes.fromhex(var["payload_hex"])
    cw_bits = to_bits(frame(want, nsym))
    ber = float(np.mean([x != y2 for x, y2 in zip(raw[:per], cw_bits)]))

    votes = [raw[k * per:(k + 1) * per] for k in range(var["repeat"])
             if len(raw[k * per:(k + 1) * per]) == per]
    merged = [1 if sum(c) * 2 > len(votes) else 0 for c in zip(*votes)] if votes else raw[:per]
    return unframe(from_bits(merged), nsym) == want, ber


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--returns", required=True)
    ap.add_argument("--json", default="ig_results.json")
    args = ap.parse_args()

    man = json.loads(Path(args.manifest).read_text())
    ch_qt = np.array(man["luma_qtable"], float).reshape(8, 8)
    tables = {"channel": ch_qt, "pillow_q75": pillow_table(75)}
    variants = man["variants"]
    nsym = man["nsym"]
    sizes = sorted({(v["stego_w"], v["stego_h"]) for v in variants})

    rows = []
    for f in sorted(Path(args.returns).iterdir()):
        if f.suffix.lower() not in {".jpg", ".jpeg", ".jfif", ".png", ".webp"}:
            continue
        im = Image.open(f)
        im.load()
        best = None
        for var in variants:
            qt = tables[var["table"]]
            geoms = [(None, "as-received", None)]
            for s in sizes:
                for rname, r in RESAMPLERS:
                    geoms.append((s, f"{s[0]}x{s[1]} {rname}", r))
            for target, label, resampler in geoms:
                ok, ber = attempt(im, var, qt, nsym, target, resampler)
                if best is None or (ok, -ber) > (best["ok"], -best["ber"]):
                    best = {"id": var["id"], "config": var["config"],
                            "payload_size": var["payload_size"],
                            "width": var["width"], "repeat": var["repeat"],
                            "ok": ok, "ber": ber, "via": label}
                if ok:
                    break
            if best and best["ok"]:
                break
        if best:
            rows.append({"file": f.name, **best})
            print(f"{f.name[:26]:<26} -> id{best['id']:<2} {best['config']:<11} "
                  f"{best['payload_size']:>5}B  via {best['via']:<18} "
                  f"raw BER {best['ber']*100:>5.2f}%  "
                  f"{'RECOVERED' if best['ok'] else 'fail'}")

    ok = sum(r["ok"] for r in rows)
    print(f"\n{ok}/{len(rows)} recovered")
    if ok:
        used = {r["via"] for r in rows if r["ok"]}
        print(f"geometries that worked: {', '.join(sorted(used))}")
    Path(args.json).write_text(json.dumps(rows, indent=2))
    print(f"wrote {args.json}")


if __name__ == "__main__":
    main()
