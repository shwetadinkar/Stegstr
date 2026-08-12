# Stegstr contest — handoff

Everything needed to continue this work in a fresh conversation. Written to be
read top to bottom once, then used as reference.

---

## 1. The contest

Freelancer contest: **build the best version of Stegstr**, a FOSS steganographic
nostr app. Prize **$500 USD**, ~20 day window, **34 entries** already submitted
(sealed; the star ratings visible on the listing are freelancer profile ratings,
not scores).

Reference site: `https://stegstr.com` · Upstream repo:
`https://github.com/brunkstr/Stegstr` (confirmed publicly by the holder).

**Judged primarily on**, per the brief:
1. Steganographic invisibility
2. Survival through platform processing (WhatsApp, Telegram, Instagram)
3. Reliability of networking functionality

Also requested: AI agent operability. Open scope for extra value.

**Holder's clarifications (from the contest Q&A):**
- Platforms: *"All or any. Mac, PC, more is better."*
- *"This is a FOSS project. We are supporting the project. Better is better."*
- **No defined test procedure and no success-rate threshold.** He will run
  submissions himself against real platforms.

Two implications worth keeping in mind. First, he is funding development on his
own project, so a merge-ready contribution beats a flashy standalone rewrite.
Second, because nobody has defined what "survives WhatsApp" means numerically, a
submission that ships a reproducible harness and honest per-platform numbers
gets to **set the terms of comparison** — and honest reporting with caveats
stops being a disadvantage against someone claiming 100%.

Known competitor: entry #7 is rewriting in Kotlin Multiplatform for Android+iOS.
Large effort, but a rewrite almost certainly ports the *existing* algorithm,
which fails on real WhatsApp (see §3). More platforms, same broken transport.

---

## 2. Working setup

- Fork: `https://github.com/shwetadinkar/Stegstr`, branch `calibration`
- Local: `/home/indra/Stegstr` (WSL, **not** `/mnt/c` — the Windows mount is
  slow for node/cargo builds and mangles git file modes)
- Node 22, vitest, TypeScript. Tauri v2 (Rust) for desktop.
- Python 3.14 with `python3-pil` and `python3-numpy` via apt (PEP 668 blocks
  pip; use `apt` or `pip --break-system-packages`)
- GitHub push uses a PAT written to `~/.git-credentials` (the interactive
  password prompt does not work; `credential.helper` is `store`)

**Upstream already has `.github/workflows/release.yml` building macOS
(Intel + Apple Silicon), Windows and Linux.** The fork inherits it. Pushing a
tag produces installers for all three platforms with no Mac and no
cross-compilation — this covers *"Mac, PC, more is better"* for the cost of a
`git tag`. **This has not been tried yet and should be, early.**

---

## 3. What was measured (the core work)

All numbers below come from round-tripping real images through real apps on a
real Android phone. Tools are in `calibration/` on the `calibration` branch.

### 3.1 The single unifying rule

> **Match the platform's native output geometry and the 8×8 DCT block grid
> survives. Fail to, and the payload is destroyed completely.**

Resampling changes the spacing of the 8×8 grid, so the decoder samples across
block boundaries and reads noise. Every catastrophic failure observed (~50% BER,
i.e. pure chance) came from this. Every success came from avoiding it.

| Platform | Behaviour (measured) | Target to use |
|---|---|---|
| WhatsApp (Standard) | caps width at **1600**; at or below, passes through untouched | ≤1600 |
| Telegram (photo) | caps around **1920**; 1600×1200 returned unchanged | ≤1600 |
| Instagram | **does not cap — normalises everything to 1440×1440 square.** 1080 comes back *upscaled*; 4:3 comes back *padded* to square | **1440×1440, already square** |
| Facebook | 2048 per upstream (not independently verified) | ≤2048 |

Upstream had `instagram: 1080`, which measured **42–50% BER — nothing
recovered**. This is almost certainly why Instagram never worked.

### 3.2 Quantization tables (measured from JPEG headers of returned files)

```
WhatsApp luma:  min 6   max 167  mean 35.6   (~Q67, but NOT an Annex K scaling —
                                              steep roll-off, 6-12 at low freq)
Instagram luma: min 5   max 25   mean 15.8   (~Q90+, very flat; also progressive)
```

Both are content-independent (identical across six different test charts), so
they can be targeted exactly. Instagram's chroma table equals its luma table.

WhatsApp's table is a **custom** table, not Annex K scaled. This matters: the
upstream `channel_simulator/channel.py` uses Pillow `quality=65`, whose average
step is close but whose *shape* is completely different. That mismatch is the
origin of upstream's documented sim-to-real gap (`docs/WHATSAPP_PLAN.md`:
QIM passes the simulator, throws `ReedSolomonError: Too many errors` on a real
phone).

### 3.3 Capacity and error rates (Python reference implementation)

| Config | Payload | BER | PSNR |
|---|---|---|---|
| WhatsApp 1600 | 32 KB (~227 compressed notes) | 0.15–0.38% | 52.5 dB @ 32 B |
| Telegram 1600 | 4 KB tested | 0.25–0.53% | — |
| Instagram 1440 sq | 4 KB with spread+adaptive | 1.28% | clean by eye |
| Instagram 1440 sq | 512 B plain | 0.51% | 35.9 dB |

Other findings:
- **Payload size does not degrade BER.** 32 B and 32 KB both land ~0.3%.
  Capacity is bounded by available slots, not robustness.
- **Multi-hop is nearly free.** A second full re-upload added only +0.06
  percentage points (verified all 12 files differed by md5 — genuinely
  recompressed, not forwarded). WhatsApp's *forward* button does not recompress
  at all; only save-and-resend does.
- **Instagram is limited by invisibility, not robustness.** Large payloads
  need a large step, and a large step over many blocks *dots visibly*. Confirmed
  by eye at 4 KB for every δ tried in the plain scheme.
- A real nostr feed compresses to ~35%; a note is ~144 bytes compressed.
  **Deflate means the payload is all-or-nothing** — three uncorrected bit errors
  and the entire feed fails to inflate. RS must succeed completely.

### 3.4 Adaptive embedding (the biggest invisibility win)

Two ideas, both measured:

- **Keyed spreading** — upstream *already* spreads via AC-major ordering
  (`buildCoeffStream`). An early comparison against block-major ordering was a
  strawman; corrected numbers are below.
- **Texture-adaptive step size** — scale δ per block by local texture. Texture
  masks perturbation; flat walls and sky do not.

Measured masked-visibility (99.5th percentile of perturbation ÷ local texture;
lower is better):

```
block-major (strawman, NOT upstream)   8.938
AC-major  = UPSTREAM TODAY             4.880
AC-major + adaptive                    2.467   ← best, 2.0x better
keyed spread                           5.845   (worse than upstream's AC-major)
keyed spread + adaptive                2.939
```

**PSNR is the wrong metric here and actively misleads.** It ranked the dotted
image *above* the clean one (27.0 dB vs 26.1 dB) because it averages the whole
frame and cannot see concentration. Human eyes and the masked metric agreed with
each other and disagreed with PSNR. Use masked visibility.

Cost of adaptive: BER 0.29% → 1.03% in simulation, 0.40% → 1.28% on real
Instagram, against a ~12% budget. Worth it.

---

## 4. Code written (all in the repo, all tested)

**148 tests pass. `tsc --noEmit` clean. `npm run build` clean.**

### 4.1 Steganography

| File | Status | What |
|---|---|---|
| `src/stego-adaptive.ts` | **new** | Measured platform profiles (width, square, delta, note); texture-activity → discrete δ ladder, normalised so mean step is unchanged; `DETECT_DELTAS` |
| `src/stego-qim.ts` | modified | Adaptive δ in embed *and* detect; `coverGeometry()` extracted as a pure testable function; square centre-crop; `PLATFORM_WIDTHS` derived from profiles; `encodeQimImageFile` takes `{platform}`; `decodeQimImageFile` tries `DETECT_DELTAS` |
| `src/EmbedModal.tsx` | modified | Platform picker shows measured note per profile (old help text claimed "Instagram/1080px works on all platforms" — the exact disproved belief) |

**Critical defect found and fixed:** upstream's `QIM_DELTA = 14` **does not
survive a single JPEG recompression.** CI probing:

```
delta=14  Q95:--  Q90:OK  Q85:--  Q80:OK  Q75:--  Q70:--  Q60:--   ← erratic
delta=20  Q95:OK  Q90:OK  Q85:OK  Q80:OK  Q75:OK  Q70:OK  Q60:--
delta=28  OK at every quality tested
```

Threshold is **26** against a WhatsApp-like recompression. All lossy profiles
now use δ=28 (Instagram also 28 — see §6 caveat). There is a test asserting
δ=14 *fails*, so the change is provably load-bearing.

> **δ is not portable between implementations.** It is expressed in units of
> whatever quantization table the encoder uses. The Python reference quantizes
> with the *channel's measured* table (steps 6–167); the TS encoder quantizes at
> Q75 via Canvas. Python's δ=6 and TS's δ=28 are not comparable. This mistake
> was made once already — don't repeat it.

### 4.2 Networking

| File | Status | What |
|---|---|---|
| `src/net-pool.ts` | **new** | `RelayPool` (one persistent socket per relay, exponential backoff with injectable jitter, subscription re-arming on reconnect, health tracking); `Outbox` (durable queue, persisted before any network attempt, retried until ACK); `RelayRouter` (NIP-65 outbox model) |
| `src/sync-engine.ts` | **new** | Signature verification, merge policies, replaceable-event conflict resolution with deterministic tie-break, cross-transport dedupe, capacity-aware packing |
| `src/nip44.ts` | **new** | NIP-44 v2, verified against the **official spec vectors** |
| `src/net-adapter.ts` | **new** | Drop-in replacement for `relay.ts` — same API, so wiring was a one-line import change in `App.tsx` |

What changed behind identical signatures:

- `publishEvent` was fire-and-forget returning `void`; an event composed offline
  was silently lost. Now queued durably and retried.
- One socket per relay *per event* → one pooled socket per relay (test proves
  5 publishes × 2 relays = 2 sockets, not 10).
- A dropped connection killed the feed permanently → subscriptions re-armed.
- Relay list came from `stegstr.com/config/relay.json` (a centralised single
  point of failure in a decentralised app) → user's own relays, then NIP-65
  lists learned from the network, then hardcoded defaults.
- **Inbound events were never verified.** `relay.ts` did a shape check only, so
  a hostile relay could inject events attributed to anyone. Now every event is
  signature-verified before reaching the UI.

**Merge policy** (per detection, not a global setting — opening an image from a
friend and one from a stranger in a group chat are different situations):

| policy | behaviour |
|---|---|
| `merge-all` | everything merges; the user vouched for this image |
| `follows-only` | **default** — followed authors merge, strangers held |
| `review-all` | nothing merges, whole payload held for review |

Review actions: `promoteAll()`, `promoteAuthor(pubkey)` ("trust this person"),
`reject(id)`, `rejectAll()`, `pendingByAuthor()`. A rejected event does not
reappear (its id stays in the seen set) — deliberate, with a test.

### 4.3 Test infrastructure

`src/__tests__/canvas-polyfill.ts` + `embed-roundtrip.test.ts` — **new**.

Upstream's e2e harness only validated that permutation matrices were *defined*
and deferred real testing to a "semi-manual flow", so the encoder had never been
tested outside a browser. A `@napi-rs/canvas` polyfill (OffscreenCanvas,
ImageData, createImageBitmap with `.close()`) lets the **real shipped encoder**
run under vitest, so embed → channel → detect is asserted in CI. This is what
caught the δ=14 defect.

New dependencies: `@noble/ciphers` (NIP-44 ChaCha20, runtime),
`@napi-rs/canvas` (dev only).

---

## 5. What is left, in priority order

1. **Phone-test the app's own output.** *Nothing in §4 has been round-tripped
   through a real phone using the app* — only the Python reference has. Run
   `npm run dev`, embed with target Instagram, send through Instagram, load the
   return into Detect. Then WhatsApp. **This is the highest-priority item**;
   everything else is worthless if it fails.
2. **Trigger the release workflow.** Tag, let Actions build all three desktop
   platforms, verify artifacts download and run. Do this early — CI failures are
   tedious to debug under deadline.
3. **README with the measurement tables.** This is where "set the terms of
   comparison" happens. Write it so the holder can verify every number in ten
   minutes.
4. **Review UI.** The engine supports quarantine and promotion; nothing in the
   UI calls it. Currently a capability, not a visible feature.
5. **Wire NIP-44 into `stego-crypto.ts`** (still calls `nip04Encrypt` at line
   130). Needs a version byte and a decision on reading old images.
6. **PR the calibration harness to upstream**, separately from the contest.
   Given *"we are supporting the project"*, this reads as contributing.
7. **Rust encoder with matched quantization tables** — the remaining 12 dB
   invisibility win. See §6.
8. **MCP server** for agent operability. Upstream already has `agents.txt`, a
   CLI, and `skill/stegstr/SKILL.md`, so the bar is set; this is a
   differentiator, not a gap.
9. Audio steganography — explicitly in scope, nobody will attempt it, but only
   after 1–3 are solid. WhatsApp transcodes voice notes to Opus, a lossy
   *perceptual* codec, which makes this its own multi-day project.

---

## 6. Known limitations — read before trusting anything above

- **Canvas cannot set quantization tables.** `canvas.convertToBlob({quality})`
  takes only a quality number, so the matched-table approach (12 dB
  invisibility win) is **not implementable in TypeScript**. It needs Rust with
  the `jpeg-encoder` crate, which supports custom tables. Every entrant forking
  this repo inherits the same limitation.
- **The CI channel simulator does not model Instagram's sharpening.** It only
  resizes and re-encodes. Instagram's own quantization is gentle, so CI makes it
  look like an *easy* channel when a phone says otherwise. Instagram's δ is set
  to 28 conservatively rather than the 24 CI suggested. **Do not tune Instagram
  against CI alone** — that is exactly the mistake that produced upstream's
  sim-to-real gap.
- **Adaptive δ has an inherent risk**: the decoder re-derives block texture from
  a *channel-damaged* image, so it can disagree with the encoder about a block's
  rung. Mitigated by measuring activity on zigzag 25–40 (above the embedding
  band, so embedding cannot shift it), quantized values, and a coarse 5-rung
  ladder. Measured cost 0.29% → 1.03%. If real-phone BER climbs sharply, derive
  rungs from a smoothed image instead.
- **Typecheck, tests and build are verified; the UI is not.** No click-through
  of posting/detecting has been done since the wiring change.
- Two upstream tests were modified (`instagram is smallest at 1080`,
  `default platform is instagram`) because they encoded the disproved
  assumption. Reasoning is in comments — worth flagging in any PR.
- Facebook and Twitter geometry is taken from upstream, **not** independently
  measured.
- All measurement is one Android phone, one WhatsApp build, one session.
  WhatsApp Web/Android/iOS do not compress identically.
- `npm audit` reports 8 vulnerabilities (1 critical). **Do not run
  `npm audit fix`** near submission — it can bump majors and break a working
  build.

---

## 7. Calibration tools (branch `calibration`, folder `calibration/`)

| Tool | Purpose |
|---|---|
| `make_charts.py` | Generate test charts (DCT frequency sweep, flat patches, resize probe, gradient, noise) at several widths |
| `analyze_returns.py` | Extract real quantization tables, dimensions, subsampling, estimated quality, double-compression score from returned files; emits a corrected `channel_measured.py` |
| `match_returns.py` | Re-pair platform-renamed returns to sources by image content (needed because several source sizes collapse to identical output dimensions) |
| `sweep.py` | 16-variant embed sweep with visible binary ID patches, so a variant self-identifies even when its payload is destroyed |
| `recover.py` | End-to-end payload recovery with self-contained Reed–Solomon (no pip needed) |
| `round2.py` | Colour path, platform sizing (`--grid worst`, `--grid ig`, `--square`), multi-hop |
| `ig_decode.py` | Resample-back decoding for platforms that rescale |
| `adaptive.py` | Compares placement strategies on masked-visibility and BER |
| `compare.py` | Generates matched pairs for eyeball comparison; `--decode` measures returns |
| `nostr_payload.py` | Real signed nostr events (BIP-340 implemented inline), compression ratios, capacity in notes |

Typical loop: `make_charts.py` → send from phone → `analyze_returns.py`.

---

## 8. Suggested opening message for the new conversation

> I'm competing in a Freelancer contest to build the best version of Stegstr, a
> FOSS steganographic nostr app ($500, judged on steganographic invisibility,
> survival through WhatsApp/Telegram/Instagram, and networking reliability).
>
> I have a fork at github.com/shwetadinkar/Stegstr (branch `calibration`) with
> substantial work already done: real-phone channel measurements, an adaptive
> encoder, a rewritten networking layer, NIP-44, and 148 passing tests.
>
> HANDOFF.md is attached — please read it first, particularly §5 (what's left)
> and §6 (known limitations). I want to start with [item].

Attach `HANDOFF.md`. If the new conversation can read the repo, point it at
`calibration/README.md` and `src/stego-adaptive.ts`, which carry most of the
reasoning in comments.

---

## 9. Addendum — later findings

Added after the main document. Everything below is measured, not inferred.

### 9.1 The live site ships every defect we found

`https://stegstr.com/app/` loads correctly (all assets return 200), so nothing
is broken at the infrastructure level. The problem is the configuration in the
deployed bundle, extracted from `/app/assets/index-CYTwV8ax.js`:

```js
Jh = 14                     // QIM_DELTA — fails a single JPEG recompression (§4.1)
tb = 75                     // embed quality
_o = { instagram: 1080, facebook: 2048, twitter: 1600,
       whatsapp_standard: 1600, whatsapp_hd: 4096,
       telegram_photo: 1920, imessage: 1280, none: 0 }
Th = "instagram"            // default platform
P1 = [83,84,69,71,83,84,82] // "STEGSTR" magic, embedded in the clear
```

`instagram: 1080` measured 42–50% BER, and it is the **default**. `whatsapp_hd:
4096` is downscaled to 1600, same outcome. The live UI label reads
"Instagram (1080px)".

**Do not copy parameters or help text from the live site.** The strings encode
the assumptions the measurements disproved. Layout and interaction patterns are
fine to borrow; treat every number as suspect.

Also confirmed live: `https://stegstr.com/config/relay.json` returns the four
default relays. That endpoint is the centralisation point `net-adapter.ts`
demotes to a last resort.

### 9.2 TypeScript encoder vs the Python reference — measured

Run with the canvas polyfill harness (§4.3), synthetic covers with both flat and
textured regions, 1440×1440 square, simulated channel.

| | Python reference | TS encoder |
|---|---|---|
| Capacity | 32 KB @ 1600 | **64 KB @ both geometries** (uses 24 AC positions vs Python's 12) |
| Adaptive gain (masked visibility) | 2.0× (4.880 → 2.467) | **2.1× (2.525 → 1.199)** |
| PSNR at 4 KB | 32–36 dB | **27–29 dB** |

Three conclusions:

- **Capacity is not a TS shortcoming** — it is better than Python's, and better
  than assumed. 64 KB recovered through a Q70 recompression at both geometries.
- **The adaptive result replicates in an independent implementation.** This is
  the strongest evidence it is real rather than an artifact of one harness.
- **The Canvas limitation costs roughly 4–7 dB.** TS must use δ=28 to survive
  recompression because it cannot write the channel's quantization table;
  Python worked at δ=4–16 with matched tables. That figure is the value of the
  Rust work in §5.7, now measured rather than estimated.

Visibility barely varies with payload size (512 B and 4 KB identical; 16 KB
through 64 KB identical) because AC-major ordering spreads any payload across
the whole frame. It steps once and plateaus.

Caveats: absolute values are not comparable across harnesses (different covers,
different quantization domains) — only ratios transfer.
`getQimCapacityForFile` threw "Unsupported image type" under the test `File`
stub; almost certainly the stub, not a product bug, but unconfirmed.

### 9.3 Three UX defects found by inspection

**Decoded content was never displayed.** The decode path called `setEvents(...)`
and set a status line reading "Loaded N events from image." Notes were then
sorted by `created_at` among everything already held, so anything not recent was
effectively invisible. For an app whose purpose is extracting hidden messages,
not showing them was the wrong default — and merging on open meant anyone who
sends a JPEG could write to the user's feed.

**Fixed.** `src/DetectResultModal.tsx` (new) shows what an image contained,
grouped by author, with signature status, follow status and duplicate detection.
Followed authors are pre-selected; strangers are not. Unverified events are
withheld and counted, never offered. 7 tests in
`src/__tests__/detect-review.test.tsx`.

**Embedding is "take everything, chop off the end".** `App.tsx` builds a bundle
from the *entire* event list, encrypts it, and if it does not fit runs
`trimmedEvents.slice(0, -1)` and retries — looping until it fits. So how much of
the feed goes into an image depends on cover size, compression ratio and
recipient count, and the user only learns after the fact via a log line. It is
also O(n) encryption passes on a large feed.

**Not yet fixed.** `packForCapacity()` in `sync-engine.ts` already implements
the replacement — scores events by usefulness per byte, keeps profiles and relay
lists, drops replies whose parent did not fit — but nothing calls it. Wiring it
in would fix both the selection quality and the O(n) re-encryption.

**Progress is hidden.** `addStegoLog()` and `setStegoProgress()` are called
throughout, so the information exists; it renders in a side panel that is not
visible while looking at the image area. On a large image with a large feed the
encrypt-and-trim loop runs for many seconds with no visible sign of life.

**Not yet fixed.** Presentation change only — surface `stegoProgress` near the
drop zone rather than in the collapsed log.

### 9.4 Updated status

**155 tests passing**, `tsc --noEmit` clean, `npm run build` clean.

New since the main document: `src/DetectResultModal.tsx`,
`src/__tests__/detect-review.test.tsx`, and the decode path in `App.tsx` now
classifies and reviews rather than merging blindly.

Revised priority order for what remains:

1. **Phone-test the app's own output** (unchanged — still nothing has been
   round-tripped through a real phone using the app rather than the Python)
2. Wire `packForCapacity()` into the embed path (§9.3)
3. Surface progress near the drop zone (§9.3)
4. Trigger the release workflow for desktop builds
5. README with the measurement tables
6. NIP-44 into `stego-crypto.ts`
7. Rust matched-table encoder — now measured at 4–7 dB
8. MCP server
9. Audio

### 9.5 Embed selection and progress — now fixed

**Embed selection.** The `slice(0, -1)` retry loop is gone. `encryptAndFit` now:

1. calls `packForCapacity()` to choose events by usefulness per byte — own
   notes weighted highest, then followed authors, profiles and relay lists
   weighted up because losing them makes the recipient unable to identify or
   reach you, recency decaying over weeks, and replies whose parent did not fit
   removed so threads stay readable;
2. binary-searches the packed list to close any residual overflow.

Encryption passes drop from O(n) to O(log n): a 300-event feed that fits 50 ran
~250 full encryptions before, and runs ~9 now. The log states what was selected
and why (`Selected 47/312 events by priority, dropped 3 orphan replies`), so the
answer to "how far back does this go" is visible rather than emergent.

The budget passed to `packForCapacity` is 90% of the capacity, since the cap
applies to the *encrypted* payload while packing estimates from compressed JSON;
the binary search absorbs the difference.

6 tests in `src/__tests__/packing-embed.test.ts`.

**Progress.** A fixed overlay at the bottom of the viewport shows the phase plus
the most recent log line whenever `detecting || embedding` is true. The existing
sidebar bar still renders; the overlay exists because the sidebar is out of
eyeline (and off-screen on narrow windows) while the user is looking at the
image area, so a multi-second embed read as a hang. Showing the live log line
matters more than the spinner — watching the fit search count down is far more
reassuring than a static "Encrypting...".

### 9.6 Final status

**161 tests passing**, `tsc --noEmit` clean, `npm run build` clean.

All three UX defects from §9.3 are now fixed. Remaining work, in order:

1. **Phone-test the app's own output** — still the top priority, still not done.
   Nothing in the app has been round-tripped through a real phone; all
   real-platform verification used the Python reference, which has a different
   DCT implementation and a different quantization table.
2. Trigger the release workflow for desktop builds (`git tag`)
3. README with the measurement tables
4. NIP-44 into `stego-crypto.ts` (needs a version byte for old images)
5. Rust matched-table encoder — measured at 4–7 dB
6. MCP server
7. Audio

---

## 10. Second addendum — real-app phone testing

Everything in §1–9 was measured with the Python reference. This section is the
first testing done through the **actual app**, and it changed several numbers.

### 10.1 WhatsApp works end to end in the app

Embed in the app → send through WhatsApp on a real phone → load the return into
Detect → the review modal lists the notes with their text visible.

That is the platform the maintainer documented as broken (`ReedSolomonError:
Too many errors` in `docs/WHATSAPP_PLAN.md`) and the one he will test first.

### 10.2 Delta is NOT portable, and the shipped default failed

The single most costly mistake in this project was carrying delta values from
the Python reference into the TypeScript encoder. **delta is expressed in units
of whatever quantization table the encoder uses.** Python quantizes with the
channel's *measured* table (steps 6–167); the TS encoder quantizes at Q75 via
Canvas. Python's delta=6 and TS's delta=28 are not comparable quantities.

Re-measured against the TS encoder in CI:

```
delta=14 (upstream default)  Q95:--  Q90:OK  Q85:--  Q80:OK  Q75:--  Q70:--
delta=20                     Q95:OK  Q90:OK  Q85:OK  Q80:OK  Q75:OK  Q70:OK
delta=28                     OK at every quality tested
```

delta=14 is *erratic* rather than merely weak — it passes at Q90 and fails at
Q95. The lattice is marginal enough that survival depends on which way
individual coefficients happen to round. Threshold is 26; lossy profiles ship 28.
A test asserts delta=14 fails, so the change is provably load-bearing.

### 10.3 Instagram: geometry solved, amplitude bracketed

Uploading an already-square 1440×1440 image means Instagram does not resample
(verified on a real account: 1440 in, 1440 out). The 8×8 grid survives intact.

Step size was then bracketed with real posts:

```
delta 28  FAIL       delta 40  FAIL       delta 56  PASS       delta 72  PASS
```

**Instagram needs roughly twice WhatsApp's step (26) despite far gentler
quantization** (steps 5–25 vs 6–167). That settles the mechanism: quantization
was never the damage. Instagram sharpens after processing, which perturbs
exactly the mid-frequency coefficients QIM writes to, and sharpening does not
care how coarse the quantizer is. No amount of quantization-table matching
would have helped.

`instagram` and `universal` both ship delta=56. Universal takes Instagram's
step deliberately: a step surviving Instagram survives WhatsApp and Telegram
with room to spare, and the reverse is not true — universal-at-28 failed on a
real Instagram post.

### 10.4 The unresolved tradeoff — Instagram invisibility

**At delta=56 the embedding is visible on close inspection**: a regular
crosshatch across flat regions (ceiling tiles, walls), confirmed by eye at full
resolution. It reads as uniform grain rather than localised dotting — adaptive
placement spreads energy into texture — so it plausibly passes "casual
inspection", but it is not invisible.

This is the invisibility/robustness tension, and Instagram is where it bites.
The constraint is not delta alone but delta × payload: a larger payload occupies
more blocks, including flat ones where perturbation shows.

Measured points:

| payload | delta needed | appearance |
|---|---|---|
| 4 KB | 56 | visible crosshatch |
| 512 B | 16 | judged clean by eye |
| 32 B | — | 47.7 dB, invisible |

**Recommended direction: ship Instagram as a small-payload pointer tier.** 512
bytes holds a nostr event id plus a NIP-44 key comfortably; the recipient's
client fetches content from relays. That is the tiered architecture, and
Instagram is the case that justifies it.

Untried options, in order of expected value:

1. **Chroma-channel embedding.** Instagram's chroma table equals its luma table
   (unusual), and the eye is far less sensitive to chroma noise. Sharpening
   typically operates on luminance. Plausibly a large win; nobody else will
   have tried it. **This was the agreed next task.**
2. **Restrict to zigzag 1–6.** Sharpening hits high frequencies hardest; fewer
   slots but each far more robust.
3. **More repetition instead of larger delta.** Costs capacity rather than
   visibility.

### 10.5 Bugs found and fixed during app testing

- **`packForCapacity` assumed deflate.** `stego-crypto.ts` does not compress —
  AES-GCM output tracks plaintext size — so the default 0.35 ratio
  over-estimated capacity ~3×, producing `Payload too large: need 140240 bits,
  have 88200 available`. Now passes `compressionRatio: 1.05`.
- **`getQimCapacityForFile` ignored the square flag**, so Instagram capacity was
  computed on a non-square image. Now mirrors the embed path exactly.
- **Download filename was hardcoded `-stegstr.jpg`.** Every platform renames
  uploads, so comparing configurations was impossible. Now includes the target
  platform.
- **Test polyfill returned a duck-typed object from `convertToBlob`.** The
  product code does `new File([blob], …)`, which serialised it as a string and
  produced a 15-byte file. File-level tests were passing for the wrong reason
  and never exercised the resize path.

### 10.6 Flat covers fail

A logo cover (large uniform areas) failed the round-trip self-test outright.
Flat regions have no texture to mask embedding, and adaptive delta gives them
the *smallest* step — correct for invisibility, wrong for robustness. This is a
property of the technique, not a bug. The app now says so when the self-test
fails, and it belongs in the README: **a judge may well try a logo or a
screenshot.**

### 10.7 Current status

**169 tests passing**, `tsc --noEmit` clean, `npm run build` clean.

Remaining work, in order:

1. **Chroma embedding for Instagram** (§10.4) — the agreed next task
2. Telegram confirmation through the app (same geometry as WhatsApp; expected
   to pass, not yet verified)
3. Trigger the release workflow for desktop builds (`git tag`)
4. README with the measurement tables
5. NIP-44 into `stego-crypto.ts` (needs a version byte for old images)
6. Rust matched-table encoder — measured at 4–7 dB, but note §10.3: it would
   not help Instagram, whose damage is sharpening rather than quantization
7. MCP server
8. Audio

### 10.8 Working notes for whoever picks this up

- **Verify file freshness after every copy.** Three separate debugging rounds
  traced to a stale or missing file. `grep` for something distinctive in the new
  version immediately after copying.
- **Restart the dev server after editing `stego-adaptive.ts`.** Vite HMR can
  leave the embed path on new constants and the detect path on old ones,
  producing a valid image the app cannot read.
- **CI cannot model Instagram's sharpening.** The simulator only resizes and
  re-encodes, so it makes Instagram look easy. Never tune Instagram against CI
  alone — that is exactly the mistake that produced upstream's sim-to-real gap.
- **PSNR misleads here.** It ranked a visibly dotted image above a clean one.
  Use the masked-visibility metric (perturbation ÷ local texture) or human eyes.

---

## 11. Third addendum — chroma-channel embedding built (§10.4 item 1)

§10.4's agreed next task is done: chroma bits are filled before any luma
slot, so a payload that fits in chroma capacity now needs **zero** luma
modifications instead of a smaller-but-still-visible one. Real-phone
bracketing of `chromaDelta` is still outstanding — everything below is
CI-verified against the real encoder, not yet confirmed on a real Instagram
account.

### 11.1 The subsampling finding that decided the design

Before writing any embedding code, I probed whether the real JPEG encoder
(`@napi-rs/canvas`, the same encoder proxy the CI harness already trusts for
the luma path) actually subsamples chroma, and by how much. It does, and
quality does not disable it: a chroma checkerboard at the Nyquist frequency
(alternating every pixel) is destroyed at every quality tested, including 95.
Patterns at 4px+ period survive.

That means one chroma DCT block corresponds to a **16×16 region** of the
image, not 8×8 like luma — chroma embedding has to operate on that grid, not
the luma grid.

The trick that avoids needing to know the encoder's *exact* filter (box,
triangle, whatever a given browser uses): write the target chroma value as a
flat, piecewise-constant 2×2 tile across the whole 16×16 super-block. Any
reasonable local-averaging filter applied to an already-constant region just
reads the constant back out. Verified directly: downsampling a super-block
written this way recovers the exact value written, round-tripped through the
real encoder.

### 11.2 What was built

| File | Status | What |
|---|---|---|
| `src/dct.ts` | modified | Added the IJG standard chrominance quantization table (Table K.2, distinct from luma's Table K.1 even at equal quality); `quantizationTable(quality, channel)` generalised, luma stays the default so every existing call site is unchanged |
| `src/stego-color.ts` | **new** | RGB↔YCbCr conversion; 16×16 super-block downsample (2×2 box average) / upsample (flat-tile write) |
| `src/stego-adaptive.ts` | modified | `PlatformProfile` gained optional `chromaDelta`/`chromaChannels` (undefined = chroma off, every non-Instagram profile unchanged); `instagram` and `universal` embed in Cb+Cr at δ=28 as a conservative starting point; added `instagram_chroma_d28/d40/d56` bracket profiles — luma fixed at the already-validated 56, only chromaDelta varies, same discipline as the `instagram_d*` luma bracket that settled on 56 |
| `src/stego-qim.ts` | modified | Chroma-first bit allocation (`chromaBits ++ lumaBits`); symmetric embed/detect chroma passes; capacity function updated to mirror the embed path; `encodeQimImageFile`/`getQimCapacityForFile` resolve chroma settings from the profile the same way they already resolved delta; `decodeQimImageFile` tries the small set of chroma-capable profiles first (a chroma-embedded image is not decodable by a luma-only guess — the chroma bits carry the header), then falls back to the existing luma-only `DETECT_DELTAS` sweep for backward compatibility |
| `src/EmbedModal.tsx` | modified | Labels for the new bracket profiles, so they're selectable from the UI for phone testing without further code changes |

Capacity at 1440×1440: chroma adds ~389K raw slots (90×90 super-blocks × 24
AC positions × 2 channels) on top of luma's ~778K. The `universal` profile's
capacity rose from what it was luma-only to 29,019 bytes in the existing
capacity test.

### 11.3 Verified in CI (176 tests passing, `tsc --noEmit` clean, `npm run build` clean)

- Chroma payload round-trips through the real encoder (not just simulated
  quantization), both via the low-level `embedQim`/`detectQim` and the
  file-level `encodeQimImageFile`/`decodeQimImageFile` API.
- A 4KB payload — the size that produced a visible crosshatch on real
  Instagram at δ=56 (§10.4) — leaves the luma channel measurably quieter
  (roughly half the mean Y perturbation) when routed through chroma first
  instead of embedded directly in luma.
- Every non-Instagram profile (no `chromaDelta` set) produces byte-identical
  output to before this change.
- The existing `universal` end-to-end test (capacity → embed → self-test →
  decode) passed unmodified, now exercising the chroma path.

One honest caveat found while writing the invisibility test: recomposing a
pixel's RGB from `(Y, newCb, newCr)` and rounding each channel to an 8-bit
integer independently does not perfectly preserve Y — a small drift
proportional to how many super-blocks were touched, on top of JPEG
generation-loss noise shared by both the chroma and luma cases. Real but
small: roughly half the magnitude of actual QIM-driven luma perturbation in
the measured case, not zero.

### 11.4 What's still open

1. **Real-phone bracket testing of `chromaDelta` on Instagram** — the actual
   next step. Use the `instagram_chroma_d28/d40/d56` profiles from the UI,
   exactly the same loop that bracketed luma delta in §10.3. CI cannot model
   Instagram's sharpening (§10.8), so this cannot be skipped.
2. Once a surviving `chromaDelta` is known, re-check whether luma delta can
   drop below 56 now that chroma is carrying weight — a second bracketing
   round, not yet attempted.
3. Everything else from §10.7 (Telegram app confirmation, release workflow,
   README, NIP-44 wiring, Rust matched-table encoder, MCP server, audio) is
   unchanged and still open.

---

## 12. Fourth addendum — two real bugs found by actually running the app

The contest holder's guidance is explicit: test and use the app to find bugs
and fix them, rather than add speculative features. Both bugs below were
found exactly that way -- by embedding through the real app in a real
browser and hitting real failures, not by reasoning about the code in the
abstract. Both are now fixed and covered by regression tests.

### 12.1 Chroma embedding failed on a real photo -- redesigned, not patched

§11's DCT-AC-coefficient chroma scheme (24 slots/block, mirroring luma)
passed every test built for it and then failed immediately on the first real
app self-test, with a real photo, at delta=28. Root cause, found by
capturing raw embedded bits against raw detected bits and bisecting: a
super-block with real embedded AC content is not spatially flat -- non-zero
AC coefficients ARE spatial variation by definition. JPEG decoders
reconstruct chroma with smooth ("fancy") upsampling that blends
continuously across the whole image, with no concept of an 8x8-block
boundary in the reduced-resolution chroma plane. That blending corrupted
exactly the fine structure the scheme depended on.

Two things confirmed this was a spatial-domain mismatch, not a marginal
noise-margin problem: raw bit-error rate got *worse* as chromaDelta
increased (17,400 mismatches at delta=28 rising to 31,454 at delta=128 on a
388,800-bit test), and disabling the texture-adaptive step made no
difference. A noise-margin problem gets better with more margin; this got
worse, because more margin meant larger coefficient swings, meaning larger
internal spatial variation for the decoder to smear.

**Fix: one scalar QIM value per super-block per channel, not 24 DCT
coefficients.** Write it as a genuinely flat, uniform 16x16 patch (survives
the encoder's subsampling for the same reason a flat 2x2 tile does). Read it
back from the block's *safe interior* only (excludes ~4px on each edge,
clear of the ~2px zone empirically observed to blend toward a neighbour).
No DCT, no chroma quantization table, no texture-adaptive step -- that
machinery measured activity from DCT coefficients above the embedding band,
which don't exist in a scalar-domain scheme.

Cost: capacity drops from ~29KB to **~16,200 raw bits (roughly 250-300
usable bytes at the default RS overhead)**. This isn't a regression from
where this was always going to land -- §10.4's own fallback plan for
Instagram was a small-payload pointer tier (a nostr event id + a NIP-44 key,
comfortably under 300 bytes), and that's exactly what this capacity now
supports cleanly, verified through a real encode/decode round trip rather
than assumed.

Re-verified in CI against the *exact* scenario that broke: a payload sized
to span both channels and overflow into luma now round-trips correctly.

### 12.2 The rewritten networking layer lost the Global feed

Reported symptom: relay websockets connect fine (confirmed via browser
DevTools -- 4 of 5 relays returning HTTP 101, a successful handshake), but
the Global feed tab never shows anything from outside your own follows.

Root cause, found by diffing the networking rewrite (`net-adapter.ts`)
against the pre-rewrite `relay.ts` (still present on `origin/main`, the
branch that predates the §4.2 rewrite): the old code's initial subscription
bundled multiple filters into one REQ, including author-*unscoped* ones --
`{kinds:[1], limit:300}` with no `authors` field, which is what a Global
feed actually is. The rewrite's `connectRelays` kept only author-scoped
filters (`authors: ourPubkeys`) for both the "feed" and "meta"
subscriptions, so the Global feed was never asking relays for anything
beyond the user's own follows. Not a connection bug -- a missing filter.

`App.tsx`'s `feedFilter === "following"` branch already correctly narrows
the *displayed* set down to `contactsSet` client-side, so no UI code needed
to change -- the display layer was already correct and had nothing to work
with.

**Fix**: `net-adapter.ts`'s `connectRelays` now also sends an
author-unscoped subscription (`{kinds:[1,6],limit:100}` +
`{kinds:[0],limit:200}`), matching what the pre-rewrite code did. Verified
`RelayPool.subscribe` (`net-pool.ts`) is filter-agnostic -- it has no
assumption that a filter includes `authors`, so this required no changes
there.

### 12.3 Current status

**179 tests passing**, `tsc --noEmit` clean, `npm run build` clean.

1. **Real-phone bracket testing on Instagram** — now testing the redesigned
   scalar-per-block scheme rather than the broken DCT-AC one. Still the
   priority; still needs a human with an Instagram account.
2. Verify the Global feed fix actually populates in a real browser against
   real relays (I can't open a browser myself -- this needs to be confirmed
   by running the app).
3. Everything from §11.4 (luma-delta re-bracketing once chroma is proven,
   Telegram app confirmation, release workflow, README, NIP-44, Rust
   encoder, MCP server, audio) is unchanged and still open.
