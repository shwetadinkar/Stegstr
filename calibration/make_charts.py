#!/usr/bin/env python3
"""
make_charts.py — generate calibration charts for real-platform round-trip testing.

Produces a set of PNG test charts at several widths. You send these through the
real platforms (WhatsApp, Telegram, Instagram, ...), save what comes back, and
feed the returned files to analyze_returns.py.

The charts are designed so that the ANALYSIS is possible, not so they look nice:

  - A 'resize probe' of fine 1px checkerboard + slanted edges. If the platform
    resizes, these alias in a way that is measurable.
  - Flat mid-grey patches. JPEG quantization noise on a flat field is a clean
    readout of the effective quality.
  - A DCT-frequency sweep (per-block sinusoids at each of the 64 basis
    frequencies). This is the important one: after the round trip we can see
    WHICH frequencies survived and which were zeroed. That directly tells us
    where it is safe to embed.
  - Photographic-ish noise/gradient regions so the platform's encoder is not
    fed a pathological all-synthetic image (some pipelines behave differently
    on images they judge to be graphics vs photos).

Usage:
    python3 make_charts.py --out charts/
    python3 make_charts.py --out charts/ --widths 800 1600 2400 4096

Filenames encode the source width: chart_w1600.png
Keep that name when you send/receive so analyze_returns.py can pair them up.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

# Standard JPEG zigzag order: index -> (row, col) in the 8x8 block.
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


def _dct_basis(u: int, v: int) -> np.ndarray:
    """Return the 8x8 spatial pattern for DCT basis function (u, v), range -1..1."""
    x = np.arange(8)
    cu = np.cos((2 * x + 1) * u * np.pi / 16.0)
    cv = np.cos((2 * x + 1) * v * np.pi / 16.0)
    return np.outer(cu, cv)


def _frequency_sweep(block_rows: int, block_cols: int, amplitude: float = 28.0) -> np.ndarray:
    """
    Tile an area with 8x8 blocks, each carrying one DCT basis frequency at a
    known amplitude, cycling through all 64 frequencies in zigzag order.

    After a platform round trip we re-measure the amplitude of each frequency.
    Frequencies that come back near zero are ones the channel destroys.
    """
    h, w = block_rows * 8, block_cols * 8
    out = np.full((h, w), 128.0)
    for by in range(block_rows):
        for bx in range(block_cols):
            zi = (by * block_cols + bx) % 64
            u, v = ZIGZAG[zi]
            if u == 0 and v == 0:
                # DC block: leave flat, acts as a reference patch.
                continue
            out[by * 8:(by + 1) * 8, bx * 8:(bx + 1) * 8] = 128.0 + amplitude * _dct_basis(u, v)
    return out


def _resize_probe(h: int, w: int) -> np.ndarray:
    """1px checkerboard plus slanted edges — aliases visibly under any resample."""
    yy, xx = np.mgrid[0:h, 0:w]
    checker = np.where((xx + yy) % 2 == 0, 210.0, 46.0)
    # Slanted edge across the middle third
    slant = (xx * 0.35 + yy * 1.0)
    edges = np.where((slant.astype(int) // 12) % 2 == 0, 200.0, 56.0)
    band = (yy > h // 3) & (yy < 2 * h // 3)
    return np.where(band, edges, checker)


def _gradient(h: int, w: int) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    return 16.0 + (xx / max(1, w - 1)) * 223.0 + (yy / max(1, h - 1)) * 16.0


def _noise(h: int, w: int, seed: int = 7) -> np.ndarray:
    """Band-limited noise — stands in for photographic texture."""
    rng = np.random.default_rng(seed)
    small = rng.normal(128, 34, size=(max(2, h // 8), max(2, w // 8)))
    img = Image.fromarray(np.clip(small, 0, 255).astype(np.uint8))
    img = img.resize((w, h), Image.Resampling.BICUBIC)
    return np.asarray(img, dtype=float)


def _flat_patches(h: int, w: int) -> np.ndarray:
    """Flat tones. Quantization noise on these is a clean quality readout."""
    out = np.zeros((h, w))
    levels = [32, 64, 96, 128, 160, 192, 224]
    cw = max(1, w // len(levels))
    for i, lv in enumerate(levels):
        out[:, i * cw:(i + 1) * cw] = lv
    out[:, len(levels) * cw:] = levels[-1]
    return out


def build_chart(width: int) -> Image.Image:
    """
    Compose one calibration chart at the given width.

    Layout (top to bottom), heights are fractions of an 8-aligned canvas:
        1. frequency sweep   (40%)  <- the critical band
        2. flat patches      (15%)
        3. resize probe      (20%)
        4. gradient          (12%)
        5. noise             (13%)
    """
    width = (width // 8) * 8
    height = (int(width * 0.75) // 8) * 8

    def rows(frac: float) -> int:
        return max(8, (int(height * frac) // 8) * 8)

    h_sweep = rows(0.40)
    h_flat = rows(0.15)
    h_probe = rows(0.20)
    h_grad = rows(0.12)
    h_noise = height - (h_sweep + h_flat + h_probe + h_grad)
    if h_noise < 8:
        h_noise = 8
        height = h_sweep + h_flat + h_probe + h_grad + h_noise

    bands = [
        _frequency_sweep(h_sweep // 8, width // 8),
        _flat_patches(h_flat, width),
        _resize_probe(h_probe, width),
        _gradient(h_grad, width),
        _noise(h_noise, width),
    ]
    canvas = np.vstack([b[: , :width] for b in bands])
    canvas = np.clip(canvas, 0, 255).astype(np.uint8)
    rgb = np.dstack([canvas, canvas, canvas])
    return Image.fromarray(rgb, mode="RGB")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="charts", help="output directory")
    ap.add_argument(
        "--widths",
        type=int,
        nargs="+",
        default=[640, 800, 1280, 1600, 2400, 4096],
        help="source widths to generate",
    )
    args = ap.parse_args()

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    for w in args.widths:
        img = build_chart(w)
        path = outdir / f"chart_w{w}.png"
        img.save(path, "PNG")
        print(f"wrote {path}  ({img.width}x{img.height})")

    print(
        "\nNext:\n"
        "  1. Send every chart through each platform you care about.\n"
        "     WhatsApp  -> message yourself, normal photo share (NOT 'document')\n"
        "     Telegram  -> Saved Messages, send twice: as Photo and as File\n"
        "     Instagram -> DM to yourself\n"
        "  2. Save what comes back into a folder per platform, e.g.\n"
        "       returns/whatsapp/chart_w1600.jpg\n"
        "       returns/telegram_photo/chart_w1600.jpg\n"
        "     Keep the chart_wNNNN stem so sources can be paired.\n"
        "  3. python3 analyze_returns.py --charts charts/ --returns returns/\n"
    )


if __name__ == "__main__":
    main()
