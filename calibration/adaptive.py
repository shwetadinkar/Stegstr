#!/usr/bin/env python3
"""
adaptive.py — keyed spreading + texture-adaptive step size.

Two changes to how bits are placed. Neither changes the QIM primitive; both
change WHERE and HOW HARD it is applied.

1. KEYED SPREADING
   Blocks currently fill in raster order, so a payload occupies the top of the
   frame at maximum density and leaves the rest untouched. Visible dotting is a
   LOCAL phenomenon -- the eye finds concentrated speckle far more readily than
   the same number of perturbations scattered thinly. A keyed permutation of the
   slot order spreads the identical payload over the whole frame, cutting local
   density several-fold at identical embedding energy.

   It also removes a structural weakness: with a keyed order there is no fixed
   place to look. Stegstr's current format embeds a literal "STEGSTR" magic at a
   known offset, so presence detection is a string match. Keyed placement plus no
   plaintext marker means an attacker cannot even locate the payload.

2. TEXTURE-ADAPTIVE STEP SIZE
   Texture masks perturbation; smooth regions do not. The dotting seen on
   Instagram appeared in ceiling tiles and walls, not in clothing or clutter.
   So scale delta per block by local activity: large where texture hides it,
   small where it would show.

   The constraint that shapes this: the decoder must agree with the encoder
   about which blocks carry which bits, and it only ever sees the channel-
   damaged image. Selecting blocks by a threshold is therefore unsafe -- a block
   near the boundary can flip sides after compression, shifting every subsequent
   bit and destroying the whole payload.

   This implementation avoids selection entirely. EVERY block stays in play at a
   fixed keyed order; only delta is modulated. Bit positions never move, so a
   texture misestimate costs one bit -- an ordinary error Reed-Solomon absorbs --
   instead of desynchronising the stream. Activity is measured from a heavily
   quantized version of the block so encoder and decoder agree despite channel
   damage, and the result is snapped to a small ladder of discrete levels so
   near-boundary blocks land on the same rung either side of the channel.

Usage:
    python3 adaptive.py --image photo.jpg --payload 4096
    python3 adaptive.py --image photo.jpg --payload 4096 --platform instagram
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image

from round2 import (ZIGZAG, fwd, inv, q_emb, q_det, save_colour, load_ycc,
                    frame, unframe, to_bits, from_bits)

# Discrete multiplier ladder. Snapping to rungs makes the encoder and decoder
# agree on blocks whose activity sits near a boundary.
LADDER = np.array([0.55, 0.8, 1.15, 1.6, 2.2])
# Normalised at use so the MEAN step over the blocks actually used stays equal
# to the flat-delta baseline. Adaptive should REDISTRIBUTE embedding energy
# into texture, not simply add more of it -- otherwise it trades invisibility
# for robustness rather than improving the tradeoff.


def block_activity(coeffs: np.ndarray, qt: np.ndarray) -> np.ndarray:
    """
    Per-block texture measure, computed so that encoder and decoder agree.

    Uses the sum of |quantized AC| over mid frequencies. Quantized values are
    already coarse, so they survive the channel far better than raw pixel
    variance would.
    """
    idx = [ZIGZAG[z] for z in range(3, 20)]
    act = np.zeros(coeffs.shape[:2])
    for u, v in idx:
        act += np.abs(coeffs[:, :, u, v])
    return act


def activity_to_rung(act: np.ndarray) -> np.ndarray:
    """Map activity to a ladder index using fixed absolute thresholds."""
    edges = np.array([4.0, 12.0, 30.0, 70.0])
    return np.digitize(act, edges)


def keyed_order(n: int, key: int) -> np.ndarray:
    rng = np.random.default_rng(key)
    idx = np.arange(n)
    rng.shuffle(idx)
    return idx


def build_slots(nby: int, nbx: int, lo: int, hi: int, key: int, spread: bool):
    slots = [(a, b, z) for a in range(nby) for b in range(nbx)
             for z in range(lo, hi + 1)]
    if spread:
        order = keyed_order(len(slots), key)
        slots = [slots[i] for i in order]
    return slots


def embed(y: np.ndarray, qt: np.ndarray, bits, delta: float, lo: int, hi: int,
          key: int, spread: bool, adaptive: bool):
    co = fwd(y, qt)
    slots = build_slots(co.shape[0], co.shape[1], lo, hi, key, spread)
    n = min(len(bits), len(slots))
    mult = None
    if adaptive:
        rung = activity_to_rung(block_activity(co, qt))
        mult = LADDER[rung]
        used = {(a, b) for a, b, _ in slots[:n]}
        vals = np.array([mult[a, b] for a, b in used])
        mult = mult / vals.mean()          # preserve mean step over used blocks
    for i in range(n):
        a, b, z = slots[i]
        u, v = ZIGZAG[z]
        d = delta * mult[a, b] if adaptive else delta
        co[a, b, u, v] = q_emb(float(co[a, b, u, v]), int(bits[i]), d)
    return inv(co, qt), len(slots), n


def extract(y: np.ndarray, qt: np.ndarray, nbits: int, delta: float, lo: int,
            hi: int, key: int, spread: bool, adaptive: bool):
    co = fwd(y, qt)
    slots = build_slots(co.shape[0], co.shape[1], lo, hi, key, spread)
    n = min(nbits, len(slots))
    mult = None
    if adaptive:
        rung = activity_to_rung(block_activity(co, qt))
        mult = LADDER[rung]
        used = {(a, b) for a, b, _ in slots[:n]}
        vals = np.array([mult[a, b] for a, b in used])
        mult = mult / vals.mean()
    out = []
    for i in range(n):
        a, b, z = slots[i]
        u, v = ZIGZAG[z]
        d = delta * mult[a, b] if adaptive else delta
        out.append(q_det(float(co[a, b, u, v]), d))
    return out


def local_density_map(before: np.ndarray, after: np.ndarray, blk: int = 32) -> np.ndarray:
    """RMS perturbation per tile — raw, ignores masking."""
    d = after.astype(float) - before.astype(float)
    h, w = (d.shape[0] // blk) * blk, (d.shape[1] // blk) * blk
    t = d[:h, :w].reshape(h // blk, blk, w // blk, blk)
    return np.sqrt((t ** 2).mean(axis=(1, 3)))


def masked_visibility_map(before: np.ndarray, after: np.ndarray, blk: int = 32) -> np.ndarray:
    """
    Perturbation relative to the texture that hides it.

    Raw RMS is the wrong yardstick for adaptive embedding: it scores a change
    in busy clutter the same as an identical change on a blank wall, when the
    eye finds only the second one. Dividing tile perturbation by tile texture
    (plus a floor, so perfectly flat tiles do not divide by zero) approximates
    contrast masking and is what the dotting you can actually see tracks.
    """
    d = after.astype(float) - before.astype(float)
    h, w = (d.shape[0] // blk) * blk, (d.shape[1] // blk) * blk
    t = d[:h, :w].reshape(h // blk, blk, w // blk, blk)
    pert = np.sqrt((t ** 2).mean(axis=(1, 3)))
    b = before[:h, :w].reshape(h // blk, blk, w // blk, blk)
    texture = b.std(axis=(1, 3))
    return pert / (texture + 2.0)


def run(cfg: dict, y0: np.ndarray, cb, cr, qt: np.ndarray, ss: int,
        payload: bytes, nsym: int, repeat: int, channel_fn):
    cw = frame(payload, nsym)
    bits = to_bits(cw) * repeat
    y1, capacity, used = embed(y0, qt, bits, cfg["delta"], cfg["lo"], cfg["hi"],
                               cfg["key"], cfg["spread"], cfg["adaptive"])
    if used < len(bits):
        return None

    stego = save_colour(y1, cb, cr, qt, ss)
    ref = save_colour(inv(fwd(y0, qt), qt), cb, cr, qt, ss)
    ra = np.asarray(Image.open(io.BytesIO(ref)).convert("L"), float)
    sa = np.asarray(Image.open(io.BytesIO(stego)).convert("L"), float)
    hh, ww = min(ra.shape[0], sa.shape[0]), min(ra.shape[1], sa.shape[1])
    mse = float(np.mean((ra[:hh, :ww] - sa[:hh, :ww]) ** 2))
    psnr = 10 * np.log10(255.0 ** 2 / mse) if mse > 1e-9 else 99.0

    dens = local_density_map(ra[:hh, :ww], sa[:hh, :ww])
    worst = float(np.percentile(dens, 99.5))
    covered = float((dens > 0.5).mean())
    vis = masked_visibility_map(ra[:hh, :ww], sa[:hh, :ww])
    worst_vis = float(np.percentile(vis, 99.5))

    recv = channel_fn(stego)
    yr = np.asarray(recv.convert("YCbCr").split()[0], float)
    raw = extract(yr, qt, len(bits), cfg["delta"], cfg["lo"], cfg["hi"],
                  cfg["key"], cfg["spread"], cfg["adaptive"])
    per = len(cw) * 8
    cwb = to_bits(cw)
    ber = float(np.mean([a != b for a, b in zip(raw[:per], cwb)])) if len(raw) >= per else 1.0
    votes = [raw[k * per:(k + 1) * per] for k in range(repeat)
             if len(raw[k * per:(k + 1) * per]) == per]
    merged = [1 if sum(c) * 2 > len(votes) else 0 for c in zip(*votes)] if votes else raw[:per]
    ok = unframe(from_bits(merged), nsym) == payload

    return {"psnr": psnr, "worst_local": worst, "worst_vis": worst_vis, "covered": covered,
            "ber": ber, "ok": ok, "capacity": capacity, "used": used}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", required=True)
    ap.add_argument("--profiles", default="measured_profiles.json")
    ap.add_argument("--platform", default="instagram")
    ap.add_argument("--payload", type=int, default=4096)
    ap.add_argument("--delta", type=float, default=16.0)
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--repeat", type=int, default=3)
    args = ap.parse_args()

    profs = json.loads(Path(args.profiles).read_text())["platforms"]
    prof = next(p for p in profs if p["platform"] == args.platform)
    qt = np.array(prof["luma_qtable"], float).reshape(8, 8)
    ss = 2

    y0, cb, cr = load_ycc(args.image, args.width, square=True)
    rng = np.random.default_rng(777)
    payload = bytes(rng.integers(0, 256, args.payload, dtype=np.uint8))

    def channel(stego_bytes: bytes) -> Image.Image:
        im = Image.open(io.BytesIO(stego_bytes)).convert("RGB")
        buf = io.BytesIO()
        im.convert("YCbCr").save(buf, format="JPEG",
                                 qtables=[qt.astype(int).ravel().tolist()] * 2,
                                 subsampling=ss, optimize=False, progressive=True)
        return Image.open(io.BytesIO(buf.getvalue()))

    configs = [
        {"name": "current (raster, flat d)", "spread": False, "adaptive": False},
        {"name": "keyed spread only", "spread": True, "adaptive": False},
        {"name": "adaptive delta only", "spread": False, "adaptive": True},
        {"name": "spread + adaptive", "spread": True, "adaptive": True},
    ]

    print(f"\ncover {args.image} -> {args.width}x{args.width} square, "
          f"channel {args.platform}, payload {args.payload}B, base delta {args.delta:g}\n")
    print(f"{'configuration':<26} {'PSNR':>6} {'raw local':>10} {'MASKED vis':>11} "
          f"{'frame':>6} {'BER':>7}  result")
    print("-" * 82)

    base = None
    for c in configs:
        cfg = {**c, "delta": args.delta, "lo": 1, "hi": 12, "key": 0xC0FFEE}
        r = run(cfg, y0, cb, cr, qt, ss, payload, 64, args.repeat, channel)
        if r is None:
            print(f"{c['name']:<26} does not fit")
            continue
        if base is None:
            base = r
        print(f"{c['name']:<26} {r['psnr']:>6.1f} {r['worst_local']:>10.2f} "
              f"{r['worst_vis']:>11.3f} {r['covered']*100:>5.0f}% {r['ber']*100:>6.2f}%  "
              f"{'PASS' if r['ok'] else 'FAIL'}")

    print("\nBoth metrics are 99.5th percentiles over 32x32 tiles; lower is better.")
    print("  raw local  : RMS perturbation, ignores masking")
    print("  MASKED vis : perturbation divided by local texture -- the one that")
    print("               tracks visible dotting, since the eye only notices change")
    print("               where there is little texture to hide it.")
    print("PSNR averages the whole frame and so hides concentration entirely.")


if __name__ == "__main__":
    main()
