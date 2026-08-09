#!/usr/bin/env python3
"""
round2.py — colour photos, platform-safe sizing, payload ceiling, forwarding.

Everything measured so far used greyscale, a single hop, and WhatsApp Standard.
The shipped app will embed into users' COLOUR photos, images get forwarded, and
Instagram caps width lower than WhatsApp does. This round closes those gaps.

What changes from recover.py:

  colour     Embedding happens in the Y (luma) channel of a real colour photo;
             Cb and Cr are left untouched. Reading Y back requires a
             JPEG -> RGB -> YCbCr conversion that shifts levels slightly, so
             the colour path is genuinely harder than greyscale and has to be
             measured rather than assumed.

  sizing     Two targets. WhatsApp Standard caps at 1600px (measured), but
             Instagram caps at 1080px. An image sized for WhatsApp gets
             resized by Instagram, and resizing was the one catastrophic
             failure mode in the sweep (~50% BER, total loss). 1080 should be
             universally safe; this checks what it costs.

  capacity   Payload sizes up to the point where they no longer fit, to find
             the real ceiling instead of assuming it.

  hops       Decoding does not care how many times an image has been through a
             platform. Send the batch, save the returns, then send THOSE
             returns again and decode the second set with the same manifest.
             That measures survival across a forward.

    python3 round2.py embed  --image photo.jpg --out r2/
    python3 round2.py decode --manifest r2/manifest.json --returns r2_hop1/
    python3 round2.py decode --manifest r2/manifest.json --returns r2_hop2/
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image

from recover import (ZIGZAG, ID_BITS, ID_CELL, ID_MARGIN, D, fwd, inv, q_emb, q_det,
                     pillow_table, paint_id, read_id, blocked, frame, unframe,
                     to_bits, from_bits)

NSYM = 64
WIDTHS = [1080, 1440, 1600]
PAYLOADS = [32, 4096, 16384, 32768]
CONFIGS = [
    ("matched_d4", "channel", 4, 1, 12, 2),
    ("matched_d6", "channel", 6, 1, 12, 2),
    # Instagram sweep. Its grid survives at 1440 native, and its quantization
    # is gentle (steps 5-25), so the residual damage is not quantization -- it
    # behaves like sharpening: a roughly fixed perturbation that scales with
    # local texture. That is an amplitude problem, so the lever is a bigger
    # QIM step, and secondarily lower frequencies (sharpening boosts high
    # frequencies hardest) and heavier repetition.
    ("ig_d10", "channel", 10, 1, 12, 2),
    ("ig_d16", "channel", 16, 1, 12, 2),
    ("ig_d24", "channel", 24, 1, 12, 2),
    ("ig_d16_low", "channel", 16, 1, 6, 2),
    ("ig_d10_low", "channel", 10, 1, 6, 2),
    ("ig_d24_low", "channel", 24, 1, 6, 2),
]

# Worst-case grid: the smallest set that can still falsify the design.
# (width, config, payload)
#   1080 + max payload      -> Instagram-safe size at its capacity ceiling
#   1080 + weaker delta     -> least robust step size, at capacity
#   1600 + max payload      -> DELIBERATELY oversized for Instagram (1080 cap),
#                              so Instagram must resize it. Expected to fail;
#                              confirms the size rule rather than assuming it.
#                              Telegram caps at 1920, so the same file should
#                              pass there — the asymmetry is the evidence.
#   1080 + tiny payload     -> control; if this fails, something else is wrong
WORST_CASE = [
    (1080, "matched_d6", 4096),
    (1080, "matched_d4", 4096),
    (1600, "matched_d6", 4096),
    (1080, "matched_d6", 32),
]

# Instagram always outputs a 1440x1440 canvas (measured). Uploading AT that
# size should mean no resampling at all -- the same rule that made WhatsApp
# work once we stopped exceeding its cap. Its quantization table is also very
# gentle (steps 5-25, vs WhatsApp's 6-167), so if the grid survives, error
# rates should be lower than WhatsApp's rather than higher.
IG_NATIVE = [
    (1440, "matched_d6", 4096),
    (1440, "matched_d4", 4096),
    (1440, "matched_d6", 32),
    (1440, "matched_d6", 16384),
]

# Step-size sweep at Instagram's native 1440, plus a low-frequency-only arm.
IG_SWEEP = [
    (1440, "ig_d10", 4096),
    (1440, "ig_d16", 4096),
    (1440, "ig_d24", 4096),
    (1440, "ig_d10_low", 4096),
    (1440, "ig_d16_low", 4096),
    (1440, "ig_d24_low", 4096),
    (1440, "ig_d16", 512),
    (1440, "ig_d16_low", 16384),
]


def load_ycc(path: str, width: int, square: bool = False) -> tuple[np.ndarray, Image.Image, Image.Image]:
    """
    Load a cover and size it for the target channel.

    square=True centre-crops to 1:1 before resizing. Instagram forces every
    image to a square canvas: a 4:3 upload comes back PADDED to square and
    rescaled (measured: 1080x808 in, 1440x1440 out). Padding moves the 8x8
    block grid origin and rescaling changes its spacing, so block-aligned QIM
    desynchronises completely. Supplying a square image leaves Instagram
    nothing to pad, which is the cheapest way to keep the grid intact.
    """
    img = Image.open(path).convert("RGB")
    if square:
        s = min(img.width, img.height)
        left, top = (img.width - s) // 2, (img.height - s) // 2
        img = img.crop((left, top, left + s, top + s))
        img = img.resize((width, width), Image.Resampling.LANCZOS)
    elif img.width != width:
        img = img.resize((width, max(1, round(img.height * width / img.width))),
                         Image.Resampling.LANCZOS)
    ycc = img.convert("YCbCr")
    y, cb, cr = ycc.split()
    return np.asarray(y, dtype=np.float64), cb, cr


def save_colour(y: np.ndarray, cb: Image.Image, cr: Image.Image,
                qt: np.ndarray, ss: int) -> bytes:
    yimg = Image.fromarray(np.clip(y, 0, 255).astype(np.uint8), mode="L")
    if cb.size != yimg.size:
        cb = cb.resize(yimg.size, Image.Resampling.LANCZOS)
        cr = cr.resize(yimg.size, Image.Resampling.LANCZOS)
    merged = Image.merge("YCbCr", [yimg, cb, cr])
    buf = io.BytesIO()
    merged.save(buf, format="JPEG", qtables=[qt.astype(int).ravel().tolist()] * 2,
                subsampling=ss, optimize=False)
    return buf.getvalue()


def read_y(path_or_bytes) -> tuple[np.ndarray, Image.Image]:
    im = Image.open(path_or_bytes if not isinstance(path_or_bytes, (str, Path))
                    else str(path_or_bytes))
    y = np.asarray(im.convert("YCbCr").split()[0], dtype=np.float64)
    return y, im


def slots_for(nby: int, nbx: int, lo: int, hi: int) -> list:
    blk = blocked(nby, nbx)
    return [(a, b, z) for a in range(nby) for b in range(nbx)
            if (a, b) not in blk for z in range(lo, hi + 1)]


def cmd_embed(args) -> None:
    profs = json.loads(Path(args.profiles).read_text())["platforms"]
    prof = next((p for p in profs if p["platform"] == args.platform), profs[0])
    ch_qt = np.array(prof["luma_qtable"], float).reshape(8, 8)
    tables = {"channel": ch_qt, "pillow_q75": pillow_table(75)}
    print(f"channel: {prof['platform']}  qtable steps "
          f"{int(ch_qt.min())}-{int(ch_qt.max())}\n")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(90909)
    recs, vid = [], 0

    if args.grid == "worst":
        combos = [(w, c, p) for (w, c, p) in WORST_CASE]
    elif args.grid == "ig":
        combos = [(w, c, p) for (w, c, p) in IG_NATIVE]
    elif args.grid == "igsweep":
        combos = [(w, c, p) for (w, c, p) in IG_SWEEP]
    else:
        combos = [(w, c[0], p) for w in WIDTHS for c in CONFIGS for p in PAYLOADS]
    cfg_by_name = {c[0]: c for c in CONFIGS}

    for width in sorted({w for w, _, _ in combos}):
        base_y, cb, cr = load_ycc(args.image, width, square=args.square)
        for cname in [c[0] for c in CONFIGS]:
            if not any(w == width and c == cname for w, c, _ in combos):
                continue
            _, tname, delta, lo, hi, ss = cfg_by_name[cname]
            qt = tables[tname]
            for psize in [p for w, c, p in combos if w == width and c == cname]:
                probe = fwd(base_y, qt)
                nby, nbx = probe.shape[0], probe.shape[1]
                slots = slots_for(nby, nbx, lo, hi)
                payload = bytes(rng.integers(0, 256, psize, dtype=np.uint8))
                cw = frame(payload, NSYM)
                need = len(cw) * 8
                if need > len(slots):
                    print(f"  --  {cname:<11} {width}px {psize:>6}B  needs {need:,} "
                          f"slots, has {len(slots):,} — skipped")
                    continue
                cap = args.repeat if args.repeat else 3
                repeat = max(1, min(cap, len(slots) // need))
                bits = to_bits(cw) * repeat

                vid += 1
                y = paint_id(base_y, vid)
                co = fwd(y, qt)
                for i, bit in enumerate(bits):
                    a, b, z = slots[i]
                    u, v = ZIGZAG[z]
                    co[a, b, u, v] = q_emb(float(co[a, b, u, v]), bit, delta)
                data = save_colour(inv(co, qt), cb, cr, qt, ss)
                fn = out / f"c{vid:02d}_{cname}_{width}px_{psize}B.jpg"
                fn.write_bytes(data)

                ref = save_colour(inv(fwd(y, qt), qt), cb, cr, qt, ss)
                ra = np.asarray(Image.open(io.BytesIO(ref)).convert("RGB"), float)
                sa = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), float)
                mse = float(np.mean((ra - sa) ** 2))
                psnr = 10 * np.log10(255.0 ** 2 / mse) if mse > 1e-9 else 99.0

                recs.append({"id": vid, "config": cname, "table": tname, "delta": delta,
                             "lo": lo, "hi": hi, "ss": ss, "width": width,
                             "payload_size": psize, "payload_hex": payload.hex(),
                             "cw_len": len(cw), "repeat": repeat, "bits": len(bits),
                             "capacity": len(slots), "file": fn.name,
                             "psnr": round(psnr, 1), "kb": len(data) // 1024,
                             "stego_w": sa.shape[1], "stego_h": sa.shape[0]})
                print(f"  c{vid:02d} {cname:<11} {width}px {psize:>6}B  x{repeat}  "
                      f"{len(data)//1024:>4} KB  PSNR {psnr:>5.1f}  "
                      f"{len(bits):,}/{len(slots):,} slots")

    (out / "manifest.json").write_text(json.dumps(
        {"luma_qtable": prof["luma_qtable"], "nsym": NSYM,
         "source": str(args.image), "variants": recs}, indent=2))
    print(f"\n{len(recs)} colour images in {out}/")
    print("Send them all. Save returns to a hop1 folder, decode, then send those\n"
          "returns again and save to a hop2 folder to measure a forward.")


def cmd_decode(args) -> None:
    man = json.loads(Path(args.manifest).read_text())
    ch_qt = np.array(man["luma_qtable"], float).reshape(8, 8)
    tables = {"channel": ch_qt, "pillow_q75": pillow_table(75)}
    by_id = {v["id"]: v for v in man["variants"]}
    nsym = man["nsym"]

    rows, unknown = [], []
    for f in sorted(Path(args.returns).iterdir()):
        if f.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        y, im = read_y(f)
        vid = None
        for c in by_id.values():
            g = read_id(y, im.width / c["stego_w"])
            if g in by_id:
                vid = g
                break
        if vid is None:
            unknown.append(f.name)
            continue
        var = by_id[vid]
        qt = tables[var["table"]]
        rq = np.array(im.quantization[0], float).reshape(8, 8) if im.format == "JPEG" else qt
        co = fwd(y, rq)
        if not np.array_equal(rq, qt):
            co = co * rq / qt
        slots = slots_for(co.shape[0], co.shape[1], var["lo"], var["hi"])
        n = min(var["bits"], len(slots))
        raw = []
        for i in range(n):
            a, b, z = slots[i]
            u, v = ZIGZAG[z]
            raw.append(q_det(float(co[a, b, u, v]), var["delta"]))
        per = var["cw_len"] * 8
        votes = [raw[k * per:(k + 1) * per] for k in range(var["repeat"])
                 if len(raw[k * per:(k + 1) * per]) == per]
        merged = [1 if sum(c) * 2 > len(votes) else 0 for c in zip(*votes)] if votes else raw[:per]
        want = bytes.fromhex(var["payload_hex"])
        got = unframe(from_bits(merged), nsym)
        cw_bits = to_bits(frame(want, nsym))
        ber = float(np.mean([a != b for a, b in zip(raw[:per], cw_bits)])) if len(raw) >= per else 1.0
        rows.append({**var, "recovered": got == want, "ber": ber,
                     "recv_w": im.width, "resized": im.width != var["stego_w"]})

    rows.sort(key=lambda r: (r["width"], r["config"], r["payload_size"]))
    print(f"\n{'id':>3} {'config':<12} {'px':>5} {'payload':>8} {'x':>2} {'PSNR':>6} "
          f"{'out':>5} {'rsz':>4} {'BER':>7}  result")
    print("-" * 76)
    for r in rows:
        print(f"{r['id']:>3} {r['config']:<12} {r['width']:>5} {r['payload_size']:>7}B "
              f"{r['repeat']:>2} {r['psnr']:>6.1f} {r['recv_w']:>5} "
              f"{'Y' if r['resized'] else 'n':>4} {r['ber']*100:>6.2f}%  "
              f"{'PASS' if r['recovered'] else 'FAIL'}")

    ok = sum(r["recovered"] for r in rows)
    print(f"\n{ok}/{len(rows)} recovered")
    for w in WIDTHS:
        sel = [r for r in rows if r["width"] == w]
        if sel:
            biggest = max((r["payload_size"] for r in sel if r["recovered"]), default=0)
            print(f"  {w}px: {sum(r['recovered'] for r in sel)}/{len(sel)} passed, "
                  f"largest payload recovered {biggest}B")
    if unknown:
        print(f"\nunreadable ID on: {', '.join(unknown)}")
    Path(args.json).write_text(json.dumps(rows, indent=2))
    print(f"wrote {args.json}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    s = ap.add_subparsers(dest="cmd", required=True)
    e = s.add_parser("embed")
    e.add_argument("--image", required=True)
    e.add_argument("--out", default="r2")
    e.add_argument("--profiles", default="measured_profiles.json")
    e.add_argument("--grid", choices=["full", "worst", "ig", "igsweep"], default="full",
                   help="'worst' emits only the 4 hardest cases")
    e.add_argument("--repeat", type=int, default=0,
                   help="max repetition factor (0 = auto, capped at 3)")
    e.add_argument("--platform", default="whatsapp",
                   help="which measured profile to embed against")
    e.add_argument("--square", action="store_true",
                   help="centre-crop to 1:1 (required for Instagram)")
    e.set_defaults(func=cmd_embed)
    d = s.add_parser("decode")
    d.add_argument("--manifest", default="r2/manifest.json")
    d.add_argument("--returns", required=True)
    d.add_argument("--json", default="round2_results.json")
    d.set_defaults(func=cmd_decode)
    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
