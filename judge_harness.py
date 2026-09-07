#!/usr/bin/env python3
"""
Replicate the contest's objective gauntlet locally, through the real CLI.

The published method (criteria 01 and 02):

  02 Control check   "Each engine must first recover its own uncompressed
                      output. If it can't, we flag it rather than post a
                      misleading score."
  01 Objective       "We embed a known message, push the image through 5
                      simulated lossy compression profiles locally, and
                      decode. Same test for all."

The five profiles are shown on the leaderboard as Light, Mod., Strong, Heavy
and Resize. Their exact parameters are NOT published, so the definitions below
are a reconstruction, not the contest's own. Treat a pass here as evidence the
encoder is sound across a spread of recompression, not as a prediction of the
official number.

RESIZE IS THE ONE THAT MATTERS. This encoder's whole strategy is matching a
platform's output geometry so no resampling happens -- and resampling shifts
the 8x8 DCT grid, which destroys a payload outright rather than degrading it.
A profile that deliberately resamples attacks the strategy at its root. If the
gauntlet's Resize profile resamples and does not restore the original
dimensions, this will fail it, and that is worth knowing before a judge finds
out first.

Invisibility is measured "blind (encoder not told the profile)", so everything
here runs on the default platform target.

Usage:
    python3 judge_harness.py cover.jpg [--platform universal] [--bytes 800]
"""
import argparse
import io
import json
import os
import subprocess
import sys
import tempfile

try:
    import numpy as np
    from PIL import Image
except ImportError:
    sys.exit("needs pillow and numpy:  pip install pillow numpy --break-system-packages")

CLI = ["node", "dist-cli/stegstr.mjs"]


# --------------------------------------------------------------------------
# Channel profiles. Reconstruction -- see module docstring.
# --------------------------------------------------------------------------
def ch_jpeg(quality):
    def f(im):
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "JPEG", quality=quality, subsampling=2)
        buf.seek(0)
        return Image.open(buf).convert("RGB")
    return f


def ch_resize(scale=0.7, quality=80, restore=True):
    """
    Downscale, re-encode, and optionally scale back to the original size.

    `restore` models a platform that normalises to its own canvas and hands
    back something the original size. Without it the decoder receives an image
    of different dimensions, where the grid is simply gone. Both are run.
    """
    def f(im):
        w, h = im.size
        small = im.convert("RGB").resize((max(8, int(w * scale)), max(8, int(h * scale))),
                                         Image.LANCZOS)
        buf = io.BytesIO()
        small.save(buf, "JPEG", quality=quality, subsampling=2)
        buf.seek(0)
        out = Image.open(buf).convert("RGB")
        if restore:
            out = out.resize((w, h), Image.LANCZOS)
        return out
    return f


PROFILES = [
    ("Light",          ch_jpeg(90)),
    ("Moderate",       ch_jpeg(75)),
    ("Strong",         ch_jpeg(60)),
    ("Heavy",          ch_jpeg(45)),
    ("Resize",         ch_resize(0.7, 80, restore=True)),
    ("Resize (no restore)", ch_resize(0.7, 80, restore=False)),
]


# --------------------------------------------------------------------------
def run(args, expect_json=False):
    p = subprocess.run(CLI + args, capture_output=True, text=True)
    if expect_json:
        try:
            return p.returncode, json.loads(p.stdout)
        except json.JSONDecodeError:
            return p.returncode, {"_stdout_not_json": p.stdout[:400]}
    return p.returncode, p.stdout


def psnr(a, b):
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    if a.shape != b.shape:
        return None
    mse = np.mean((a - b) ** 2)
    return float("inf") if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cover")
    # Default None, NOT "universal". "Blind" means the caller names no platform,
    # so the encoder falls back to whatever it considers safe for an unknown
    # channel. Passing --platform explicitly is the *hinted* case. Hardcoding a
    # platform here measured a named profile and called it blind.
    ap.add_argument("--platform", default=None,
                    help="name a platform (hinted). Omit for the blind case.")
    ap.add_argument("--bytes", type=int, default=800)
    a = ap.parse_args()
    plat_args = ["--platform", a.platform] if a.platform else []
    plat_label = a.platform if a.platform else "(none named — blind fallback)"

    if not os.path.exists("dist-cli/stegstr.mjs"):
        sys.exit("dist-cli/stegstr.mjs not found — run `npm run build:cli` first")

    tmp = tempfile.mkdtemp(prefix="gauntlet-")
    payload = os.path.join(tmp, "payload.bin")
    stego = os.path.join(tmp, "stego.jpg")
    clean = os.path.join(tmp, "clean.jpg")

    known = bytes((i * 37 + 11) & 0xFF for i in range(a.bytes))
    with open(payload, "wb") as f:
        f.write(known)

    print(f"cover     {a.cover}")
    print(f"platform  {plat_label}")
    print(f"payload   {a.bytes} bytes, known pattern\n")

    # ---- embed -----------------------------------------------------------
    rc, res = run(["embed", "--in", a.cover, "--out", stego,
                   "--payload-file", payload, "--raw", "--json"] + plat_args,
                  expect_json=True)
    if rc != 0:
        print(f"EMBED FAILED (exit {rc}): {res}")
        sys.exit(1)
    if "_stdout_not_json" in res:
        print("WARNING: --json stdout was not parseable. A harness doing "
              "JSON.parse(stdout) would record a failure here.")
        print(res["_stdout_not_json"])
        sys.exit(1)
    print(f"embedded  {res['width']}x{res['height']}, "
          f"{res['payloadBytes']}/{res['capacityBytes']} bytes capacity, "
          f"profile '{res.get('platform', '?')}'\n")

    # ---- control check (criterion 02) -------------------------------------
    got = os.path.join(tmp, "control.bin")
    rc, _ = run(["detect", "--in", stego, "--raw", "--out", got])
    control_ok = rc == 0 and open(got, "rb").read() == known
    print(f"{'CONTROL CHECK':22} {'PASS' if control_ok else 'FAIL'}"
          f"   (recover its own uncompressed output)")
    if not control_ok:
        print("\nControl failed — the contest flags this rather than scoring it. Stop here.")
        sys.exit(1)
    print()

    # ---- the gauntlet (criterion 01) --------------------------------------
    src = Image.open(stego).convert("RGB")
    passes = 0
    scored = 0
    print(f"{'PROFILE':22} {'RESULT':8} {'GEOMETRY':13} NOTE")
    for name, fn in PROFILES:
        out = fn(src)
        path = os.path.join(tmp, f"ch_{name.replace(' ', '_').replace('(', '').replace(')', '')}.jpg")
        out.save(path, "JPEG", quality=95, subsampling=2)
        rec = os.path.join(tmp, "rec.bin")
        rc, _ = run(["detect", "--in", path, "--raw", "--out", rec])
        ok = rc == 0 and os.path.exists(rec) and open(rec, "rb").read() == known
        geom = f"{out.size[0]}x{out.size[1]}"
        note = ""
        if out.size != src.size:
            note = "resampled — grid destroyed by design"
        if "no restore" not in name:
            scored += 1
            passes += 1 if ok else 0
        else:
            note = note or "diagnostic only, not in the five"
        print(f"{name:22} {'PASS' if ok else 'FAIL':8} {geom:13} {note}")

    pct = 100.0 * passes / scored if scored else 0.0
    print(f"\nSURVIVAL  {pct:.0f}%   ({passes}/{scored} scored profiles)")

    # ---- invisibility -----------------------------------------------------
    rc, _ = run(["resize", "--in", a.cover, "--out", clean] + plat_args)
    if rc == 0:
        c = Image.open(clean).convert("RGB")
        s = Image.open(stego).convert("RGB")
        v = psnr(c, s)
        if v is not None:
            print(f"INVISIBILITY  PSNR {v:.1f} dB   "
                  f"(against the same pipeline with no payload)")
        else:
            print("INVISIBILITY  baseline and stego differ in size; cannot compare")

    print(f"\nartifacts in {tmp}")
    print("\nProfile definitions are a reconstruction; the contest does not publish "
          "its parameters.\nA pass is evidence the encoder is sound, not a prediction "
          "of the official score.")


if __name__ == "__main__":
    main()
