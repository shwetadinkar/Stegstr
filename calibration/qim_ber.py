#!/usr/bin/env python3
"""
qim_ber.py — measure QIM bit error rate through the measured real channel.

Tests the hypothesis that Stegstr's WhatsApp failure is a quantization-DOMAIN
mismatch, not an error-budget shortfall.

QIM encodes a bit by pushing a quantized DCT coefficient onto one of two
reconstruction levels spaced delta apart. "Quantized" is only meaningful
relative to a quantization table. Stegstr embeds into a JPEG written at Q75 with
Pillow's table (QIM_EMBED_QUALITY = 75) and then decodes coefficients that the
platform has requantized with ITS table. Encoder and decoder are measuring the
lattice in different units.

The stretch factor per frequency is q_embed[f] / q_channel[f]. Pillow's Q65 and
Q75 are both Annex K scaled by a constant, so against the simulator that ratio
is a UNIFORM 0.71 -- a uniform stretch, which repetition and RS(128) can partly
absorb. WhatsApp uses a custom table whose shape is nothing like Annex K, so the
ratio varies per frequency. The lattice is warped, not merely scaled, and no
amount of parity fixes that.

Configurations compared:

  baseline  cover at Q75 / Pillow table, delta = 14, coefficients taken in
            zigzag order across the block -- Stegstr's current settings.
  matched   cover written with the CHANNEL'S measured table at a size the
            channel will not resize, small delta in quantized units, embedding
            confined to low-frequency positions.

Usage:
    python3 qim_ber.py --image charts/chart_w1600.png
    python3 qim_ber.py --image photo.jpg --bits 4096
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image

ZIGZAG = [
    (0, 0), (0, 1), (1, 0), (2, 0), (1, 1), (0, 2), (0, 3), (1, 2),
    (2, 1), (3, 0), (4, 0), (3, 1), (2, 2), (1, 3), (0, 4), (0, 5),
    (1, 4), (2, 3), (3, 2), (4, 1), (5, 0), (6, 0), (5, 1), (4, 2),
    (3, 3), (2, 4), (1, 5), (0, 6), (0, 7), (1, 6), (2, 5), (3, 4),
    (4, 3), (5, 2), (6, 1), (7, 0), (7, 1), (6, 2), (5, 3), (4, 4),
    (3, 5), (2, 6), (1, 7), (2, 7), (3, 6), (4, 5), (5, 4), (6, 3),
    (7, 2), (7, 3), (6, 4), (5, 5), (4, 6), (3, 7), (4, 7), (5, 6),
    (6, 5), (7, 4), (7, 5), (6, 6), (5, 7), (6, 7), (7, 6), (7, 7),
]


def _dct_matrix() -> np.ndarray:
    n = np.arange(8)
    m = np.cos((2 * n[None, :] + 1) * n[:, None] * np.pi / 16.0)
    m *= np.where(n[:, None] == 0, np.sqrt(1 / 8), np.sqrt(2 / 8))
    return m


D = _dct_matrix()


def pixels_to_blocks(y: np.ndarray) -> np.ndarray:
    h, w = (y.shape[0] // 8) * 8, (y.shape[1] // 8) * 8
    y = y[:h, :w]
    return y.reshape(h // 8, 8, w // 8, 8).transpose(0, 2, 1, 3)


def blocks_to_pixels(b: np.ndarray) -> np.ndarray:
    nby, nbx = b.shape[0], b.shape[1]
    return b.transpose(0, 2, 1, 3).reshape(nby * 8, nbx * 8)


def fwd(y: np.ndarray, qt: np.ndarray) -> np.ndarray:
    return np.round((D @ pixels_to_blocks(y - 128.0) @ D.T) / qt)


def inv(q: np.ndarray, qt: np.ndarray) -> np.ndarray:
    return np.clip(blocks_to_pixels(D.T @ (q * qt) @ D) + 128.0, 0, 255)


def qim_embed(c: np.ndarray, bit: int, delta: float) -> np.ndarray:
    cell = np.round(c / delta) * delta
    return cell + (delta / 4.0) * (1 if bit else -1)


def qim_detect(z: np.ndarray, delta: float) -> np.ndarray:
    cell = np.round(z / delta) * delta
    return (np.abs(z - (cell + delta / 4.0)) < np.abs(z - (cell - delta / 4.0))).astype(int)


def save_jpeg(pix: np.ndarray, qt: np.ndarray | None, quality: int | None, ss: int) -> bytes:
    img = Image.fromarray(pix.astype(np.uint8), mode="L").convert("RGB")
    buf = io.BytesIO()
    kw: dict = {"format": "JPEG", "subsampling": ss, "optimize": False}
    if qt is not None:
        kw["qtables"] = [qt.astype(int).ravel().tolist()] * 2
    else:
        kw["quality"] = quality
    img.save(buf, **kw)
    return buf.getvalue()


def trial(img: Image.Image, prof: dict, mode: str, nbits: int, seed: int = 11) -> dict:
    ch_qt = np.array(prof["luma_qt"], dtype=float).reshape(8, 8)
    ss, mw = prof["subsampling"], prof["max_width"]

    work = img.convert("L")
    if mw and work.width > mw:
        r = mw / work.width
        work = work.resize((mw, max(1, round(work.height * r))), Image.Resampling.LANCZOS)
    y = np.asarray(work, dtype=np.float64)

    if mode == "baseline":
        # Stegstr today: Q75 Pillow table, flat delta 14, zigzag across whole block.
        probe = save_jpeg(y, None, 75, 0)
        emb_qt = np.array(Image.open(io.BytesIO(probe)).quantization[0], dtype=float).reshape(8, 8)
        delta, positions, out_ss = 14.0, list(range(1, 25)), 0
    else:
        # Proposed: embed in the channel's own table, low frequencies, small delta.
        emb_qt, delta, positions, out_ss = ch_qt, 3.0, list(range(1, 13)), ss

    coeffs = fwd(y, emb_qt)
    nby, nbx = coeffs.shape[0], coeffs.shape[1]
    slots = [(by, bx, zi) for by in range(nby) for bx in range(nbx) for zi in positions]
    nbits = min(nbits, len(slots))

    rng = np.random.default_rng(seed)
    bits = rng.integers(0, 2, nbits)

    for i in range(nbits):
        by, bx, zi = slots[i]
        u, v = ZIGZAG[zi]
        coeffs[by, bx, u, v] = qim_embed(coeffs[by, bx, u, v], int(bits[i]), delta)

    stego_bytes = save_jpeg(inv(coeffs, emb_qt), emb_qt, None, out_ss)

    # Channel: resize if oversized, re-encode with the platform's table.
    rec = Image.open(io.BytesIO(stego_bytes)).convert("RGB")
    if mw and rec.width > mw:
        r = mw / rec.width
        rec = rec.resize((mw, max(1, round(rec.height * r))), Image.Resampling.LANCZOS)
    recv_bytes = save_jpeg(np.asarray(rec.convert("L"), dtype=np.float64), ch_qt, None, ss)

    got = fwd(np.asarray(Image.open(io.BytesIO(recv_bytes)).convert("L"), dtype=np.float64), ch_qt)

    out = np.zeros(nbits, dtype=int)
    for i in range(nbits):
        by, bx, zi = slots[i]
        u, v = ZIGZAG[zi]
        if by < got.shape[0] and bx < got.shape[1]:
            out[i] = qim_detect(got[by, bx, u, v], delta)

    errors = int((out != bits).sum())

    # Visual cost of embedding
    clean = np.asarray(Image.open(io.BytesIO(save_jpeg(y, emb_qt, None, out_ss))).convert("L"), float)
    steg = np.asarray(Image.open(io.BytesIO(stego_bytes)).convert("L"), float)
    n = min(clean.shape[0], steg.shape[0]), min(clean.shape[1], steg.shape[1])
    mse = float(np.mean((clean[:n[0], :n[1]] - steg[:n[0], :n[1]]) ** 2))
    psnr = 10 * np.log10(255.0 ** 2 / mse) if mse > 1e-9 else float("inf")

    ratio = emb_qt / ch_qt
    return {
        "mode": mode, "bits": nbits, "errors": errors, "ber": errors / nbits,
        "delta": delta, "positions": f"zigzag {positions[0]}-{positions[-1]}",
        "psnr": psnr, "capacity_slots": len(slots),
        "ratio_min": float(ratio.min()), "ratio_max": float(ratio.max()),
        "table_matched": bool(np.array_equal(emb_qt, ch_qt)),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", required=True)
    ap.add_argument("--profiles", default="measured_profiles.json")
    ap.add_argument("--platform", default="whatsapp")
    ap.add_argument("--bits", type=int, default=4096)
    args = ap.parse_args()

    data = json.loads(Path(args.profiles).read_text())
    s = next(p for p in data["platforms"] if p["platform"] == args.platform)
    prof = {
        "luma_qt": s["luma_qtable"],
        "max_width": s.get("likely_max_width") or s.get("max_width_preserved") or 0,
        "subsampling": {"4:4:4": 0, "4:2:2": 1, "4:2:0": 2}.get((s.get("subsampling") or ["4:2:0"])[0], 2),
    }

    img = Image.open(args.image)
    print(f"\ncover {args.image} ({img.width}x{img.height})  channel={args.platform} "
          f"max_width={prof['max_width']}  payload={args.bits} bits\n")

    rows = [trial(img, prof, m, args.bits) for m in ("baseline", "matched")]
    for r in rows:
        print(f"--- {r['mode']}")
        print(f"    embed table matches channel : {r['table_matched']}")
        print(f"    q_embed/q_channel spread    : {r['ratio_min']:.2f} .. {r['ratio_max']:.2f}"
              + ("   <-- lattice warped per frequency" if r['ratio_max'] / max(r['ratio_min'], 1e-9) > 1.2 else ""))
        print(f"    delta / positions           : {r['delta']:.0f}  ({r['positions']})")
        print(f"    bit errors                  : {r['errors']}/{r['bits']}   BER {r['ber']*100:.2f}%")
        print(f"    stego PSNR vs clean         : {r['psnr']:.1f} dB")
        print(f"    capacity at these settings  : {r['capacity_slots']:,} slots")
        print()

    b, m = rows
    print("=" * 62)
    print(f"  BER   baseline {b['ber']*100:6.2f}%   ->   matched {m['ber']*100:6.2f}%")
    rs_limit = 0.5 * 128 / 255
    for r in rows:
        verdict = "recoverable" if r["ber"] < rs_limit * 0.5 else "TOO MANY ERRORS for RS(128)"
        print(f"  {r['mode']:<9} {verdict}")
    print("=" * 62)


if __name__ == "__main__":
    main()
