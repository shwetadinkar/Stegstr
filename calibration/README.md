# Stegstr — real-channel calibration (Day 1)

Measures what WhatsApp, Telegram and Instagram *actually* do to images, and
generates a corrected channel simulator from the measurements.

This is Phase 1 of `docs/WHATSAPP_PLAN.md` in the upstream repo — the step the
maintainer flagged as "high value, low effort" and had not done.

## Why this matters

Two defects in the current code, both fixed by measuring:

**1. The simulator models the wrong channel.** `channel_simulator/channel.py`
calls Pillow with `quality=65` for WhatsApp. That produces *Pillow's* Q65
quantization table, not WhatsApp's. Platforms ship custom tables. So the matrix
in `docs/robust_comparison.md` — where `dct_qim` passes everything — is a pass
against a channel that does not exist. This is the sim-to-real gap documented in
`WHATSAPP_PLAN.md`.

**2. The QIM step size is flat.** `dct_variants.py` line 45:

```python
QIM_DELTA = 14   # applied to every one of the 64 DCT frequencies
```

A real luma quantization table is not flat. It runs from roughly 7–11 at low
frequencies to 70–120 at high ones. Wherever the channel's step exceeds δ, the
quantizer rounds the embedded coefficient to zero and the bit is gone
**deterministically, before Reed–Solomon ever sees it**. Measured against a
plain Q65 table, 50 of 64 frequencies are in that condition.

That explains the two things the upstream results can't otherwise account for:
why `dct_rs64` gave no improvement over `dct` (more parity cannot recover
erased bits), and why RS=128 with 5× repetition still throws
`ReedSolomonError: Too many errors` on real WhatsApp.

The fix, once you have the real table, is a per-frequency step:

```
δ[f] = k · q_channel[f]     (k = 2 or 3)
```

Now the QIM lattice is commensurate with the channel's own quantizer, so
requantization maps lattice points onto themselves. Recovery becomes
near-errorless by construction rather than by brute-force redundancy — and
because low-frequency deltas drop from 14 to ~2·8=16 only where needed, and the
whole scheme stops over-driving low frequencies, invisibility improves at the
same time.

`analyze_returns.py` prints `recommended_qim_delta_k2` / `k3` for exactly this.

## Install

```bash
pip install pillow numpy
```

## Step 1 — generate charts

```bash
python3 make_charts.py --out charts/
```

Writes `chart_w640.png` … `chart_w4096.png`. Each contains a DCT frequency
sweep, flat tone patches, a resize probe, a gradient and band-limited noise.
The width in the filename is how the analyzer pairs source with return —
**keep the filename stem intact**.

## Step 2 — send them through the real platforms

Send every chart, then save what comes back. Use the same path a judge would:

| Platform | How to send | Save to |
|---|---|---|
| WhatsApp | message yourself, **normal photo share, not "document"** | `returns/whatsapp/` |
| WhatsApp HD | same, with HD quality toggled on | `returns/whatsapp_hd/` |
| Telegram | Saved Messages, as **Photo** | `returns/telegram_photo/` |
| Telegram | Saved Messages, as **File** | `returns/telegram_file/` |
| Instagram | DM to yourself | `returns/instagram/` |

Keep the stem: `returns/whatsapp/chart_w1600.jpg`.

Two things worth knowing before you start:

- **WhatsApp Web, Android and iOS do not all compress identically.** Calibrate
  on the mobile photo path — that is what "sending test files through WhatsApp"
  means to a judge. Note which client you used.
- **Telegram "as File" should come back byte-identical.** If it does, that is a
  lossless channel and belongs in the high-capacity tier, not the robust tier.
  The analyzer will report `not JPEG - platform preserved format`.

## Step 3 — analyze

```bash
python3 analyze_returns.py --charts charts/ --returns returns/
```

Outputs:

- console summary per platform
- `measured_profiles.json` — full tables and per-frequency recommended deltas
- `channel_measured.py` — drop-in replacement for `channel_simulator/channel.py`
  that re-encodes using `qtables=` with the measured tables instead of
  `quality=N`

## Step 4 — re-run the upstream matrix against reality

```bash
cd /path/to/Stegstr/channel_simulator
cp /path/to/channel_measured.py .
# point run_matrix.py at channel_measured instead of channel
python3 run_matrix.py
```

Expect the `dct_qim` row to stop being all-PASS. That is the result worth
having: it reproduces the real-world failure *inside the test loop*, so Day 2's
per-frequency delta work can be validated in seconds instead of a phone round
trip per iteration.

## What to send upstream

Steps 1–3 plus the corrected `channel.py` stand alone as a contribution to
`brunkstr/Stegstr`, independent of the contest. Opening that PR early puts a
measured, reproducible result in front of the judge before submissions are even
opened.
