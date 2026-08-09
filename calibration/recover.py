#!/usr/bin/env python3
"""
recover.py — does an actual MESSAGE survive WhatsApp, and how big can it be?

sweep.py measured raw bit error rate. This measures what the judge will
actually see: embed a real payload with error correction, send it through the
platform, and check whether the exact bytes come back.

Reed-Solomon over GF(256) is implemented here rather than imported, so there is
no dependency to install on a PEP 668 system.

Each image carries: a visible ID patch (config x trial x payload size), and a
framed payload = magic + length + CRC + RS parity, optionally repeated for
majority voting.

    python3 recover.py embed  --image photo.jpg --out rec/
    python3 recover.py decode --manifest rec/manifest.json --returns rec_back/

Configurations tested are the survivors from the sweep, at three payload sizes,
repeated across trials so a single lucky or unlucky image cannot mislead.
"""

from __future__ import annotations

import argparse
import io
import json
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

# ---------------------------------------------------------------- GF(256) ---
_EXP = [0] * 512
_LOG = [0] * 256


def _init_gf() -> None:
    x = 1
    for i in range(255):
        _EXP[i] = x
        _LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        _EXP[i] = _EXP[i - 255]


_init_gf()


def _mul(a: int, b: int) -> int:
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def _div(a: int, b: int) -> int:
    if b == 0:
        raise ZeroDivisionError
    return 0 if a == 0 else _EXP[(_LOG[a] - _LOG[b]) % 255]


def _poly_scale(p, x):
    return [_mul(c, x) for c in p]


def _poly_add(p, q):
    r = [0] * max(len(p), len(q))
    for i in range(len(p)):
        r[i + len(r) - len(p)] = p[i]
    for i in range(len(q)):
        r[i + len(r) - len(q)] ^= q[i]
    return r


def _poly_mul(p, q):
    r = [0] * (len(p) + len(q) - 1)
    for i, a in enumerate(p):
        if a:
            for j, b in enumerate(q):
                if b:
                    r[i + j] ^= _mul(a, b)
    return r


def _poly_eval(p, x):
    y = p[0]
    for c in p[1:]:
        y = _mul(y, x) ^ c
    return y


def _generator(nsym: int):
    g = [1]
    for i in range(nsym):
        g = _poly_mul(g, [1, _EXP[i]])
    return g


def rs_encode(data: bytes, nsym: int) -> bytes:
    gen = _generator(nsym)
    out = list(data) + [0] * nsym
    for i in range(len(data)):
        c = out[i]
        if c:
            for j in range(1, len(gen)):
                out[i + j] ^= _mul(gen[j], c)
    return bytes(data) + bytes(out[len(data):])


def _syndromes(msg, nsym):
    return [0] + [_poly_eval(msg, _EXP[i]) for i in range(nsym)]


def _error_locator(synd, nsym):
    err_loc, old_loc = [1], [1]
    for i in range(nsym):
        K = i + 1
        delta = synd[K]
        for j in range(1, len(err_loc)):
            delta ^= _mul(err_loc[-(j + 1)], synd[K - j])
        old_loc = old_loc + [0]
        if delta != 0:
            if len(old_loc) > len(err_loc):
                new_loc = _poly_scale(old_loc, delta)
                old_loc = _poly_scale(err_loc, _div(1, delta))
                err_loc = new_loc
            err_loc = _poly_add(err_loc, _poly_scale(old_loc, delta))
    while err_loc and err_loc[0] == 0:
        del err_loc[0]
    return err_loc


def _find_errors(err_loc, nmess):
    errs = len(err_loc) - 1
    pos = [nmess - 1 - i for i in range(nmess) if _poly_eval(err_loc, _EXP[i % 255]) == 0]
    return pos if len(pos) == errs else None


def _error_evaluator(synd, err_loc, nsym):
    r = _poly_mul(synd, err_loc)
    return r[len(r) - (nsym + 1):]


def _correct(msg, synd, err_pos):
    coef_pos = [len(msg) - 1 - p for p in err_pos]
    e_loc = [1]
    for i in coef_pos:
        e_loc = _poly_mul(e_loc, _poly_add([1], [_EXP[i % 255], 0]))
    e_eval = _error_evaluator(synd[::-1], e_loc, len(e_loc) - 1)[::-1]
    X = [_EXP[(-(255 - i)) % 255] for i in coef_pos]
    E = [0] * len(msg)
    for i, Xi in enumerate(X):
        Xi_inv = _div(1, Xi)
        prime = 1
        for j in range(len(X)):
            if j != i:
                prime = _mul(prime, 1 ^ _mul(Xi_inv, X[j]))
        if prime == 0:
            return None
        y = _mul(Xi, _poly_eval(e_eval[::-1], Xi_inv))
        E[err_pos[i]] = _div(y, prime)
    return _poly_add(msg, E)


def rs_decode(codeword: bytes, nsym: int):
    msg = list(codeword)
    synd = _syndromes(msg, nsym)
    if max(synd) == 0:
        return bytes(msg[:-nsym])
    err_loc = _error_locator(synd, nsym)
    if len(err_loc) - 1 > nsym // 2:
        return None
    pos = _find_errors(err_loc[::-1], len(msg))
    if pos is None:
        return None
    fixed = _correct(msg, synd, pos)
    if fixed is None or max(_syndromes(fixed, nsym)) != 0:
        return None
    return bytes(fixed[:-nsym])


def rs_encode_long(data: bytes, nsym: int) -> bytes:
    """Pad to a whole number of blocks so every codeword block is exactly 255 bytes."""
    k = 255 - nsym
    pad = (-len(data)) % k
    data = data + b"\x00" * pad
    return b"".join(rs_encode(data[i:i + k], nsym) for i in range(0, len(data), k))


def rs_decode_long(cw: bytes, nsym: int) -> bytes | None:
    out, ok = bytearray(), True
    for i in range(0, len(cw), 255):
        blk = cw[i:i + 255]
        if len(blk) < 255:
            break
        d = rs_decode(blk, nsym)
        if d is None:
            ok = False
            out.extend(b"\x00" * (255 - nsym))
        else:
            out.extend(d)
    return bytes(out) if ok else None


# ------------------------------------------------------------------- DCT ----
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
ID_CELL, ID_BITS, ID_MARGIN = 40, 8, 8
MAGIC = b"STGX"


def _dctm() -> np.ndarray:
    n = np.arange(8)
    m = np.cos((2 * n[None, :] + 1) * n[:, None] * np.pi / 16.0)
    m *= np.where(n[:, None] == 0, np.sqrt(1 / 8), np.sqrt(2 / 8))
    return m


D = _dctm()


def fwd(y, qt):
    h, w = (y.shape[0] // 8) * 8, (y.shape[1] // 8) * 8
    b = (y[:h, :w] - 128.0).reshape(h // 8, 8, w // 8, 8).transpose(0, 2, 1, 3)
    return np.round((D @ b @ D.T) / qt)


def inv(q, qt):
    b = D.T @ (q * qt) @ D
    return np.clip(b.transpose(0, 2, 1, 3).reshape(b.shape[0] * 8, b.shape[1] * 8) + 128.0, 0, 255)


def q_emb(c, bit, d):
    return np.round(c / d) * d + (d / 4.0) * (1 if bit else -1)


def q_det(z, d):
    cell = np.round(z / d) * d
    return int(abs(z - (cell + d / 4.0)) < abs(z - (cell - d / 4.0)))


def pillow_table(q: int) -> np.ndarray:
    b = io.BytesIO()
    Image.new("RGB", (16, 16)).save(b, format="JPEG", quality=q)
    return np.array(Image.open(io.BytesIO(b.getvalue())).quantization[0], float).reshape(8, 8)


def paint_id(y, vid):
    y = y.copy()
    y[ID_MARGIN:ID_MARGIN + ID_CELL, ID_MARGIN:ID_MARGIN + ID_CELL] = 255.0
    for i in range(ID_BITS):
        xa = ID_MARGIN + (i + 1) * ID_CELL
        y[ID_MARGIN:ID_MARGIN + ID_CELL, xa:xa + ID_CELL] = 255.0 if (vid >> (ID_BITS - 1 - i)) & 1 else 0.0
    xa = ID_MARGIN + (ID_BITS + 1) * ID_CELL
    y[ID_MARGIN:ID_MARGIN + ID_CELL, xa:xa + ID_CELL] = 0.0
    return y


def read_id(y, scale):
    cell, m = ID_CELL * scale, ID_MARGIN * scale
    if y.shape[1] < m + cell * (ID_BITS + 2):
        return None

    def s(i):
        xa = m + i * cell
        return float(y[int(m + cell * .3):int(m + cell * .7), int(xa + cell * .3):int(xa + cell * .7)].mean())
    lead, term = s(0), s(ID_BITS + 1)
    if lead < 160 or term > 95:
        return None
    v = 0
    for i in range(ID_BITS):
        v = (v << 1) | (1 if s(i + 1) > (lead + term) / 2 else 0)
    return v


def blocked(nby, nbx):
    xe = ID_MARGIN + ID_CELL * (ID_BITS + 3)
    ye = ID_MARGIN + ID_CELL * 2
    return {(by, bx) for by in range(min(nby, ye // 8 + 1)) for bx in range(min(nbx, xe // 8 + 1))}


def save_jpeg(pix, qt, ss):
    img = Image.fromarray(pix.astype(np.uint8), mode="L").convert("RGB")
    b = io.BytesIO()
    img.save(b, format="JPEG", qtables=[qt.astype(int).ravel().tolist()] * 2, subsampling=ss, optimize=False)
    return b.getvalue()


def frame(payload: bytes, nsym: int) -> bytes:
    body = MAGIC + len(payload).to_bytes(4, "big") + zlib.crc32(payload).to_bytes(4, "big") + payload
    return rs_encode_long(body, nsym)


def unframe(cw: bytes, nsym: int) -> bytes | None:
    body = rs_decode_long(cw, nsym)
    if not body or body[:4] != MAGIC:
        return None
    n = int.from_bytes(body[4:8], "big")
    crc = int.from_bytes(body[8:12], "big")
    p = body[12:12 + n]
    return p if len(p) == n and zlib.crc32(p) == crc else None


def to_bits(b: bytes) -> list[int]:
    return [(x >> (7 - i)) & 1 for x in b for i in range(8)]


def from_bits(bits: list[int]) -> bytes:
    return bytes(sum(bits[i + j] << (7 - j) for j in range(8)) for i in range(0, len(bits) // 8 * 8, 8))


CONFIGS = [
    ("q75_lowband", "pillow_q75", 14, 1, 12, 0),
    ("matched_d6", "channel", 6, 1, 12, 2),
    ("matched_d4", "channel", 4, 1, 12, 2),
    ("matched_pos6_20", "channel", 3, 6, 20, 2),
    ("baseline", "pillow_q75", 14, 1, 24, 0),
]
PAYLOAD_SIZES = [32, 512, 4096]
NSYM = 64
REPEAT = 3


def cmd_embed(args):
    prof = json.loads(Path(args.profiles).read_text())["platforms"][0]
    ch_qt = np.array(prof["luma_qtable"], float).reshape(8, 8)
    tables = {"channel": ch_qt, "pillow_q75": pillow_table(75), "pillow_q95": pillow_table(95)}
    src = Image.open(args.image).convert("L")
    w = 1600
    src = src.resize((w, max(1, round(src.height * w / src.width))), Image.Resampling.LANCZOS)
    base = np.asarray(src, dtype=np.float64)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    recs, vid = [], 0
    rng = np.random.default_rng(4242)

    for cname, tname, delta, lo, hi, ss in CONFIGS:
        for psize in PAYLOAD_SIZES:
            for trial in range(args.trials):
                vid += 1
                payload = bytes(rng.integers(0, 256, psize, dtype=np.uint8))
                cw = frame(payload, NSYM)
                bits = to_bits(cw) * REPEAT

                y = paint_id(base, vid)
                qt = tables[tname]
                co = fwd(y, qt)
                nby, nbx = co.shape[0], co.shape[1]
                blk = blocked(nby, nbx)
                pos = list(range(lo, hi + 1))
                slots = [(a, b, z) for a in range(nby) for b in range(nbx)
                         if (a, b) not in blk for z in pos]
                if len(bits) > len(slots):
                    print(f"  v{vid:02d} SKIP {cname} {psize}B — needs {len(bits)} slots, has {len(slots)}")
                    vid -= 1
                    continue
                for i, bit in enumerate(bits):
                    a, b, z = slots[i]
                    u, v = ZIGZAG[z]
                    co[a, b, u, v] = q_emb(float(co[a, b, u, v]), bit, delta)
                data = save_jpeg(inv(co, qt), qt, ss)
                fn = out / f"r{vid:02d}_{cname}_{psize}B_t{trial}.jpg"
                fn.write_bytes(data)

                clean = np.asarray(Image.open(io.BytesIO(save_jpeg(inv(fwd(y, qt), qt), qt, ss))).convert("L"), float)
                st = np.asarray(Image.open(io.BytesIO(data)).convert("L"), float)
                hh, ww = min(clean.shape[0], st.shape[0]), min(clean.shape[1], st.shape[1])
                mse = float(np.mean((clean[:hh, :ww] - st[:hh, :ww]) ** 2))
                psnr = 10 * np.log10(255.0 ** 2 / mse) if mse > 1e-9 else 99.0

                recs.append({"id": vid, "config": cname, "table": tname, "delta": delta,
                             "lo": lo, "hi": hi, "ss": ss, "payload_size": psize, "trial": trial,
                             "payload_hex": payload.hex(), "cw_len": len(cw), "bits": len(bits),
                             "capacity": len(slots), "file": fn.name, "psnr": round(psnr, 1),
                             "kb": len(data) // 1024, "stego_w": st.shape[1], "stego_h": st.shape[0]})
                print(f"  v{vid:02d} {cname:<16} {psize:>5}B t{trial}  {len(data)//1024:>4} KB  "
                      f"PSNR {psnr:>5.1f}  {len(bits)}/{len(slots)} slots")

    (out / "manifest.json").write_text(json.dumps(
        {"luma_qtable": prof["luma_qtable"], "nsym": NSYM, "repeat": REPEAT, "variants": recs}, indent=2))
    print(f"\n{len(recs)} images in {out}/  — send them all, then decode.")


def cmd_decode(args):
    man = json.loads(Path(args.manifest).read_text())
    ch_qt = np.array(man["luma_qtable"], float).reshape(8, 8)
    tables = {"channel": ch_qt, "pillow_q75": pillow_table(75), "pillow_q95": pillow_table(95)}
    by_id = {v["id"]: v for v in man["variants"]}
    nsym, rep = man["nsym"], man["repeat"]

    rows, unknown = [], []
    for f in sorted(Path(args.returns).iterdir()):
        if f.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        im = Image.open(f)
        y = np.asarray(im.convert("L"), dtype=np.float64)
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
        nby, nbx = co.shape[0], co.shape[1]
        blk = blocked(nby, nbx)
        pos = list(range(var["lo"], var["hi"] + 1))
        slots = [(a, b, z) for a in range(nby) for b in range(nbx) if (a, b) not in blk for z in pos]
        n = min(var["bits"], len(slots))
        raw = []
        for i in range(n):
            a, b, z = slots[i]
            u, v = ZIGZAG[z]
            raw.append(q_det(float(co[a, b, u, v]), var["delta"]))
        per = var["cw_len"] * 8
        votes = [raw[k * per:(k + 1) * per] for k in range(rep) if len(raw[k * per:(k + 1) * per]) == per]
        merged = [1 if sum(c) * 2 > len(votes) else 0 for c in zip(*votes)] if votes else raw[:per]
        got = unframe(from_bits(merged), nsym)
        want = bytes.fromhex(var["payload_hex"])
        ok = got == want
        single = unframe(from_bits(raw[:per]), nsym) == want if len(raw) >= per else False
        rows.append({**var, "recovered": ok, "recovered_no_repeat": single,
                     "recv_w": im.width, "resized": im.width != var["stego_w"]})

    order = {c[0]: i for i, c in enumerate(CONFIGS)}
    rows.sort(key=lambda r: (order.get(r["config"], 9), r["payload_size"], r["trial"]))
    print(f"\n{'id':>3} {'config':<16} {'size':>6} {'t':>2} {'PSNR':>6} {'x3 vote':>8} {'single':>7}")
    print("-" * 60)
    for r in rows:
        print(f"{r['id']:>3} {r['config']:<16} {r['payload_size']:>5}B {r['trial']:>2} "
              f"{r['psnr']:>6.1f} {'PASS' if r['recovered'] else 'fail':>8} "
              f"{'PASS' if r['recovered_no_repeat'] else 'fail':>7}")

    print("\nsummary by config and payload size (x3 repetition):")
    for cname, *_ in CONFIGS:
        line = f"  {cname:<16}"
        for ps in PAYLOAD_SIZES:
            sel = [r for r in rows if r["config"] == cname and r["payload_size"] == ps]
            line += f"  {ps:>5}B {sum(r['recovered'] for r in sel)}/{len(sel)}" if sel else f"  {ps:>5}B  -/-"
        print(line)
    if unknown:
        print(f"\nunreadable ID on: {', '.join(unknown)}")
    Path(args.json).write_text(json.dumps(rows, indent=2))
    print(f"wrote {args.json}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    s = ap.add_subparsers(dest="cmd", required=True)
    e = s.add_parser("embed")
    e.add_argument("--image", required=True)
    e.add_argument("--out", default="rec")
    e.add_argument("--profiles", default="measured_profiles.json")
    e.add_argument("--trials", type=int, default=2)
    e.set_defaults(func=cmd_embed)
    d = s.add_parser("decode")
    d.add_argument("--manifest", default="rec/manifest.json")
    d.add_argument("--returns", required=True)
    d.add_argument("--json", default="recover_results.json")
    d.set_defaults(func=cmd_decode)
    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
