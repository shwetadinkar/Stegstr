#!/usr/bin/env python3
"""
sweep.py — embed a grid of QIM variants, then measure real-channel BER.

Every variant costs one manual send through a real platform, so the design goal
is: emit a whole batch at once, send them in one go, then sort the returns out
automatically.

The platform renames files and near-identical stego images cannot be told apart
by eye, so each image carries a VISIBLE binary ID patch: high-contrast blocks in
the top-left corner encoding the variant number. It is ordinary image content,
not steganography, so it survives recompression and resize intact. That means a
variant identifies itself even when its hidden payload is destroyed -- which is
precisely the case we most need to record.

Two subcommands:

    python3 sweep.py embed  --image photo.jpg --out sweep/
    python3 sweep.py decode --manifest sweep/manifest.json --returns sweep_back/

Between them: send everything in sweep/ through the platform, save what comes
back into sweep_back/.

The variant grid covers, against the measured channel:
  * embed quantization table  (Pillow Q75 = current Stegstr, Pillow Q95,
    and the channel's own measured table)
  * QIM step size
  * which zigzag positions carry bits
  * chroma subsampling at embed time
  * cover width, including one oversized case that forces the platform to
    resize, to test block desynchronisation
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

ID_CELL = 40      # px per ID cell in the stego image
ID_BITS = 8       # up to 256 variants
ID_MARGIN = 8

PAYLOAD_SEED = 20260809


def _dct_matrix() -> np.ndarray:
    n = np.arange(8)
    m = np.cos((2 * n[None, :] + 1) * n[:, None] * np.pi / 16.0)
    m *= np.where(n[:, None] == 0, np.sqrt(1 / 8), np.sqrt(2 / 8))
    return m


D = _dct_matrix()


def to_blocks(y: np.ndarray) -> np.ndarray:
    h, w = (y.shape[0] // 8) * 8, (y.shape[1] // 8) * 8
    return y[:h, :w].reshape(h // 8, 8, w // 8, 8).transpose(0, 2, 1, 3)


def from_blocks(b: np.ndarray) -> np.ndarray:
    return b.transpose(0, 2, 1, 3).reshape(b.shape[0] * 8, b.shape[1] * 8)


def fwd(y: np.ndarray, qt: np.ndarray) -> np.ndarray:
    return np.round((D @ to_blocks(y - 128.0) @ D.T) / qt)


def inv(q: np.ndarray, qt: np.ndarray) -> np.ndarray:
    return np.clip(from_blocks(D.T @ (q * qt) @ D) + 128.0, 0, 255)


def qim_embed(c: float, bit: int, delta: float) -> float:
    return np.round(c / delta) * delta + (delta / 4.0) * (1 if bit else -1)


def qim_detect(z: float, delta: float) -> int:
    cell = np.round(z / delta) * delta
    return int(abs(z - (cell + delta / 4.0)) < abs(z - (cell - delta / 4.0)))


def pillow_table(quality: int) -> np.ndarray:
    buf = io.BytesIO()
    Image.new("RGB", (16, 16)).save(buf, format="JPEG", quality=quality)
    return np.array(Image.open(io.BytesIO(buf.getvalue())).quantization[0], float).reshape(8, 8)


def paint_id(y: np.ndarray, vid: int) -> np.ndarray:
    """Burn a readable binary ID into the top-left corner. Returns modified copy."""
    y = y.copy()
    x0 = ID_MARGIN
    y0 = ID_MARGIN
    # leading solid marker cell (always white) so the decoder can locate/scale
    y[y0:y0 + ID_CELL, x0:x0 + ID_CELL] = 255.0
    for i in range(ID_BITS):
        bit = (vid >> (ID_BITS - 1 - i)) & 1
        xa = x0 + (i + 1) * ID_CELL
        y[y0:y0 + ID_CELL, xa:xa + ID_CELL] = 255.0 if bit else 0.0
    # trailing solid black terminator
    xa = x0 + (ID_BITS + 1) * ID_CELL
    y[y0:y0 + ID_CELL, xa:xa + ID_CELL] = 0.0
    return y


def read_id(y: np.ndarray, scale: float) -> int | None:
    """Read the ID patch back, accounting for any resize the platform applied."""
    cell = ID_CELL * scale
    m = ID_MARGIN * scale
    if y.shape[0] < m + cell or y.shape[1] < m + cell * (ID_BITS + 2):
        return None

    def sample(idx: int) -> float:
        xa = m + idx * cell
        x1, x2 = int(xa + cell * 0.3), int(xa + cell * 0.7)
        y1, y2 = int(m + cell * 0.3), int(m + cell * 0.7)
        if x2 <= x1 or y2 <= y1:
            return 128.0
        return float(y[y1:y2, x1:x2].mean())

    lead, term = sample(0), sample(ID_BITS + 1)
    if lead < 160 or term > 95:          # marker sanity check
        return None
    vid = 0
    for i in range(ID_BITS):
        vid = (vid << 1) | (1 if sample(i + 1) > (lead + term) / 2 else 0)
    return vid


def id_blocked(nby: int, nbx: int, scale: float = 1.0) -> set[tuple[int, int]]:
    """8x8 blocks covered by the ID patch, excluded from embedding."""
    x_end = ID_MARGIN + ID_CELL * (ID_BITS + 2) + ID_CELL
    y_end = ID_MARGIN + ID_CELL * 2
    return {(by, bx) for by in range(min(nby, y_end // 8 + 1))
            for bx in range(min(nbx, x_end // 8 + 1))}


def save_jpeg(pix: np.ndarray, qt: np.ndarray, ss: int) -> bytes:
    img = Image.fromarray(pix.astype(np.uint8), mode="L").convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", qtables=[qt.astype(int).ravel().tolist()] * 2,
             subsampling=ss, optimize=False)
    return buf.getvalue()


def build_variants(ch_qt: np.ndarray) -> list[dict]:
    """The grid. Variant 1 replicates current Stegstr settings as the control."""
    q75, q95 = pillow_table(75), pillow_table(95)
    v: list[dict] = []

    def add(name, table, tname, delta, lo, hi, ss, width, note=""):
        v.append({"id": len(v) + 1, "name": name, "table": tname, "delta": delta,
                  "pos_lo": lo, "pos_hi": hi, "subsampling": ss, "width": width,
                  "note": note, "_qt": table})

    # --- control: what Stegstr does today -------------------------------
    add("baseline_stegstr", q75, "pillow_q75", 14, 1, 24, 0, 1600,
        "current QIM_EMBED_QUALITY=75, QIM_DELTA=14, 4:4:4")

    # --- matched table, step size sweep ---------------------------------
    for d in (2, 3, 4, 6, 8):
        add(f"matched_d{d}", ch_qt, "channel", d, 1, 12, 2, 1600,
            "channel table, low-frequency band")

    # --- matched table, position sweep at the best-guess step -----------
    add("matched_pos1_6", ch_qt, "channel", 3, 1, 6, 2, 1600, "very low freq only")
    add("matched_pos1_20", ch_qt, "channel", 3, 1, 20, 2, 1600, "wider band")
    add("matched_pos6_20", ch_qt, "channel", 3, 6, 20, 2, 1600, "mid band, skip lowest")

    # --- subsampling at embed time --------------------------------------
    add("matched_444", ch_qt, "channel", 3, 1, 12, 0, 1600, "embed 4:4:4 vs channel 4:2:0")

    # --- mismatched-but-high-quality embed ------------------------------
    add("pillow_q95_d14", q95, "pillow_q95", 14, 1, 24, 0, 1600, "high-quality mismatch")
    add("pillow_q75_d24", q75, "pillow_q75", 24, 1, 24, 0, 1600, "baseline with bigger step")
    add("pillow_q75_lowband", q75, "pillow_q75", 14, 1, 12, 0, 1600, "baseline, low band only")

    # --- resize path: oversized cover forces the platform to downscale ---
    add("matched_oversize", ch_qt, "channel", 3, 1, 12, 2, 2400, "forces platform resize")
    add("matched_d6_oversize", ch_qt, "channel", 6, 1, 12, 2, 2400, "resize + larger step")

    # --- smaller cover, well under the cap ------------------------------
    add("matched_small", ch_qt, "channel", 3, 1, 12, 2, 1080, "well under the cap")

    return v


def cmd_embed(args) -> None:
    data = json.loads(Path(args.profiles).read_text())
    s = next(p for p in data["platforms"] if p["platform"] == args.platform)
    ch_qt = np.array(s["luma_qtable"], float).reshape(8, 8)
    ss_map = {"4:4:4": 0, "4:2:2": 1, "4:2:0": 2}
    ch_ss = ss_map.get((s.get("subsampling") or ["4:2:0"])[0], 2)
    max_w = s.get("likely_max_width") or s.get("max_width_preserved") or 0

    src = Image.open(args.image).convert("L")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    variants = build_variants(ch_qt)
    rng = np.random.default_rng(PAYLOAD_SEED)
    bits_master = rng.integers(0, 2, args.bits)

    records = []
    for var in variants:
        w = var["width"]
        img = src
        if img.width != w:
            img = img.resize((w, max(1, round(img.height * w / img.width))), Image.Resampling.LANCZOS)
        y = paint_id(np.asarray(img, dtype=np.float64), var["id"])

        qt = var["_qt"]
        coeffs = fwd(y, qt)
        nby, nbx = coeffs.shape[0], coeffs.shape[1]
        blocked = id_blocked(nby, nbx)
        positions = list(range(var["pos_lo"], var["pos_hi"] + 1))
        slots = [(by, bx, zi) for by in range(nby) for bx in range(nbx)
                 if (by, bx) not in blocked for zi in positions]

        n = min(args.bits, len(slots))
        for i in range(n):
            by, bx, zi = slots[i]
            u, v = ZIGZAG[zi]
            coeffs[by, bx, u, v] = qim_embed(float(coeffs[by, bx, u, v]), int(bits_master[i]), var["delta"])

        stego = save_jpeg(inv(coeffs, qt), qt, var["subsampling"])
        path = out / f"v{var['id']:02d}_{var['name']}.jpg"
        path.write_bytes(stego)

        # Reference goes through the identical quantize/reconstruct path with no
        # payload, so PSNR reflects the cost of EMBEDDING alone rather than
        # JPEG's own losses.
        clean = save_jpeg(inv(fwd(y, qt), qt), qt, var["subsampling"])
        ca = np.asarray(Image.open(io.BytesIO(clean)).convert("L"), float)
        sa = np.asarray(Image.open(io.BytesIO(stego)).convert("L"), float)
        hh, ww = min(ca.shape[0], sa.shape[0]), min(ca.shape[1], sa.shape[1])
        mse = float(np.mean((ca[:hh, :ww] - sa[:hh, :ww]) ** 2))
        psnr = 10 * np.log10(255.0 ** 2 / mse) if mse > 1e-9 else 99.0

        rec = {k: var[k] for k in ("id", "name", "table", "delta", "pos_lo", "pos_hi",
                                   "subsampling", "width", "note")}
        rec.update({"file": path.name, "bits": n, "capacity": len(slots),
                    "psnr": round(psnr, 1), "kb": len(stego) // 1024,
                    "stego_w": ca.shape[1], "stego_h": ca.shape[0]})
        records.append(rec)
        print(f"  v{var['id']:02d} {var['name']:<22} {rec['stego_w']}x{rec['stego_h']} "
              f"{rec['kb']:>4} KB  PSNR {psnr:>5.1f} dB  {n} bits")

    manifest = {
        "platform": args.platform, "payload_seed": PAYLOAD_SEED,
        "bits_requested": args.bits, "channel_max_width": max_w,
        "channel_subsampling": ch_ss, "luma_qtable": s["luma_qtable"],
        "source_image": str(args.image), "variants": records,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(records)} variants written to {out}/")
    print(f"manifest: {out}/manifest.json")
    print("\nSend every .jpg in that folder through the platform, then save the\n"
          "returns into a folder and run:  python3 sweep.py decode ...")


def cmd_decode(args) -> None:
    man = json.loads(Path(args.manifest).read_text())
    ch_qt = np.array(man["luma_qtable"], float).reshape(8, 8)
    by_id = {v["id"]: v for v in man["variants"]}
    rng = np.random.default_rng(man["payload_seed"])
    bits_master = rng.integers(0, 2, man["bits_requested"])
    q_tables = {"channel": ch_qt, "pillow_q75": pillow_table(75), "pillow_q95": pillow_table(95)}

    files = [p for p in sorted(Path(args.returns).iterdir())
             if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}]
    if not files:
        raise SystemExit(f"No images in {args.returns}")

    rows = []
    unknown = []
    for f in files:
        img = Image.open(f).convert("L")
        y = np.asarray(img, dtype=np.float64)
        vid = None
        for cand in by_id.values():
            scale = img.width / cand["stego_w"]
            got = read_id(y, scale)
            if got is not None and got in by_id:
                vid = got
                break
        if vid is None:
            unknown.append(f.name)
            continue

        var = by_id[vid]
        qt = q_tables[var["table"]]
        # The decoder must read in the domain the channel produced.
        recv_qt = np.array(Image.open(f).quantization[0], float).reshape(8, 8) \
            if Image.open(f).format == "JPEG" else qt
        coeffs = fwd(y, recv_qt)
        # Rescale into the embedding domain if the tables differ.
        if not np.array_equal(recv_qt, qt):
            coeffs = coeffs * recv_qt / qt

        nby, nbx = coeffs.shape[0], coeffs.shape[1]
        blocked = id_blocked(nby, nbx)
        positions = list(range(var["pos_lo"], var["pos_hi"] + 1))
        slots = [(by, bx, zi) for by in range(nby) for bx in range(nbx)
                 if (by, bx) not in blocked for zi in positions]
        n = min(var["bits"], len(slots))
        errs = 0
        for i in range(n):
            by, bx, zi = slots[i]
            u, v = ZIGZAG[zi]
            if qim_detect(float(coeffs[by, bx, u, v]), var["delta"]) != int(bits_master[i]):
                errs += 1
        ber = errs / n if n else 1.0
        rows.append({**var, "recv_file": f.name, "recv_w": img.width, "recv_h": img.height,
                     "checked": n, "errors": errs, "ber": ber,
                     "resized": img.width != var["stego_w"]})

    rows.sort(key=lambda r: r["ber"])
    print(f"\n{'id':>3} {'variant':<22} {'table':<11} {'d':>3} {'zz':>7} {'ss':>5} "
          f"{'in':>5} {'out':>5} {'rsz':>4} {'PSNR':>6} {'BER':>8}  verdict")
    print("-" * 108)
    for r in rows:
        ss = {0: "4:4:4", 1: "4:2:2", 2: "4:2:0"}.get(r["subsampling"], "?")
        zz = f"{r['pos_lo']}-{r['pos_hi']}"
        # RS(128) over 255-symbol blocks corrects ~25% symbol errors; stay well inside.
        verdict = ("clean" if r["ber"] == 0 else
                   "recoverable" if r["ber"] < 0.05 else
                   "marginal" if r["ber"] < 0.15 else "FAIL")
        print(f"{r['id']:>3} {r['name']:<22} {r['table']:<11} {r['delta']:>3} {zz:>7} {ss:>5} "
              f"{r['width']:>5} {r['recv_w']:>5} {'Y' if r['resized'] else 'n':>4} "
              f"{r['psnr']:>6.1f} {r['ber']*100:>7.2f}%  {verdict}")

    if unknown:
        print(f"\ncould not read ID patch on {len(unknown)} file(s): {', '.join(unknown)}")
    missing = set(by_id) - {r["id"] for r in rows}
    if missing:
        print(f"no return found for variant id(s): {sorted(missing)}")

    clean = [r for r in rows if r["ber"] == 0]
    if clean:
        best = max(clean, key=lambda r: r["psnr"])
        print(f"\n{len(clean)}/{len(rows)} variants recovered with zero errors.")
        print(f"quietest clean variant: v{best['id']:02d} {best['name']} at {best['psnr']} dB PSNR")
    else:
        print("\nNo variant achieved zero errors.")

    Path(args.json).write_text(json.dumps(rows, indent=2))
    print(f"wrote {args.json}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("embed", help="generate the variant sweep")
    e.add_argument("--image", required=True, help="cover image (a real photo is best)")
    e.add_argument("--out", default="sweep")
    e.add_argument("--profiles", default="measured_profiles.json")
    e.add_argument("--platform", default="whatsapp")
    e.add_argument("--bits", type=int, default=8192)
    e.set_defaults(func=cmd_embed)

    d = sub.add_parser("decode", help="measure BER on returned files")
    d.add_argument("--manifest", default="sweep/manifest.json")
    d.add_argument("--returns", required=True)
    d.add_argument("--json", default="sweep_results.json")
    d.set_defaults(func=cmd_decode)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
