#!/usr/bin/env python3
"""
Telegram-as-photo re-encode cost, and where the artifact actually sits.

Answers two questions from one pair of round trips (pointer mode on and off):

  1. What does Telegram's re-encode cost? (HANDOFF 15.15 item 1, the missing
     per-channel number.) PSNR of the return against what was uploaded, plus
     drift percentiles on the carrier coefficient -- the number that decides
     whether delta 28 can come down.

  2. Where does the embedding live? 15.2 measured that blocks fill in RASTER
     order, so a small payload lands entirely in the top rows. If that holds,
     a pointer's artifact is the same intensity over less area, dumped on
     whatever is at the top of the frame -- which is why shrinking the payload
     60x did not look 60x better.

Reference-free by design: QIM leaves the carrier coefficient sitting near
lattice points at delta/4 offsets, so embedded blocks can be told from
untouched ones without a clean original to compare against.

Usage:  analyze_pointer_pair.py SENT RETURNED [--label NAME] [--delta N]
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image


def _dct_matrix() -> np.ndarray:
    n = np.arange(8)
    m = np.cos((2 * n[None, :] + 1) * n[:, None] * np.pi / 16.0)
    m *= np.where(n[:, None] == 0, np.sqrt(1 / 8), np.sqrt(2 / 8))
    return m


D = _dct_matrix()


def luma(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("YCbCr").split()[0], dtype=np.float64)


def blocks(y: np.ndarray) -> np.ndarray:
    h, w = (y.shape[0] // 8) * 8, (y.shape[1] // 8) * 8
    y = y[:h, :w]
    return y.reshape(h // 8, 8, w // 8, 8).transpose(0, 2, 1, 3)


def coeffs(y: np.ndarray) -> np.ndarray:
    """Unquantized DCT of the decoded pixels; same convention as qim_ber.py."""
    return D @ blocks(y - 128.0) @ D.T


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a - b) ** 2))
    return float("inf") if mse == 0 else 10.0 * np.log10(255.0 ** 2 / mse)


def pct(x: np.ndarray) -> str:
    q = np.percentile(np.abs(x), [50, 90, 99, 99.9])
    return f"p50 {q[0]:.2f}  p90 {q[1]:.2f}  p99 {q[2]:.2f}  p99.9 {q[3]:.2f}  max {np.abs(x).max():.2f}"


def lattice_distance(c: np.ndarray, delta: float) -> np.ndarray:
    """
    Distance from the nearest QIM decision point, normalised to delta/4.

    An embedded coefficient was written to cell +/- delta/4, so it sits near 1.0
    before the channel touches it. An untouched coefficient is uniform in the
    cell, averaging ~1.0 as well -- so the DISCRIMINATOR is the spread, not the
    mean: embedded blocks cluster, untouched ones do not.
    """
    cell = np.round(c / delta) * delta
    off = np.abs(c - cell)
    return off / (delta / 4.0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("sent", type=Path)
    ap.add_argument("returned", type=Path)
    ap.add_argument("--label", default="")
    ap.add_argument("--delta", type=float, default=28.0)
    a = ap.parse_args()

    ys, yr = luma(a.sent), luma(a.returned)
    if ys.shape != yr.shape:
        raise SystemExit(f"geometry differs: sent {ys.shape} vs returned {yr.shape} -- resize destroys the grid")

    print(f"=== {a.label or a.sent.name} ===")
    print(f"geometry {ys.shape[1]}x{ys.shape[0]}   sent {a.sent.stat().st_size}B   returned {a.returned.stat().st_size}B")
    print(f"luma PSNR (returned vs sent): {psnr(ys, yr):.1f} dB")

    cs, cr = coeffs(ys), coeffs(yr)
    # Zigzag position 1 is (0,1): the horizontal coefficient 15.2 measured as
    # carrying 43% of the embedding energy, i.e. the one that matters.
    carrier_s = cs[:, :, 0, 1]
    carrier_r = cr[:, :, 0, 1]
    drift = carrier_r - carrier_s
    print(f"carrier (0,1) drift, raw DCT units:  {pct(drift)}")
    print(f"  as a fraction of the delta/2 decision margin ({a.delta/2:.0f}): "
          f"p99.9 = {np.percentile(np.abs(drift), 99.9) / (a.delta / 2):.1%}")

    # Where is the payload? Split the frame into thirds by block row and look
    # at how tightly the carrier clusters on the QIM lattice in each.
    ld = lattice_distance(carrier_s, a.delta)
    nby = ld.shape[0]
    thirds = [("top   ", ld[: nby // 3]), ("middle", ld[nby // 3: 2 * nby // 3]), ("bottom", ld[2 * nby // 3:])]
    print("carrier clustering on the QIM lattice (std of |offset| / (delta/4); lower = embedded):")
    for name, part in thirds:
        print(f"  {name}  mean {part.mean():.3f}   std {part.std():.3f}")


if __name__ == "__main__":
    main()
