#!/usr/bin/env python3
"""
compare.py — generate a matched pair (and a sweep) for eyeball comparison.

The masked-visibility metric in adaptive.py is a proxy for human judgement, and
human judgement has already overruled PSNR once in this project: delta=24 looked
clean by PSNR and dotted obviously on screen. So before committing the adaptive
scheme to anything, produce real files and look at them.

Every image here carries the SAME payload from the SAME cover at the SAME step
size. The only thing that varies is placement: raster order with a flat step
(what Stegstr does today) versus a keyed permutation with texture-weighted step.

    python3 compare.py --image photo.jpg --payload 4096 --delta 16
    python3 compare.py --image photo.jpg --payload 4096 --sweep

Output files are named so the configuration is obvious in a file browser.
Open them full-screen next to the original and look at the smooth regions --
blank walls, ceiling, sky -- which is where embedding shows first.

Files whose name ends _POST are the ones worth sending through the platform:
the pair that isolates the change.
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image

from round2 import (fwd, inv, save_colour, load_ycc, frame, to_bits)
from adaptive import (embed, extract, local_density_map, masked_visibility_map,
                      LADDER, activity_to_rung, block_activity)
from recover import unframe, from_bits

KEY = 0xC0FFEE


def measure(ref_bytes: bytes, stego_bytes: bytes) -> dict:
    ra = np.asarray(Image.open(io.BytesIO(ref_bytes)).convert("L"), float)
    sa = np.asarray(Image.open(io.BytesIO(stego_bytes)).convert("L"), float)
    hh, ww = min(ra.shape[0], sa.shape[0]), min(ra.shape[1], sa.shape[1])
    ra, sa = ra[:hh, :ww], sa[:hh, :ww]
    mse = float(np.mean((ra - sa) ** 2))
    psnr = 10 * np.log10(255.0 ** 2 / mse) if mse > 1e-9 else 99.0
    dens = local_density_map(ra, sa)
    vis = masked_visibility_map(ra, sa)
    return {"psnr": psnr,
            "raw_local": float(np.percentile(dens, 99.5)),
            "masked_vis": float(np.percentile(vis, 99.5)),
            "covered": float((dens > 0.5).mean())}


def cmd_decode(args) -> None:
    """
    Decode returns from a compare run.

    The files carry no ID patch -- these images are meant to be looked at, so a
    visible marker would sit in the frame being judged. Instead each return is
    tried against every recorded configuration and the one that recovers wins.
    With only a handful of configurations that is cheap, and it means the test
    images are exactly what a user would actually send.
    """
    recs = json.loads((Path(args.out) / "compare.json").read_text())
    profs = json.loads(Path(args.profiles).read_text())["platforms"]
    prof = next(p for p in profs if p["platform"] == args.platform)
    qt = np.array(prof["luma_qtable"], float).reshape(8, 8)

    files = [p for p in sorted(Path(args.returns).iterdir())
             if p.suffix.lower() in {".jpg", ".jpeg", ".jfif", ".png", ".webp"}]
    if not files:
        raise SystemExit(f"no images in {args.returns}")

    print(f"\n{'return':<12} {'matched config':<24} {'delta':>5} {'out':>6} "
          f"{'rsz':>4} {'raw BER':>8}  result")
    print("-" * 74)

    for f in files:
        im = Image.open(f)
        im.load()
        best = None
        for r in recs:
            rng = np.random.default_rng(31337)
            payload = bytes(rng.integers(0, 256, r["payload"], dtype=np.uint8))
            cw = frame(payload, 64)
            cwb = to_bits(cw)
            nbits = len(cwb) * r["repeat"]
            per = len(cwb)

            for target in ([None] if im.width == r["width"] else
                           [None, (r["width"], r["width"])]):
                work = im.convert("RGB")
                if target and (work.width, work.height) != target:
                    work = work.resize(target, Image.Resampling.LANCZOS)
                y = np.asarray(work.convert("YCbCr").split()[0], float)
                got = extract(y, qt, nbits, r["delta"], 1, 12, KEY,
                              r["spread"], r["adaptive"])
                if len(got) < per:
                    continue
                ber = float(np.mean([a != b for a, b in zip(got[:per], cwb)]))
                votes = [got[k * per:(k + 1) * per] for k in range(r["repeat"])
                         if len(got[k * per:(k + 1) * per]) == per]
                merged = ([1 if sum(c) * 2 > len(votes) else 0 for c in zip(*votes)]
                          if votes else got[:per])
                ok = unframe(from_bits(merged), 64) == payload
                cand = {"cfg": r, "ber": ber, "ok": ok,
                        "rsz": im.width != r["width"]}
                if best is None or (ok, -ber) > (best["ok"], -best["ber"]):
                    best = cand
                if ok:
                    break
            if best and best["ok"]:
                break
        if best:
            c = best["cfg"]
            print(f"{f.name:<12} {c['file'][:24]:<24} {c['delta']:>5.0f} "
                  f"{im.width:>6} {'Y' if best['rsz'] else 'n':>4} "
                  f"{best['ber']*100:>7.2f}%  "
                  f"{'RECOVERED' if best['ok'] else 'fail'}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--decode", metavar="DIR", dest="returns", default=None,
                    help="decode returns from this directory instead of embedding")
    ap.add_argument("--image", default=None)
    ap.add_argument("--out", default="cmp")
    ap.add_argument("--profiles", default="measured_profiles.json")
    ap.add_argument("--platform", default="instagram")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--payload", type=int, default=4096)
    ap.add_argument("--delta", type=float, default=16.0)
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--sweep", action="store_true",
                    help="also emit adaptive at several step sizes")
    args = ap.parse_args()

    if args.returns:
        cmd_decode(args)
        return
    if not args.image:
        raise SystemExit("--image is required unless --decode is given")

    profs = json.loads(Path(args.profiles).read_text())["platforms"]
    prof = next(p for p in profs if p["platform"] == args.platform)
    qt = np.array(prof["luma_qtable"], float).reshape(8, 8)
    ss = 2

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    y0, cb, cr = load_ycc(args.image, args.width, square=True)
    rng = np.random.default_rng(31337)
    payload = bytes(rng.integers(0, 256, args.payload, dtype=np.uint8))
    cw = frame(payload, 64)
    bits = to_bits(cw) * args.repeat

    # Clean reference: same quantise/reconstruct path, no payload.
    ref_bytes = save_colour(inv(fwd(y0, qt), qt), cb, cr, qt, ss)
    (out / "z00_clean_reference.jpg").write_bytes(ref_bytes)

    jobs = [("old_raster_flat", args.delta, False, False, True),
            ("new_spread_adaptive", args.delta, True, True, True)]
    if args.sweep:
        for d in (10, 16, 24, 32):
            jobs.append((f"adaptive_d{d}", float(d), True, True, False))

    print(f"\ncover {args.image} -> {args.width}x{args.width} square")
    print(f"channel {prof['platform']}, payload {args.payload}B, repeat x{args.repeat}\n")
    print(f"{'file':<34} {'delta':>5} {'PSNR':>6} {'raw':>7} {'MASKED':>7} {'frame':>6} {'self-test':>10}")
    print("-" * 82)

    records = []
    for name, delta, spread, adaptive, post in jobs:
        y1, cap, used = embed(y0, qt, bits, delta, 1, 12, KEY, spread, adaptive)
        if used < len(bits):
            print(f"{name:<34} does not fit ({used}/{len(bits)} slots)")
            continue
        stego = save_colour(y1, cb, cr, qt, ss)
        fn = out / f"{name}{'_POST' if post else ''}.jpg"
        fn.write_bytes(stego)

        m = measure(ref_bytes, stego)
        # self-test: decode straight back with no channel, confirms the
        # encoder/decoder agree on placement before any platform is involved
        yb = np.asarray(Image.open(io.BytesIO(stego)).convert("YCbCr").split()[0], float)
        got = extract(yb, qt, len(bits), delta, 1, 12, KEY, spread, adaptive)
        per = len(cw) * 8
        votes = [got[k * per:(k + 1) * per] for k in range(args.repeat)
                 if len(got[k * per:(k + 1) * per]) == per]
        merged = [1 if sum(c) * 2 > len(votes) else 0 for c in zip(*votes)] if votes else got[:per]
        selftest = unframe(from_bits(merged), 64) == payload

        print(f"{fn.name:<34} {delta:>5.0f} {m['psnr']:>6.1f} {m['raw_local']:>7.2f} "
              f"{m['masked_vis']:>7.3f} {m['covered']*100:>5.0f}% "
              f"{'ok' if selftest else 'FAILED':>10}")
        records.append({"file": fn.name, "delta": delta, "spread": spread,
                        "adaptive": adaptive, "payload": args.payload,
                        "repeat": args.repeat, "width": args.width,
                        "post": post, **m})

    (out / "compare.json").write_text(json.dumps(records, indent=2))

    print(f"\nwrote {len(records)} files + z00_clean_reference.jpg to {out}/")
    print("\nLook at these before sending anything:")
    print("  1. Open z00_clean_reference.jpg and old_raster_flat_POST.jpg side by side,")
    print("     full screen. The old scheme should show speckle in smooth areas,")
    print("     concentrated in the top third of the frame.")
    print("  2. Now compare against new_spread_adaptive_POST.jpg. Same payload, same")
    print("     step size. Perturbation is spread over the whole frame and weighted")
    print("     into texture, so smooth areas should look markedly cleaner.")
    print("  3. If the new one looks clean, post BOTH _POST files and decode them")
    print("     to confirm the real channel agrees.")
    print("\nThe metric to trust is MASKED, not PSNR: PSNR averages the frame and so")
    print("cannot see concentration, which is exactly what makes dotting visible.")


if __name__ == "__main__":
    main()
