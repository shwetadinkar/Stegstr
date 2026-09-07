# Telegram photo path — measured 2026-09-07

Files sent from and returned to a real Telegram account, with the checksums
they were measured at (`SHA256SUMS`). Every number below was re-derived from
the files in this directory, not copied from a note.

| file | geometry | luma table (min/max/mean) | zigzag 1–6 | payload |
|---|---|---|---|---|
| `tg_A_sent_1280.jpg` | 1280×960 | 5 / 61 / 29.0 | 8,6,5,8,12,20 | recovers |
| `ret_tg_A.jpg` | 1280×960 | 3 / 31 / 15.0 | 4,3,3,4,6,10 | **recovers** |
| `hd_A_sent_4096.jpg` | 4096×3072 | 5 / 61 / 29.0 | 8,6,5,8,12,20 | recovers |
| `NEGATIVE_4096_sent_to_telegram.jpg` | **1280×960** | 4 / 19 / 12.2 | 4,5,9,9,10,11 | **nothing** |

Recovery was checked with the shipped CLI and no hints:

```
node dist-cli/stegstr.mjs detect --in <file> --raw --out /tmp/out.bin
```

## The positive result

A cover already at Telegram's own output geometry passes through and the
payload reads back. Telegram re-encodes on a scaled Annex K table near Q87 —
finer than the send-side table, so the embedding band survives the second
quantisation intact. This is the first payload round trip at 1280×960;
`telegram_photo` had the geometry right and was previously unverified.

## The negative result, and why it is committed

`NEGATIVE_4096_sent_to_telegram.jpg` is `hd_A_sent_4096.jpg` after the same
channel. The payload is recoverable from the file that was sent and is gone
from the file that came back, and the only thing that happened in between is
4096×3072 → 1280×960.

That is the failure mode this project keeps returning to: resampling shifts the
8×8 DCT grid, so the decoder walks coefficients that were never written. It is
a total loss, not a degradation — there is no partial recovery to fall back on,
and Reed–Solomon never sees a usable symbol. Sending an oversized cover through
a resizing photo path destroys the payload no matter how robust the encoder is,
which is why `telegram_photo` targets 1280 and `telegram_file` exists for
anything larger.

Both arms are kept because a negative with no matching positive is not
evidence: the pair is what rules out "the payload was never there".

## One thing this does not establish

The two Telegram returns carry different tables — 3/31/15.0 for the 1280 send,
4/19/12.2 for the downscaled 4096 — so Telegram's re-encode quality is not
fixed. Attribution rests on geometry: a 4096×3072 upload comes back 1600×1200
from WhatsApp (measured, `calibration/returns/whatsapp/chart_w4096.jpg`) and
1280×960 here, and 1280×960 is Telegram's signature. Nothing in these files
pins the quality Telegram chooses or what it varies with, so no profile should
be tuned against 4/19/12.2 as if it were a constant.
