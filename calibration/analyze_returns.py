#!/usr/bin/env python3
"""
analyze_returns.py — measure what real platforms actually do to images.

Feed it the charts you generated and the files that came back from real
WhatsApp / Telegram / Instagram, and it will report, per platform:

  * the resize threshold (what max dimension is enforced, if any)
  * the EXACT luma and chroma quantization tables the platform used
  * chroma subsampling mode
  * an estimated IJG quality factor (for comparison with the old simulator)
  * whether the returned file shows signs of a second recompression
  * a recommended per-frequency QIM step map

The quantization table is the point of this whole exercise. Stegstr's current
simulator calls Pillow with quality=65, which produces Pillow's Q65 table, not
WhatsApp's. And the encoder uses a single flat QIM_DELTA = 14 for all 64
frequencies, while a real quantization table ranges from roughly 8 at low
frequencies to 100+ at high ones. Bits written into frequencies where the
channel's step is much larger than delta are destroyed deterministically, before
Reed-Solomon ever sees them. Reading the real table tells us exactly where that
happens.

Layout expected:

    charts/
        chart_w1600.png
    returns/
        whatsapp/chart_w1600.jpg
        telegram_photo/chart_w1600.jpg
        instagram/chart_w1600.jpg

Usage:
    python3 analyze_returns.py --charts charts/ --returns returns/
    python3 analyze_returns.py --charts charts/ --returns returns/ --emit channel_measured.py
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

# Annex K luma table, the IJG baseline at quality 50.
STD_LUMA_Q50 = np.array([
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
], dtype=float)

SUBSAMPLING_NAMES = {0: "4:4:4", 1: "4:2:2", 2: "4:2:0", -1: "unknown"}


def estimate_quality(qtable: np.ndarray) -> float:
    """
    Estimate the IJG quality factor that would produce this table.

    Least-squares fit against the Annex K scaling rule. Platforms often use
    custom tables that no single quality reproduces, so treat this as a rough
    comparison figure only -- the table itself is the ground truth.
    """
    best_q, best_err = 0.0, float("inf")
    for q in range(1, 101):
        scale = 5000.0 / q if q < 50 else 200.0 - 2.0 * q
        pred = np.clip(np.floor((STD_LUMA_Q50 * scale + 50.0) / 100.0), 1, 255)
        err = float(np.mean((pred - qtable) ** 2))
        if err < best_err:
            best_err, best_q = err, float(q)
    return best_q


def get_subsampling(img: Image.Image) -> int:
    try:
        from PIL import JpegImagePlugin
        return JpegImagePlugin.get_sampling(img)
    except Exception:
        return -1


def double_compression_score(img: Image.Image) -> float | None:
    """
    Rough double-compression indicator.

    Re-compressing an already-JPEG image leaves periodic gaps and spikes in the
    histogram of dequantized DCT coefficients. We score the first few AC
    frequencies for that periodicity. High score => likely recompressed more
    than once, which means the channel is harsher than a single pass and any
    single-pass model will be optimistic.

    Heuristic. Use it to flag platforms worth investigating, not as proof.
    """
    try:
        gray = img.convert("L")
        a = np.asarray(gray, dtype=float) - 128.0
        h, w = a.shape
        h, w = (h // 8) * 8, (w // 8) * 8
        if h < 64 or w < 64:
            return None
        a = a[:h, :w]
        blocks = a.reshape(h // 8, 8, w // 8, 8).transpose(0, 2, 1, 3)

        # 2D DCT-II via matrix multiply
        x = np.arange(8)
        basis = np.cos((2 * x[None, :] + 1) * x[:, None] * np.pi / 16.0)
        basis *= np.where(np.arange(8)[:, None] == 0, np.sqrt(1 / 8), np.sqrt(2 / 8))
        coeffs = basis @ blocks @ basis.T

        scores = []
        for (u, v) in [(0, 1), (1, 0), (1, 1), (0, 2), (2, 0)]:
            vals = coeffs[:, :, u, v].ravel()
            vals = vals[np.abs(vals) < 200]
            if vals.size < 200:
                continue
            hist, _ = np.histogram(vals, bins=201, range=(-100, 100))
            spec = np.abs(np.fft.rfft(hist - hist.mean()))
            if spec.size > 4:
                # energy away from DC relative to total, peaky => periodic
                scores.append(float(spec[2:].max() / (spec[1:].mean() + 1e-9)))
        return float(np.mean(scores)) if scores else None
    except Exception:
        return None


def analyze_file(path: Path, source_dims: tuple[int, int] | None) -> dict:
    img = Image.open(path)
    img.load()

    rec: dict = {
        "file": path.name,
        "format": img.format,
        "size": [img.width, img.height],
        "bytes": path.stat().st_size,
    }
    if source_dims:
        sw, sh = source_dims
        rec["source_size"] = [sw, sh]
        rec["resized"] = (img.width, img.height) != (sw, sh)
        rec["scale"] = round(img.width / sw, 4) if sw else None

    if img.format != "JPEG":
        rec["note"] = "not JPEG - platform preserved format (lossless path)"
        return rec

    qt = getattr(img, "quantization", {}) or {}
    tables = {}
    for tid, tbl in qt.items():
        arr = np.array(tbl, dtype=float)
        tables[str(tid)] = arr.astype(int).tolist()
    rec["quant_tables"] = tables

    if "0" in tables:
        luma = np.array(tables["0"], dtype=float)
        rec["est_quality_luma"] = estimate_quality(luma)
        rec["luma_step_min"] = int(luma.min())
        rec["luma_step_max"] = int(luma.max())
        rec["luma_step_mean"] = round(float(luma.mean()), 2)

    ss = get_subsampling(img)
    rec["subsampling"] = ss
    rec["subsampling_name"] = SUBSAMPLING_NAMES.get(ss, str(ss))
    rec["progressive"] = bool(img.info.get("progressive", 0))

    dc = double_compression_score(img)
    if dc is not None:
        rec["double_compression_score"] = round(dc, 2)

    return rec


def width_from_name(name: str) -> int | None:
    m = re.search(r"_w(\d+)", name)
    return int(m.group(1)) if m else None


def summarize_platform(name: str, records: list[dict]) -> dict:
    jpegs = [r for r in records if r.get("format") == "JPEG"]
    summary: dict = {"platform": name, "n_samples": len(records), "n_jpeg": len(jpegs)}

    resized = [r for r in records if r.get("resized")]
    unresized = [r for r in records if r.get("resized") is False]
    if unresized:
        summary["max_width_preserved"] = max(r["size"][0] for r in unresized)
    if resized:
        summary["min_width_resized_from"] = min(r["source_size"][0] for r in resized)
        summary["observed_output_widths"] = sorted({r["size"][0] for r in resized})
        summary["likely_max_width"] = max(r["size"][0] for r in resized)

    tables = [r["quant_tables"]["0"] for r in jpegs if r.get("quant_tables", {}).get("0")]
    if tables:
        arr = np.array(tables, dtype=float)
        consistent = bool(np.all(arr == arr[0]))
        summary["qtable_consistent_across_samples"] = consistent
        median = np.median(arr, axis=0)
        summary["luma_qtable"] = median.astype(int).tolist()
        summary["est_quality_luma"] = round(estimate_quality(median), 1)
        if not consistent:
            summary["qtable_note"] = (
                "Platform used different tables for different inputs - it likely "
                "adapts quality to image content or size. Model the worst case."
            )
        # Recommended QIM step per frequency: multiple of the channel's own step.
        for k in (2, 3):
            summary[f"recommended_qim_delta_k{k}"] = (median * k).astype(int).tolist()

    chroma = [r["quant_tables"]["1"] for r in jpegs if r.get("quant_tables", {}).get("1")]
    if chroma:
        summary["chroma_qtable"] = np.median(np.array(chroma, dtype=float), axis=0).astype(int).tolist()

    ss = {r.get("subsampling_name") for r in jpegs}
    if ss:
        summary["subsampling"] = sorted(s for s in ss if s)

    dcs = [r["double_compression_score"] for r in jpegs if "double_compression_score" in r]
    if dcs:
        summary["double_compression_score_mean"] = round(float(np.mean(dcs)), 2)

    return summary


def emit_channel_module(summaries: list[dict], path: Path) -> None:
    """Write a drop-in replacement for channel.py that uses MEASURED tables."""
    lines = [
        '"""',
        "channel_measured.py - AUTOGENERATED by analyze_returns.py",
        "",
        "Drop-in replacement for channel.py that reproduces real platform behaviour",
        "using quantization tables measured from actual round trips, instead of",
        "approximating with Pillow's quality=N.",
        "",
        "Do not hand-edit; regenerate from fresh measurements instead.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "import io",
        "from pathlib import Path",
        "",
        "from PIL import Image, ImageOps",
        "",
        "# platform -> dict(max_width, luma_qt, chroma_qt, subsampling)",
        "MEASURED_PROFILES = {",
    ]
    for s in summaries:
        if "luma_qtable" not in s:
            continue
        mw = s.get("likely_max_width") or s.get("max_width_preserved") or 0
        ssn = (s.get("subsampling") or ["4:2:0"])[0]
        ss_code = {"4:4:4": 0, "4:2:2": 1, "4:2:0": 2}.get(ssn, 2)
        lines.append(f'    "{s["platform"]}": {{')
        lines.append(f'        "max_width": {mw},')
        lines.append(f'        "subsampling": {ss_code},  # {ssn}')
        lines.append(f'        "est_quality": {s.get("est_quality_luma")},')
        lines.append(f'        "luma_qt": {s["luma_qtable"]},')
        if "chroma_qtable" in s:
            lines.append(f'        "chroma_qt": {s["chroma_qtable"]},')
        lines.append("    },")
    lines += [
        "}",
        "",
        "",
        "def simulate(input_path, profile_name, output_path=None) -> bytes:",
        '    """Resize + re-encode using the platform\'s MEASURED quantization tables."""',
        "    prof = MEASURED_PROFILES[profile_name]",
        "    img = Image.open(Path(input_path))",
        "    img.load()",
        "    img = ImageOps.exif_transpose(img)",
        '    if img.mode == "RGBA":',
        '        bg = Image.new("RGB", img.size, (255, 255, 255))',
        "        bg.paste(img, mask=img.split()[3])",
        "        img = bg",
        '    elif img.mode not in ("RGB", "L"):',
        '        img = img.convert("RGB")',
        '    mw = prof["max_width"]',
        "    if mw and img.width > mw:",
        "        ratio = mw / img.width",
        "        img = img.resize((mw, max(1, round(img.height * ratio))), Image.Resampling.LANCZOS)",
        '    qt = [prof["luma_qt"]]',
        '    if "chroma_qt" in prof:',
        '        qt.append(prof["chroma_qt"])',
        "    buf = io.BytesIO()",
        '    img.save(buf, format="JPEG", qtables=qt, subsampling=prof["subsampling"], optimize=False)',
        "    data = buf.getvalue()",
        "    if output_path is not None:",
        "        Path(output_path).write_bytes(data)",
        "    return data",
        "",
    ]
    path.write_text("\n".join(lines))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--charts", default="charts", help="directory of source charts")
    ap.add_argument("--returns", default="returns", help="directory of per-platform subfolders")
    ap.add_argument("--json", default="measured_profiles.json")
    ap.add_argument("--emit", default="channel_measured.py")
    args = ap.parse_args()

    chart_dims: dict[int, tuple[int, int]] = {}
    for p in sorted(Path(args.charts).glob("*.png")):
        w = width_from_name(p.name)
        if w:
            with Image.open(p) as im:
                chart_dims[w] = (im.width, im.height)

    returns_root = Path(args.returns)
    if not returns_root.exists():
        raise SystemExit(f"No returns directory at {returns_root}. Send the charts first.")

    per_platform: dict[str, list[dict]] = defaultdict(list)
    for platform_dir in sorted(d for d in returns_root.iterdir() if d.is_dir()):
        for f in sorted(platform_dir.iterdir()):
            if f.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".heic"}:
                continue
            w = width_from_name(f.name)
            per_platform[platform_dir.name].append(analyze_file(f, chart_dims.get(w) if w else None))

    if not per_platform:
        raise SystemExit("No files found under returns/. Expected returns/<platform>/chart_wNNNN.jpg")

    summaries = [summarize_platform(name, recs) for name, recs in per_platform.items()]

    for s in summaries:
        print("=" * 68)
        print(f"{s['platform']}   ({s['n_samples']} samples, {s['n_jpeg']} JPEG)")
        print("=" * 68)
        if "likely_max_width" in s:
            print(f"  resize          : caps width at ~{s['likely_max_width']}px")
            print(f"                    (resized anything from {s['min_width_resized_from']}px up)")
        if "max_width_preserved" in s:
            print(f"  passed through  : up to {s['max_width_preserved']}px unresized")
        if "subsampling" in s:
            print(f"  subsampling     : {', '.join(s['subsampling'])}")
        if "est_quality_luma" in s:
            print(f"  est. quality    : ~Q{s['est_quality_luma']}")
        if "luma_qtable" in s:
            lq = np.array(s["luma_qtable"])
            print(f"  luma qtable     : min {int(lq.min())}  max {int(lq.max())}  mean {lq.mean():.1f}")
            print(f"                    DC..first ACs: {lq[:8].astype(int).tolist()}")
            print(f"                    high freq    : {lq[-8:].astype(int).tolist()}")
            flat = 14  # Stegstr's current QIM_DELTA
            starved = int((lq > flat).sum())
            print(f"  vs QIM_DELTA=14 : {starved}/64 frequencies have a channel step LARGER")
            print(f"                    than delta - bits there are destroyed by design.")
        if s.get("qtable_consistent_across_samples") is False:
            print(f"  ! {s['qtable_note']}")
        if "double_compression_score_mean" in s:
            print(f"  double-compress : score {s['double_compression_score_mean']} (higher = more likely multi-pass)")
        print()

    Path(args.json).write_text(json.dumps({"platforms": summaries}, indent=2))
    print(f"wrote {args.json}")

    if args.emit:
        emit_channel_module(summaries, Path(args.emit))
        print(f"wrote {args.emit}  (drop-in replacement for channel_simulator/channel.py)")


if __name__ == "__main__":
    main()
