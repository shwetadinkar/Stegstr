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
| Telegram (photo) | ~~caps around 1920; 1600×1200 returned unchanged~~ **WRONG, see §15.9** — re-encodes everything to **1280×960** | ≤1280 |
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
| Telegram 1600 | 4 KB tested | 0.25–0.53% | — | *(suspect: see §15.9, the returned image was probably never checked)* |
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

### 12.3 Current status (superseded by §12.4 below)

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

---

## 12.4 Fifth addendum — the scalar chroma fix wasn't enough on a real photo

§12.1's scalar-per-block redesign was verified only against a synthetic
sine-wave test cover. The first real-app test, on an actual photo, failed
immediately (`No QIM payload found`) and surfaced three more real problems,
found in this order:

**RS parity overhead was consuming most of chroma's tiny capacity.**
`rsNsym` defaults to 128, but RS parity is a *per-chunk* cost -- a small
~60-byte payload's single chunk still pays 128 bytes of parity, more than
doubling it. Against chroma's ~8100-block-per-channel capacity, that alone
saturated ~99% of the whole cb channel. Chroma-enabled profiles now carry
`rsNsym: 32` (PlatformProfile gained an `rsNsym?` field, resolved through
`encodeQimImageFile`/`getQimCapacityForFile`/`decodeQimImageFile` the same
way `chromaDelta` already was).

**Flat-fill destroyed natural chroma texture.** The scalar value was written
as a uniform flat 16x16 patch -- correct for surviving the encoder's
subsampling, but on a real photo (rich local colour detail, unlike a
synthetic sine pattern) this reads as an obvious mosaic of flat-coloured
swatches replacing real texture. Confirmed by eye: every touched block a
visibly different, vivid colour cast, in exactly the pattern the contest
holder's screenshot showed. Fixed by writing a uniform *additive shift*
instead of a flat overwrite (`shiftChromaSuperblock`, was
`writeChromaSuperblockScalar`): every 2x2 group's average still shifts by
exactly the same amount regardless of the encoder's filter (same
subsampling-invariance property), but the block's own natural variation is
preserved, so what survives is a subtle colour cast over real detail rather
than a flat swatch. Real-photo result: from a vivid wall-to-wall checkerboard
to a much fainter tint, concentrated on the flattest part of the image (the
ceiling) -- residual visibility on flat regions is the same phenomenon
§10.6 already documented for luma (flat covers have no texture to mask
perturbation in) and is not fully resolved.

**A fixed erasure-margin constant silently stopped working at delta=28.**
`QIM_ERASURE_MARGIN` was `QIM_DELTA / 6` using the module's *default*
QIM_DELTA=14, not whatever delta was actually in use -- so at chromaDelta=28
the threshold was half of what it should have been, missing real corruption
entirely (0 bytes ever flagged as erasures on the failing real-photo test).
Replaced with a per-bit-position threshold derived from whichever delta
actually produced that bit (`bitDelta`/`groupedDelta`, threaded through
detection), so RS gets accurate erasure hints regardless of which channel or
delta a byte's bits came from. This almost certainly also affects luma at
non-default deltas (28 is the default lossy-profile delta), though luma
hasn't shown a problem in real-platform testing.

**Repeat-copies of one logical bit landed in spatially adjacent blocks, so a
locally bad region defeated majority voting.** `buildChromaBlockStream`
visits blocks in simple row-major order, and `repeatBits` duplicates each
logical bit `repeat` times consecutively -- so all 5 copies of a bit land in
5 nearby blocks. Measured on the real photo: errors concentrated in the
ceiling (rows 0-16 of 90), not spread evenly, so a bit whose 5 copies all
fell in that region could fail regardless of redundancy. Fixed with a
standard block interleaver (`interleavedPhysicalIndex`): spreads the 5
copies across five widely-separated bands of the full chroma capacity,
computed identically by encoder and decoder from capacity and repeat alone
(no shared state needed). Scoped to chroma only -- luma's existing AC-major
ordering already spreads a single AC position across the whole image before
advancing and is validated working on real platforms (§10.1); changing it
risked regressing something with no measured problem to justify touching it.

**Verified end-to-end against the actual real photo** (not the synthetic
cover): embed -> real JPEG encode -> decode now round-trips exactly, using
the profile-driven `encodeQimImageFile`/`detectQim` path with no manual
parameter overrides.

**Honest remaining gap**: `stego-chroma.test.ts` still only uses a synthetic
sine-wave cover. That cover did not reproduce any of the three real-photo
bugs above -- real-photo testing is what found all of them. The test suite
does not yet guard against this class of regression; it currently relies on
manually re-running against a real photo. A synthetic cover with a large,
JPEG-artifact-heavy flat region might catch the texture/erasure issues, but
this was not attempted -- noted here rather than left silent.

### 12.5 Current status

**180 tests passing**, `tsc --noEmit` clean, `npm run build` clean.

1. **Real-phone bracket testing on Instagram** -- still the priority, now
   testing a design that has survived a real photo locally, which none of
   the previous versions had.
2. Consider whether the erasure-margin fix should also change luma's
   behaviour at non-28 deltas -- untested, though luma has no known problem.
3. Consider adding a synthetic-cover regression test for the
   texture/erasure class of bug, so future changes don't need a real photo
   to catch a regression here.
4. Everything from §11.4/§12.3 (luma-delta re-bracketing, Telegram app
   confirmation, release workflow, README, NIP-44, Rust encoder, MCP server,
   audio) is unchanged and still open.

## 13. Sixth addendum — zigzag restriction, and a session spent finding app bugs

Two distinct threads. The first was the planned steganography work (§10.4
option 2). The second, which turned out to matter more, was the contest
holder's actual instruction -- *"thoroughly test and use the app to find bugs
and fix them"* -- which produced seven real bugs, one of which explains a
failure that had been misattributed to the encoder.

### 13.1 Zigzag 1-6 restriction (§10.4 option 2) — built, not validated

`QimOptions` and `PlatformProfile` gained `lumaAcCount` (default
`AC_INDICES.length` = 24, i.e. unchanged behaviour). Restricting to the
lowest 6 AC positions is threaded through `buildCoeffStream`, `embedQim`,
`detectQim` and `getQimCapacityBytes`. Bracket profiles
`instagram_zz6_d20/d28/d40/d56` mirror the `instagram_d*` ladder: d56 is the
control (same step as the validated full-band profile, isolating whether
restriction *alone* helps), the rest test whether restriction permits a
smaller step.

Two things this immediately re-taught:

**`rsNsym: 32` was needed again, for the same reason as chroma (§12.4).**
Six of 24 AC positions is a quarter of the raw capacity, and the default
`rsNsym: 128` is a per-chunk cost -- so parity was eating over half an
already-small budget. Symptom in the app: *"5 items, all profiles, no text"*.
`packForCapacity` scores by usefulness-per-byte, and stranger profile events
are small and dense, so they fill a tight budget completely before any actual
note text fits. The profile-level fix doubled usable payload.

**The decode-side blind guess had the same omission.** Phase 2 of
`decodeQimImageFile`'s profile sweep passed `lumaAcCount` but not `rsNsym`,
so a zz6 image would have been undecodable by auto-detection even though it
encoded correctly. Found by reading the sweep rather than by a failure --
worth noting because nothing in the test suite would have caught it.

**Result so far: restriction did not visibly help.** Comparing zz6 d56
against plain d56 by eye on a real photo, pre-Instagram: *"I found no
difference, rather only d56 looks better."* That is one observer on one
photo before any platform round-trip, so it does not settle option 2 --
the hypothesis was about surviving *sharpening*, which only a real
Instagram post can test. But it is evidence against the optimistic reading,
and it is recorded here rather than left as an untested "should help".
§10.4 option 3 (more repetition instead of larger delta) remains untried.

### 13.2 The self-test bug — why a "d56 image won't decode"

A d56 image produced by the app failed to decode. Diagnosed directly rather
than guessed at:

- The exact downloaded file was genuinely undecodable, confirmed by pinning
  `delta: 56` explicitly (so blind-guessing was not the variable).
- A *fresh* encode of the same source photo at the same `instagram_d56`
  profile passed self-test and decoded cleanly.

So the pipeline was fine and that specific file was born broken. The cause:
**`qimSelfTest` ran, failed, logged a warning -- and the code downloaded the
image anyway and reported `SUCCESS - Download started!`**. The app already
knew the file was unreadable and handed it over regardless, with the only
signal being one log line among many. Any user testing several payload sizes
in a row would end up sharing an undecodable image without noticing.

The first fix was to stop and refuse. That was correct but not sufficient --
it left the user to guess a smaller payload by hand, and the error text was a
paragraph of generic speculation about flat covers.

**The real fix: shrink automatically.** The byte-capacity check bounds
theoretical bit capacity; whether a payload actually *survives* extraction
(real texture, RS parity, erasure margins) can only be answered by encoding
it and reading it back. So when the full selection fails self-test, the embed
path now binary-searches down to the largest event count that passes,
re-encoding and self-testing at each candidate -- log n attempts, the same
idiom already used for the byte-capacity fit. If a smaller set works it
downloads that and logs `Self-test required trimming to N/M events`. An error
appears only when *zero* events also fails, which rules out payload size
entirely and means the cover or the delta is at fault -- and that message now
reports the actual self-test failure reason instead of guessing.

**Known gap:** trimming is whole-event. A single event too long for the
cover still yields an empty bundle. Truncating one event's content is
possible but constrained by signatures: `content` is covered by the event id
and `sig`, so truncation invalidates both and the decoded event fails
`verifyEvent`. For the user's *own* notes this is clean (we hold the key and
`buildBundle` already re-signs synthetic events). For another author's note
it is not -- re-signing altered content with a different key would attribute
words to someone who did not write them, and shipping it unsigned means an
unverified item in the decoded feed. Discussed, deliberately not built.

### 13.3 Five more app bugs, and a recurring shape

**`events` had quietly become two things at once.** §12's Global-feed fix
made the unified `events` state include every author seen on the network --
correct for display, wrong for embedding, because "embed my feed" silently
became "embed a slice of the entire Global feed". Combined with
`packForCapacity`'s density ranking, strangers' cheap profile events crowded
out real content at any tight capacity. Fixed with an explicit
`embedCandidates` filter (own identities + follows) at the embed boundary.

**`importedEventIds` was declared and read, but never written.** The Home
feed filters out self-authored notes unless they are in that set, so a
decoded own note could never appear -- "Add to my feed" logged success and
did nothing visible. Now populated in `DetectResultModal`'s `onAccept`.

**The desktop (Tauri) embed path had drifted.** It duplicates the web embed
logic and had received neither fix: it bundled raw unfiltered `events`, and
it called `encryptOpen` unconditionally -- so choosing *"Recipients only"* in
the modal had **zero effect** on desktop builds. Both corrected to mirror the
web path.

**Blind decode looked like a hang.** The sweep runs up to ~20 full-resolution
DCT passes, and the progress line was frozen on one string throughout. On a
large file (a 6MB photo picked by mistake) that is indistinguishable from a
crash. `QimOptions` gained an `onProgress` callback so the UI shows
`Trying QIM decode (3/20: zigzag delta 40)...`.

**The recurring shape.** Two of these are the same bug class: *state declared
and read but never written*, and *one state pool quietly serving two
purposes*. After finding both, every `useState` in every `.tsx` was audited
for setters never called and values never read -- no further instances. Worth
re-running that check after any future state refactor; it is a two-line shell
loop, not a tool.

### 13.4 Current status

**180 tests passing**, `tsc --noEmit` clean, `npm run build` clean.

Honest caveat on all of §13: everything above is verified locally (tests,
types, build, and direct diagnosis against the real photo). The app-level
fixes have been only partially confirmed in a browser -- "Add to my feed" is
confirmed working by the user; the zz6 text-in-feed result, the auto-shrink
retry, and the desktop-path fixes are not yet confirmed by a real session.
Every core-stego edit needs a full dev-server restart to take effect (§9's
HMR-staleness warning still applies, and a hard browser reload may be needed
too).

1. **Real-phone bracket testing on Instagram** -- unchanged as the priority.
   zz6 now has a bracket ladder selectable from the UI for exactly this.
2. Decide whether §10.4 option 3 (more repetition instead of larger delta)
   is worth trying, given option 1 (chroma) is unusable at large payloads
   and option 2 (zigzag) showed no visible improvement pre-platform.
3. Consider per-event content truncation for own notes (§13.2 gap).
4. Everything from §12.5 is unchanged and still open.

### 13.5 Seventh addendum — the capacity number was lying, and two bugs it hid

Continued app testing after §13.4. Four more real bugs, and a measurement that
changed the default profile.

**"Add to my feed" was still broken — one filter further down.** §13.3 fixed
`importedEventIds`, but the Following tab applies a second test:
`contactsSet.has(authorPk)`. You do not follow yourself, so your own notes --
including the one just imported from an image -- were filtered out whenever
that tab was active. This is why it looked intermittent ("rectified in a few
cases, still there in most"): it depended on the active tab, not the note. Own
notes and anything in `importedEventIds` now pass regardless of tab. Worth
noting the shape repeated a third time: an own-note exception missing from a
filter written with only other people's content in mind.

**The auto-shrink search shipped empty images.** §13.2's binary search had a
floor of 0, and an empty bundle -- a bare encryption envelope of a few hundred
bytes -- always passes self-test. So when nothing fit, the search "succeeded"
at zero events and downloaded an image carrying nothing, which then decoded
perfectly and reported `0 new items`. The fix that was supposed to stop
shipping broken images was instead shipping empty ones. Floor is now 1.

**`detectQim` returned corrupt data as success.** On `pako.inflate` failure it
returned the still-deflated bytes with a comment guessing "maybe it wasn't
compressed". Two consequences. Deflate *expands* incompressible input
(AES-GCM output) by ~11 bytes, so the caller saw a payload of the compressed
length -- surfacing as `Self-test length mismatch: expected 1930, got 1941`,
which reads like a framing bug and is actually plain corruption wearing a
disguise. Worse, `decodeQimImageFile`'s blind sweep breaks on any non-empty
result, so a garbage return stopped the remaining delta candidates from ever
being tried. Now returns null. Nothing in the app embeds uncompressed, so the
backward-compatibility case the fallback existed for does not arise.

**Over-long single notes are now carried shortened rather than dropped.**
Whole-event trimming cannot help when one note is itself too big. Content is
covered by the event id and `sig`, so a cut note has to be re-signed -- fine
for the user's own notes (we hold the key, and `buildBundle` already re-signs
synthetic events), impossible for anyone else's. Re-signing someone else's
altered words under a different key would attribute text to them they never
wrote, so other authors' notes are still dropped whole. `truncate-resign.test.ts`
pins all three halves of this, including that an un-re-signed cut note really
does fail `verifyEvent`.

**The measurement: reported capacity was ~2.4x what the encoder could
deliver.** Same cover, same geometry, same delta 56, only the AC band
differing:

```
  24 AC positions   reported 9641 B   PASS at 1930 B   FAIL at 4000 B
   6 AC positions   reported 4226 B   PASS at 1930 B   PASS at 4000 B
```

The capacity formula counted every embedding slot as usable. True of the DCT
grid, false of the channel: high-frequency AC positions do not survive a
quality-75 re-encode, so bits placed there were counted and then lost. This is
what "capacity says 9 KB but only 170 characters fit" actually was -- not a
packing bug, a promise the encoder could not keep, with the self-test shrink
loop quietly absorbing the difference. `getQimCapacityBytes` now estimates
over the reliable band (`RELIABLE_LUMA_AC = 6`) regardless of how many
positions are written; the extra positions become redundancy rather than
advertised space.

**Consequence: zigzag restriction is now the default, not an experiment.**
`instagram` and `universal` moved to `lumaAcCount: 6, rsNsym: 32`, and chroma
was dropped from both -- §12.4 measured it tinting flat regions visibly, and
it is worse than luma alone at any payload big enough to matter. Old images
still decode; `decodeQimImageFile` sweeps chroma and full-band candidates.

This reverses §13.1's reading. Restriction showed no *visual* improvement by
eye, and that was recorded as evidence against it -- but the hypothesis it was
built on was about *survival*, and on survival it wins clearly. The two
questions were being answered with the wrong measurement.

**Honest limit of the new number.** 4226 B is still optimistic at the very
top: 3200 B passes on repeated payloads, 4000 B is borderline (passes with one
payload, fails with another). The app budgets at 85% (3592 B) and the
self-test shrink absorbs the rest, so the shipped path has margin -- but the
figure shown in the embed modal is the raw one, and a user filling it exactly
would be relying on the shrink loop rather than the estimate.

### 13.6 Current status

**183 tests passing**, `tsc --noEmit` clean, `npm run build` clean.

1. **Real-phone Instagram testing** -- unchanged as the priority, now against
   a default profile that is measured rather than assumed.
2. Consider deriving `RELIABLE_LUMA_AC` from measurement across several
   covers rather than one photo; 6 is where the bracket ladder happened to
   sit, not a value anything searched for.
3. Truncation currently only fires for a single over-long note at the head of
   the selection. A mixed feed whose *last* fitting event is over-long still
   drops it whole.
4. Everything from §12.5 and §13.4 is unchanged and still open.

### 13.7 Eighth addendum — deleting a note made it unrecoverable from an image

**A deleted note could never be re-imported.** Deleting does not remove the
note: it appends a kind-5 tombstone and leaves the kind-1 in `events`.
`rootNotes` then filters that id out permanently. So decoding an image
containing a note you had once deleted offered it as new, accepted it, merged
it successfully -- and the display filter dropped it straight back out, with
no message. Found by a user testing exactly the sensible way: delete the feed,
then decode the image that contains it. An explicitly imported id now
overrides the tombstone, since accepting in the review modal is a deliberate
"put this back".

**`Added N item(s) to feed` has now been misleading three separate times**
(§13.3 importedEventIds, §13.5 the Following tab, and this). Every one of
those bugs lived in the *display*, while the log line reports the *merge*,
which always succeeds. It now prints a line per accepted item saying whether
it will appear and, if not, why -- reply, non-note kind, previously deleted.
The next bug of this shape should announce itself instead of looking like a
dead button.

**Not a bug, worth recording:** importing a note you already hold correctly
does nothing. Nostr events are content-addressed, so the same note has the
same id everywhere; there is no "duplicate copy" state to represent. The
review modal reports these as "already had" rather than as new. This confused
testing for a while -- embedding your own feed and decoding it on the same
machine cannot demonstrate that import works, because there is genuinely
nothing to import.

**Picker sanitised.** 13 of the 22 profiles in the dropdown were bracket
ladders. They cannot be deleted -- `decodeQimImageFile` sweeps
`PLATFORM_PROFILES` to auto-detect an image's settings, so removing one makes
every image made with it undecodable -- so `USER_PLATFORMS` now controls what
the picker offers (9 real targets) while the record keeps everything. A
checkbox reveals the test profiles for real-device bracketing, and the
current selection is always listed so it cannot vanish mid-test. Two tests
guard the split. A third test was tightened: it had exempted every profile
with `lumaAcCount` set, which silently stopped covering `instagram` and
`universal` once §13.5 gave them that field.

**185 tests passing**, `tsc --noEmit` clean, `npm run build` clean.

### 13.8 Ninth addendum — the delete fix broke delete

§13.7's restore-a-deleted-note fix made every note that had ever appeared in
a decoded image permanently undeletable. `importedEventIds` is populated with
EVERY event of EVERY decoded image, accepted or not -- it exists so the feed
will display your own notes at all -- and the new deletion override read that
same set as "the user explicitly chose to restore this". Two meanings, one
set: the tombstone was written and immediately overridden, so Delete did
nothing.

Fixed by putting the restore where it belongs. Deletion is decided solely by
kind-5 tombstones again, and accepting a note in the decode review *removes*
its tombstone -- a real un-delete, after which Delete works normally. A filter
exception would have had to argue with the tombstone forever.

Closing that loop needed one more change: a deleted note is still physically
in `events` (delete keeps the note and adds a tombstone), so the review modal
counted it as "already had" and never offered it, making the restore path
unreachable. Tombstoned ids are no longer treated as duplicates, derived from
the same `events` snapshot as `knownIds` so the two cannot disagree.

The recurring lesson, now three instances deep: state that answers "where did
this come from" is not the same as state that answers "what does the user want
done with it", and reusing one for the other has broken a different feature
each time.

**185 tests passing**, `tsc --noEmit` clean, `npm run build` clean.

## 14. Session summary — bug hunting, and Instagram demoted

This session had two halves. The planned steganography work (§10.4 option 2,
zigzag restriction) took a few hours; the rest went on the contest holder's
actual instruction -- *"thoroughly test and use the app to find bugs and fix
them"* -- which produced fourteen real bugs, three of them mine, found by a
human using the app rather than by any test.

### 14.1 The single most important finding

**The reported capacity was ~2.4x what the encoder could deliver.** Measured
on one real photo, same cover and geometry and delta, only the AC band
differing:

```
  24 AC positions   reported 9641 B   PASS at 1930 B   FAIL at 4000 B
   6 AC positions   reported 4226 B   PASS at 1930 B   PASS at 4000 B
```

The capacity formula counted every embedding slot as usable -- true of the DCT
grid, false of the channel, because high-frequency AC positions do not survive
a quality-75 re-encode. Bits placed there were counted and then lost. Capacity
now estimates over the reliable band only (`RELIABLE_LUMA_AC = 6`).

Nearly every confusing symptom this session traced back to this one number:
"capacity says 9 KB but only 170 characters fit", self-tests failing on
payloads well under the stated limit, the shrink loop walking down to nothing.
The encoder was refusing to lie; the estimate was.

**It also reversed a conclusion.** §13.1 recorded zigzag restriction as
showing no improvement, based on a visual comparison. That was answering the
wrong question: the hypothesis was about *survival*, and on survival the
restriction wins clearly. It is now the default for Instagram rather than an
experiment.

### 14.2 Instagram demoted to a side target (decided this session)

Instagram is the only platform that forces a 1440 square canvas and the only
one that sharpens, which is why it needs step 56 where every other measured
platform survives at 28 -- twice the perturbation, and perturbation is the
criterion this project is judged on. Every hard problem this session (visible
crosshatch, chroma tinting, the zigzag work, capacity collapsing) traces back
to Instagram alone.

The user then raised the point that settles it: **Instagram has no native way
to download the image back.** A steganographic channel needs the file byte for
byte, and a screenshot is a re-render that fails regardless of how robust the
payload is. Even a perfect encoder leaves the receiver with no way to get the
carrier out.

So:

| Profile | Geometry | Step | Role |
|---|---|---|---|
| `universal` | 1600, aspect kept | 28 | Main target: WhatsApp, Telegram, Twitter, Facebook |
| `telegram_file` | no resize | 20 | Maximum capacity -- lossless, tens of KB |
| `instagram` | 1440 square | 56 | Side target, best effort |

`universal` previously carried Instagram's square canvas and step 56, which
charged every WhatsApp and Telegram user twice the perturbation for a platform
they were not sending to. It no longer does.

`telegram_file` is new: Telegram's "send as file" does not recompress, so the
cover keeps full resolution and the only damage is this app's own encode.
Capacity scales with the cover -- roughly 25 KB on a 4096x3072 photo against
~2-4 KB for every resized channel. Must be sent as a *file*; sending it as a
photo puts it through the 1600px path and destroys the payload.

### 14.3 The recurring bug class

Three separate bugs, and one regression, all the same shape: **state that
records "where did this come from" is not state that records "what does the
user want done with it".**

- `importedEventIds` was declared and read but never written, so a decoded own
  note could never appear (§13.3).
- The Following tab tested `contactsSet` only -- you do not follow yourself,
  so your own imported note was filtered out (§13.5).
- Deleting a note left it permanently unrecoverable from an image (§13.7),
  and the fix for *that* read `importedEventIds` -- which is populated with
  every event of every decoded image -- as "explicitly restored", making every
  such note permanently undeletable (§13.8).

All three presented identically as "Add to my feed does nothing", because
`Added N item(s) to feed` reports the *merge*, which always succeeds, not the
*display*, where every one of them lived. That log line now prints a reason
per item.

Worth re-running after any state refactor: a two-line shell loop over every
`useState` in every `.tsx`, checking for setters never called and values never
read. It found the first of these.

### 14.4 State at end of session

**186 tests passing**, `tsc --noEmit` clean, `npm run build` clean. All work
committed and pushed to `calibration`.

Honest caveat, unchanged and now the whole story: **nothing here has been
through a real platform.** Every measurement above is this encoder reading its
own output. The profiles were restructured on the strength of local
measurement plus a product argument, which is sound reasoning but is not the
same as evidence.

### 14.5 Next session — start here

**Round 1: do the defaults survive? (4 uploads.)** Same cover photo, same
short note (~500 B) each time, so payload size is not a confound.

| # | Profile | Send via | Tests |
|---|---|---|---|
| 1 | `universal` | WhatsApp, normal | The new main target |
| 2 | `universal` | WhatsApp, **HD** | Whether merging the two entries was right |
| 3 | `universal` | Telegram, **as photo** | Second platform |
| 4 | `telegram_file` | Telegram, **as file** | The max-capacity claim |

Pass = download the image back *from the platform* and decode it in Stegstr.
Never screenshot: a screenshot is a re-render and fails 100% of the time.

**Round 2, where Round 1 passed:** repeat at ~2 KB and ~3 KB to find the real
ceiling, which will be lower than the local one. For `telegram_file` go much
higher -- 10 KB, 25 KB -- since that is its purpose.

**Round 3, only if there is time:** `instagram` at step 56, feed post not
Story. If it passes, walk down the hidden bracket ladder (tick "Show
experimental test profiles"): `zz6 step 40`, `28`, `20`, stopping at the
lowest that survives. If it fails, there is no zz6 profile above 56 -- one
would need adding.

**Then, still open:**

1. The pointer tier (§10.4) -- embed a nostr event id plus a NIP-44 key,
   ~300 B, and fetch the content from a relay. Makes message size unlimited
   and the image far more invisible, at the cost of the offline property: the
   image stops being self-contained and the fetch is observable. Discussed
   this session, deliberately not built. `upload.ts` already posts to
   nostr.build if it is wanted.
2. `RELIABLE_LUMA_AC = 6` comes from one photo. 6 is where the bracket ladder
   happened to sit, not a value anything searched for.
3. Truncation only fires for a single over-long note at the head of the
   selection; a mixed feed whose last fitting event is over-long still drops
   it whole.
4. Everything from §12.5 and §13.4 is unchanged and still open.

### 14.6 Audit pass — two real bugs, one dead file

A read-through of the whole program after the session work, looking for
problems no test covers.

**The codeword length prefix overflows on large covers.** `embedQim` writes
the RS codeword length into a 2-byte big-endian prefix, so anything over
65535 wraps and the decoder reads a nonsense length. Nothing could reach that
while every profile resized to <=2048px -- but `telegram_file` (added this
session) does not resize at all. Measured budgets:

```
  universal 1600      4498 B   ok
  facebook 2048       7370 B   ok
  12MP no-resize     29489 B   ok
  48MP no-resize    112498 B   EXCEEDS the 2-byte prefix
```

48MP is an ordinary phone camera now. `getQimCapacityBytes` would have
reported ~98 KB of capacity that the framing cannot address; the self-test
would have caught the failure and the shrink loop walked down, so it would
have presented as "mysteriously cannot use the stated capacity" rather than a
corrupt image -- the same class of dishonest-number bug as §13.5. Capacity is
now capped at what the prefix can express. Raising the real ceiling means
widening the prefix, which is a format change and was not attempted.

**Identity save failure was silent.** Every `localStorage.setItem` in the app
is wrapped in `try {} catch (_) {}`, which is right for relay lists, mutes and
read timestamps -- all rebuildable. It is wrong for one: the identities key
holds the private keys, which ARE the accounts. Storage full, storage
disabled, or some private browsing modes and the user loses every identity on
the next refresh with nothing on screen suggesting anything happened. It now
logs and warns, telling them to back up the nsec while they still can.

**`usePersistedState.ts` is dead code** -- nothing imports it. It also has a
latent bug if it were adopted: `serialize` sits in the `useEffect` dependency
array, so an inline serializer would re-run the write every render. Left in
place rather than deleted, but it should not be adopted as-is.

**Checked and found clean:** `embedQim` guards oversized payloads and throws
rather than truncating; embed/detect agree on `lumaAcCount`, `rsNsym`,
`repeat` and chroma settings, resolved from the profile on both sides; every
other `localStorage` write is guarded and safely rebuildable; no `useState`
setter is declared without being called, and no state value is written
without being read (the check that found §13.3).

**186 tests passing**, `tsc --noEmit` clean, `npm run build` clean.

## 15. First real-platform pass, and a texture experiment that failed

2026-08-13. The first Round 1 upload was run, and an attempt to reduce the
visible artifact was built, measured and **rejected**. The code is back at
`99312e4`; nothing in this section is in the shipped build. It is recorded so
the same ground is not re-explored from scratch.

### 15.1 WhatsApp: PASS

`universal` -> WhatsApp (normal) -> download -> decode. **PASS.**

This is not the project's first real-platform test. The day-1 calibration
round-tripped test images through real WhatsApp, Telegram and Instagram on an
Android phone, and that is where the per-platform sizes, the delta-26 threshold
and the BER figures in §4.1 come from. What was new here is that the profile
restructure of 2026-08-12 (§14.2) -- the rebuilt `universal`, the 6-position
zigzag restriction, rsNsym 32 -- had not itself been through a platform. It has
now.

```
uploaded   254 KB   1600x1200        (app output; a later local rebuild made 254139 B)
returned   229 KB   1600x1200        IMG-20260813-WA0018.jpg
WhatsApp's re-encode:  PSNR 45.3 dB
carrier coeff drift:   p50 0.35   p90 1.01   p99 1.77   p99.9 3.95   max 6.50
```

Geometry survived exactly, as §4.1 said it would -- WhatsApp caps at 1600 and
passes anything at or below through untouched. This is the design working, not
a discovery; the 1600 width and the delta-26 threshold both come from the day-1
calibration.

### 15.2 The artifact is a single-frequency grating, and small payloads land on the ceiling

Measured on the returned image against a clean resize:

```
energy in DCT coefficient (0,1) [horizontal]:  43.0%
energy in DCT coefficient (1,0) [vertical]  :   0.8%
embedding occupies blocks 0..26046 of 30000
```

Only **zigzag position 1** is used, spread across 88% of blocks. That is
AC-major ordering working as designed -- it fills the single most survivable
frequency across every block before touching the second. The side effect is
that the perturbation is a coherent 8-pixel vertical grating, which is the
structure human vision detects best, and it is spread over nearly the whole
frame rather than concentrated.

Blocks are filled in **raster order**, so a *small* payload lands entirely in
the top rows:

```
              top third   middle   bottom
2000 blocks      20%        0%       0%
5000 blocks      50%        0%       0%
26046 blocks    100%      100%      60%
```

On the test photo the top third is the ceiling. This is the "it filled on the
ceiling only and looked bad" behaviour, and the cause is simply that block 0 is
top-left -- not anything to do with texture.

### 15.3 The texture ladder is a no-op on real photos

The headline finding of the session. `blockActivity` reads **quantized zigzag
25-40**, which at Q75 is *exactly zero for 75% of blocks* (p50=0, p75=0, p90=3).
With `ACTIVITY_EDGES = [4,12,30,70]`:

```
rung 0:  27778 blocks (92.6%)  effective delta 12.2
rung 1:   2185 blocks ( 7.3%)  effective delta 17.8
rung 2:     37 blocks ( 0.1%)  effective delta 25.6
rung 3:      0 blocks           35.6
rung 4:      0 blocks           48.9
```

Two consequences.

**The adaptation does not adapt.** It applies a near-uniform step, so the
module header's "2.0x reduction in visible perturbation" does not describe
behaviour on a real photo. That number presumably came from a synthetic or
heavily-textured image.

**`universal`'s real average step is ~12.6, not 28.** Because the ladder
normalises by its *unweighted* mean while 92.6% of blocks sit in the lowest
rung. So §15.1's WhatsApp pass was achieved at an average step of 12.6 -- less
than half the nominal 28, and well under the 26 threshold from §4.1 -- with
repeat-5 and Reed-Solomon absorbing the difference. There is far more
robustness headroom than the profile advertises. Any future capacity or
invisibility work should start from this number, not from 28.

### 15.4 What was tried and rejected

**Activity-based block SELECTION** -- choosing which blocks carry bits by
texture. Measured on the real WhatsApp round trip, activity is 98.9% stable,
but at a threshold with usable capacity 211 blocks flip sides, and the first
flip shifts every subsequent bit. It would also cut capacity ~5.5x (18% of
blocks instead of 88%). This confirms with numbers what the module header
already said; it needs wet-paper/syndrome coding to be safe. Not built.

**Mid-band texture measure** -- zigzag 10-24 instead of 25-40, to give the
ladder something to discriminate on. Built as two bracket profiles identical to
`universal` except for the measure. Result on the real photo, mean |luma
change| per pixel:

```
                        ALL      FLAT   TEXTURED
universal              2.62      1.57      2.96
universal_tex_mild     3.74      1.65      4.41
universal_tex_strong   3.65      1.28      4.41
```

`mild` made flat regions *worse*. `strong` improved flat by 19% but cost 49%
in textured areas. Judged by eye on a real screen, **both were clearly worse
than `universal`**, and the direction was abandoned on that basis. Reverted.

The reason both are louder overall is §15.3: they spread blocks properly across
rungs, so their actual average step is ~25.6 against `universal`'s ~12.6. The
comparison was never like-for-like -- it was half-strength embedding against
full-strength. An energy-matched ladder (scaled to ~12.6 average, roughly
3.1/11.9/26.3) was identified as the only fair version of the experiment and
was **not** built, since the user had already rejected the direction.

### 15.5 Two traps in the test harness

Both cost time this session and will do so again.

**`encodeQimImageFile` does NOT resize.** The app resizes first and passes
`resizedCover` (App.tsx). A test that hands it the raw camera file embeds at
full resolution -- 4096x3072 instead of 1600x1200 -- which spreads the same
payload over 4x the blocks and is far more forgiving both visually and for
decode. Always call `resizeCoverForPlatform` first.

**A synthetic cover certified a profile that fails on a real photo.** The
mid-band profile passed self-test and blind decode on `makeCoverJpeg(...)` and
failed to decode from itself on the real photo. Anything touching the stego
core must be checked against the real photo before it is believed.

Related: an unquantized texture measure is unusable, and the reason is
structural. The encoder measures the cover *before* JPEG encoding, the decoder
*after*. On raw coefficients the decoder's median mid-band energy is **0.476x**
the encoder's, so barely half the blocks agree on a rung. Quantizing first
makes it unbiased (ratio 1.000, 92% agreement). The original design quantized
for exactly this reason -- only its choice of band was wrong.

### 15.6 Where Round 1 stands

```
1  universal   -> WhatsApp, normal     PASS   (§15.1)
2  universal   -> WhatsApp, HD         not run
3  telegram_photo -> Telegram, as photo  not run (now 1920, see 15.8)
4  telegram_file -> Telegram, as file  not run
```

### 15.7 Bigger cover = quieter image, and it favours Telegram

Observed on a real screen: a Telegram-sized (larger) image looks noticeably
cleaner than the 1600px WhatsApp one at the same payload.

There is a mechanism, and it is the same one behind §15.2. Bits are laid down
one block at a time, so the fraction of the picture that gets touched depends
entirely on how many blocks the cover has:

```
1600x1200  (WhatsApp cap, universal)     30000 blocks   a 600 B payload touches  86.8%
4096x3072  (telegram_file, no resize)   196608 blocks   a 600 B payload touches  13.2%
```

Same message, same step size, 6.6x more blocks to hide it in -- so 87% of the
frame is perturbed on WhatsApp against 13% on a full-resolution Telegram file.
This was confirmed accidentally: a test run that skipped the platform resize
(§15.5) produced a 4096x3072 embed that looked clean enough to ask whether it
was embedded at all. It was, and it decoded.

The consequence is that `telegram_file` is not only the maximum-capacity
channel (§14.2) but also the most *invisible* one, and the two properties come
from the same place: no resize. Telegram-as-file is the strongest
configuration this app has on both criteria simultaneously. It is still
untested end-to-end (Round 1 test 4).

The corollary is a limit that no amount of encoder tuning removes: at 1600px
WhatsApp, a ~600 B payload simply needs most of the blocks. Reducing what is
visible there means reducing how many blocks are needed -- fewer bits (the
pointer tier, §10.4), or more bits per block -- not a quieter step.

### 15.8 telegram_photo raised to 1920

`telegram_photo` was 1600. That is **WhatsApp's** cap, not Telegram's -- it was
carried over from an earlier attempt to ship one uniform size for every
platform. `universal` already does that job, so a Telegram-only profile had no
reason to pay it.

Now 1920, which §1 records as Telegram's own cap. This helps twice for the
single reason in §15.7: 1920x1440 has 1.44x the blocks of 1600x1200, so the
same message gets 1.44x the capacity *and* is spread across 1.44x more of the
frame. More payload and a quieter picture from one change.

**Not verified end-to-end.** §1 lists "caps around 1920" as the believed limit
while 1600x1200 is the geometry actually observed returning unchanged. If
Telegram resamples at 1920 the payload is destroyed outright rather than
degraded -- that is how every geometry failure in this project has presented
(~50% BER, total loss). `telegram_photo_1600` keeps the measured configuration
as a fallback and differs from it in width alone, so a failure at 1920 can be
attributed to the geometry and nothing else.

Next Telegram upload should use `telegram_photo` at 1920 and check the returned
image is still 1920 wide before anything else.

### 15.9 Telegram outputs 1280x960 — earlier Telegram numbers are wrong

Reported after the Round 1 Telegram test: **the image that was decoded was the
one that had been sent, not the one Telegram gave back.** Telegram re-encodes
every photo to **1280x960**.

This is the single most consequential correction in this file, because it does
not just invalidate one test.

**It invalidates the Telegram PASS of 2026-08-13.** Nothing has actually been
round-tripped through Telegram-as-photo.

**It invalidates §1's Telegram row** ("caps around 1920; 1600x1200 returned
unchanged") and casts doubt on §4.1's "Telegram 1600, 0.25-0.53% BER". A true
1600 round trip through a channel that outputs 1280 would resample the grid and
measure ~50% BER, not 0.25%. The most likely explanation is that the same
mistake was made during the day-1 calibration: the sent file was inspected
rather than the returned one. Both entries are now marked in place.

**It breaks `universal`'s claim to Telegram.** `universal` is 1600, so a
Telegram photo send resamples it and the payload is lost. The note and the
picker label both promised Telegram; both now say WhatsApp, Twitter and
Facebook only, and a test asserts the claim cannot quietly return.

**And it partly retracts §15.7.** The mechanism there is sound -- a bigger
cover spreads the same payload over more blocks, so less of the frame is
touched -- but the observation that "the Telegram image looks cleaner" was
almost certainly made on the sent file too. Telegram-as-photo delivers a
*smaller* image than WhatsApp, so it is the noisiest photo channel, not the
quietest. What survives is that **telegram_file** (send as document, no
recompression) really is both the highest-capacity and most invisible channel.

Changes made: `telegram_photo` is now 1280. `telegram_photo_1600` is kept only
so old images have their geometry recorded -- it is not a fallback, Telegram
resamples it.

**The lesson, and it is the second time today (§15.5):** a result is only worth
recording if it came from the file the platform handed back. Verify the
returned image's dimensions *before* decoding anything. That single check would
have caught this on day 1 and again today.

### 15.10 Round 1 status, corrected

```
1  universal      -> WhatsApp, normal      PASS     returned image verified 1600x1200 (§15.1)
2  universal      -> WhatsApp, HD          not run
3  universal      -> Telegram, as photo    FAIL     resized by Telegram, payload destroyed (§15.11)
3b telegram_photo -> Telegram, as photo    PASS     1280 + rsNsym 32, decoded and displayed (§15.14)
4  telegram_file  -> Telegram, as file     PASS     survives because nothing is resized (§15.11)
```

### 15.11 Confirmed on a real device: resize destroys, no-resize survives

The clean experiment, both halves observed directly:

```
Telegram AS PHOTO   1600px sent -> Telegram resizes to 1280x960
                    -> decode fails: "Not a Stegstr image (magic not found)"

Telegram AS FILE    no resize at all
                    -> decodes
```

Two things are now measured rather than argued.

**Resampling is total loss, not degradation.** The failure is not a corrupted
message or a high bit error rate -- the magic bytes are not found at all,
because shifting the 8x8 grid means the decoder is reading positions that never
carried anything. This is exactly the mechanism §4.1/stego-adaptive.ts's header
describes as the cause of *every* platform failure observed in this project,
and it is the first time it has been watched happening end-to-end in the
current build. It is also why geometry matching is the highest-value thing in
this codebase: no amount of delta, Reed-Solomon or repetition can recover from
it, and there is no partial credit.

**telegram_file's PASS is genuine**, and for the stated reason: send-as-document
does not recompress, so there is no resize to survive. That makes it the only
Telegram path currently known to work, on top of already being the
highest-capacity and least visible channel (§15.7).

So Telegram-as-photo is not broken as a channel -- it was being fed the wrong
size. At 1280 the grid should pass through untouched, exactly as 1600 does on
WhatsApp. That is test 3b and it is the next thing to run.


### 15.12 Telegram-as-photo works at 1280, but is the noisiest channel

Test 3b: `telegram_photo` at 1280 was sent through Telegram, downloaded, and
**decoded**. Telegram-as-photo is a working channel; 1600 failed only because
it was the wrong size (§15.11). Geometry matching is confirmed on a second
platform.

**Open problem: image quality at 1280 is noticeably worse than WhatsApp's.**
Not a different artifact -- the same grating (§15.2) at much higher density.
Coefficient positions modified per block, for a 600 B payload:

```
WhatsApp  1600x1200  rsNsym  32     0.92 AC positions/block   (15% of budget)
Telegram  1280x960   rsNsym 128     2.51 AC positions/block   (42% of budget)
Telegram  1280x960   rsNsym  32     1.43 AC positions/block   (24% of budget)
```

Two causes multiply:

1. **Fewer blocks.** 1280x960 has 19200 blocks against 1600x1200's 30000, so
   the same message is 1.56x denser. This is §15.7's mechanism running the
   wrong way, and it is inherent to the channel -- Telegram will not give more
   pixels.
2. **`telegram_photo` never had rsNsym set.** It still falls through to the
   QIM default of 128, spending half of every codeword on parity, while
   `universal` uses 32. That is 1.75x more coded bytes for the same message.

Together, 2.7x the per-block perturbation of the WhatsApp path. At 2.51
positions per block every block carries zigzag 1 AND 2, with half also
carrying 3 -- against universal, where most blocks carry only zigzag 1.

**Tomorrow, in order of value:**

1. **Set `rsNsym: 32` and `lumaAcCount: 6` on `telegram_photo`**, matching
   `universal`. Drops it to 1.43 positions/block, a 43% cut, and raises usable
   capacity from ~1.4 KB to ~2.4 KB at the same time. Deliberately not done in
   the same change that established the geometry -- error-correction strength
   should not move while a geometry result is being confirmed. Needs one
   upload to re-verify, since 32 gives RS 16 repairable bytes per 255 instead
   of 64.
2. **Measure what Telegram's re-encode actually costs**, the way §15.1 did for
   WhatsApp (PSNR and carrier drift from the returned file). WhatsApp's drift
   was tiny -- p99.9 of 3.95 -- and if Telegram's is similar there may be room
   to lower delta below 28 for this profile specifically, which reduces the
   artifact directly. Requires the returned file, not the sent one.
3. **Send less.** At 1280 the payload is the dominant term, and no encoder
   tuning beats not sending the bytes. This is the pointer tier (§10.4): embed
   a nostr event id plus a NIP-44 key, ~300 B, and fetch the content from a
   relay. At 300 B with rsNsym 32 the profile would need well under one AC
   position per block -- quieter than WhatsApp is today.

Note the honest ceiling: even fixed, Telegram-as-photo will stay noisier than
WhatsApp at equal payload, because it has 36% fewer blocks to hide in.
`telegram_file` remains the channel to use when quality or capacity matters.

### 15.13 telegram_photo takes rsNsym 32 — and the trap that came with it

`telegram_photo` now carries `rsNsym: 32` and `lumaAcCount: 6`, matching
`universal`. Measured on the real photo at 1280x960:

```
capacity   1423 B -> 2483 B          (+74%)
density    2.51 -> 1.43 AC positions modified per block, for a 600 B payload
blind decode after the change: PASS
```

**Setting rsNsym alone would have broken the profile silently.**
`decodeQimImageFile` guesses an unknown image's settings in three phases, and
the final phase passes **only `delta`** -- not rsNsym, not lumaAcCount. The
phase that passes whole bundles was filtered on `lumaAcCount !== undefined`,
and `telegram_photo` had no lumaAcCount. So it would have embedded at rsNsym 32
and been blind-decoded at the default 128: never decodable.

What makes this nasty is that **`qimSelfTest` would still have passed**, because
the self-test knows which profile it is using. The image would download
happily, look fine, and fail only when somebody tried to read it back --
exactly the shape of §13's "self-test passed but the file was undecodable"
family of bugs.

Two changes close it:

1. The sweep filter now also matches a non-default `rsNsym` on its own, so any
   profile whose decode needs a setting phase 3 does not carry gets tried as a
   complete bundle.
2. A test asserts the invariant directly: every profile with a non-default
   `rsNsym` or `lumaAcCount` must be reachable by the sweep. It mirrors the
   filter, so narrowing that filter fails the test.

**Still to verify on a device:** rsNsym 32 gives Reed-Solomon 16 repairable
bytes per 255 instead of 64. `universal` uses 32 and survived WhatsApp, and
Telegram-as-photo's own re-encode has not been measured yet (§15.12 item 2),
so this needs one Telegram upload to confirm before it can be called settled.

### 15.14 Telegram 1280 confirmed end-to-end — and a note you hold but cannot see

`telegram_photo` at 1280 with rsNsym 32 was sent through Telegram, downloaded
and decoded. Verified independently by decoding the returned file here: 2040
bytes of ciphertext, one kind-1 event, magic and RS intact. **Telegram-as-photo
is a working channel**, and the rsNsym 32 change survives it.

The decode surfaced a separate app bug. The review said "0 new items, 1 already
had -- nothing new to add", while the feed showed nothing at all.

**Root cause: `importedEventIds` was never persisted.** `events` is saved to
localStorage; that set was rebuilt empty on every load. But the feed filter
that depends on it is permanent:

```js
if (ourPubkeysSet.has(note.pubkey) && !viewingPubkeys.has(note.pubkey)
    && !importedEventIds.has(note.id)) return false;
```

A note authored by one of your own identities is hidden unless you are viewing
as that identity or it was imported. So an imported self-authored note was
visible until the next reload and invisible after it -- while still sitting in
`events`, so re-importing the same image classified it as a duplicate and
offered nothing to do. The note was in the user's data and unreachable by any
action available to them.

Two fixes, because either alone leaves a hole:

1. **Persist `importedEventIds`** (`stegstr_imported_event_ids`, per profile).
   Removes the reload cliff.
2. **A held-but-hidden event is no longer classified as a duplicate.** Presence
   is not the same as visibility; accepting it re-adds the id and makes it
   appear. Without this, anyone whose set was already lost stays stuck.

The rule is now `isLocallyHidden()` in `utils.ts` rather than an inline
predicate, with tests -- including one asserting that a hidden event is not a
duplicate, which is the bug itself stated as an invariant.

**Confirmed fixed on the device:** the same Telegram image that previously
reported "nothing new to add" against an empty feed now shows the note and
adds it.

This is the **fourth** bug in the same family (§13.3, §13.6, §14.3): the merge
succeeds, the report says so, and the item does not appear, because display is
gated by a rule the report does not consult. The lesson each time is the same
-- report what the user will SEE, not what the code did.

### 15.15 Next session — start here

Supersedes §14.5, whose Round 1 matrix is now done (§15.10).

**State:** three channels verified end-to-end, each against the file the
platform handed back. 194 tests, `tsc` and `npm run build` clean, all pushed.

```
WhatsApp   universal       1600x1200   PASS
Telegram   telegram_file   no resize   PASS    best on capacity AND invisibility
Telegram   telegram_photo  1280x960    PASS    rsNsym 32
Instagram  instagram       1440 square untested since being demoted (§14.2)
```

**1. Measure what Telegram's re-encode actually costs.** The one piece of
per-channel data still missing, and it gates every tuning decision for
Telegram-as-photo. Repeat §15.1's analysis on a returned Telegram file: PSNR
against what was uploaded, and carrier-coefficient drift percentiles. WhatsApp's
came out at 45.3 dB with p99.9 drift of 3.95 against an embedding displacement
of ~19 -- if Telegram's is comparable, delta 28 is more than that channel needs
and can come down, which reduces the artifact directly. Needs the returned
file, not the sent one ([[check-the-returned-file]]).

**2. The pointer tier (§10.4). — DECIDED: this is where the next session
starts.** At 1280x960 the payload size dominates
everything else, and no encoder tuning beats not sending the bytes. Embed a
nostr event id plus a NIP-44 key (~300 B) and fetch the content from a relay.
At 300 B with rsNsym 32, Telegram-as-photo would need well under one AC
position per block -- quieter than WhatsApp is today. Costs the offline
property: the image stops being self-contained and the fetch is observable.
`upload.ts` already posts to nostr.build. Discussed repeatedly, never built;
it is now the highest-value remaining idea.

**3. Round 2: payload ceilings.** Only ~600 B has ever been sent through a real
platform. Find where each channel actually breaks: ~2 KB and ~3 KB on
`universal`, and much higher on `telegram_file` (10 KB, 25 KB) since that is
its purpose. Capacity numbers in the UI are still encoder estimates, not
measured limits.

**4. WhatsApp HD** (Round 1 test 2) is still unrun -- it decides whether
merging the two WhatsApp entries was right.

**Open, lower priority:** `RELIABLE_LUMA_AC = 6` comes from one photo (§14.5);
truncation only fires for a single over-long note at the head of the selection;
`usePersistedState.ts` is dead code with a latent effect-deps bug (§14.6).

**Two standing rules earned the hard way today:**

- Check the returned image's **dimensions before decoding anything**. A false
  PASS from decoding the sent file cost a day and had corrupted the day-1
  record too (§15.9).
- Anything touching the stego core must be verified against the **real photo**,
  not a synthetic cover -- a synthetic cover certified a profile that could not
  decode itself on a real one (§15.5).

---

## 16. The pointer tier is built (§15.15 item 2)

Supersedes §15.15's item 2. Items 1, 3 and 4 there are untouched and still open.

**206 tests passing**, `tsc --noEmit` clean, `npm run build` clean. Not yet
phone-tested -- see §16.5, which is the whole of what remains.

### 16.1 What it does

Publish the feed to a relay as an encrypted blob; embed only a pointer to it.
Measured, not estimated: **264 bytes** in the image, with three relay hints,
regardless of how large the feed is. A 40-note bundle is ~16 KB, so this is
roughly a 60x reduction in what has to survive the channel.

For scale against the tightest verified channel: `telegram_photo` at 1280x960
has a measured capacity of **2483 bytes**, so a pointer occupies about **11%**
of it. That is the payload half of the delta x payload product this project has
been fighting since §10.4.

### 16.2 Files

| File | Status | What |
|---|---|---|
| `src/pointer.ts` | **new** | Pointer format, `buildPointer`, `parsePointer`, `resolvePointer`, `PointerUnresolved`. All the reasoning is in the header comment |
| `src/net-adapter.ts` | modified | `publishAndConfirm` (publish and wait for relay ACKs) and `fetchEventById` (one-shot fetch by id) |
| `src/App.tsx` | modified | Pointer branch in the QIM embed path; `followPointerIfAny` in both detect paths |
| `src/EmbedModal.tsx` | modified | "Send a link instead of the content" toggle, stating the tradeoff both ways |
| `src/__tests__/pointer.test.ts` | **new** | 11 tests: round-trip, size ceiling, recipients, failure messages |
| `src/__tests__/pointer-embed.test.ts` | **new** | Pointer through the real shipped encoder on `telegram_photo`, byte-identical read-back, resolve back to the bundle |

### 16.3 Design decisions worth knowing before changing anything

- **Blob kind is 30078** (NIP-78 app-specific data), with a random `d` tag so
  blobs never replace one another under addressable-event semantics. Chosen
  over a bespoke kind because relays that implement NIP-78 store it with no
  special configuration, and an event a relay silently drops is a broken
  feature regardless of how clean the number is.
- **Open mode uses a fresh random key carried in the pointer.** The app key is
  derived from a constant salt, so it is obfuscation, not secrecy -- fine for
  an image, useless for a blob sitting on a public relay. There is a test
  asserting the app key does *not* open the blob.
- **Recipients mode encrypts the blob per recipient and carries no key.** The
  alternative -- wrapping the pointer itself per recipient -- would add ~100
  bytes per recipient to the one part that has to survive the channel, which is
  the most expensive place in the system to spend a byte.
- **Publish happens before encode, and a total publish failure aborts the
  embed.** A pointer to an event no relay holds produces an image that decodes
  perfectly and yields nothing: every stego-side indicator reads success. That
  is the worst failure mode available here, so it is checked up front.
- **Pointer mode bypasses the packing and binary-search machinery entirely.**
  Two reasons. The embedded payload is fixed-size, so searching over event
  count answers a question that no longer exists; and re-encrypting per attempt
  would mint a *new* blob event each time, leaving the image pointing at an id
  that was never published. This is why the branch sits before `encryptAndFit`
  rather than inside it.
- **`fetchEventById` deliberately skips the shared dedupe.** `outbox.markSeen`
  returns false for anything already seen in the feed, so routing a one-shot
  fetch through it would time out on content we demonstrably have.
- **Resolution failure is not a decode failure.** `PointerUnresolved` carries
  its own message and the detect path is careful not to dress it up as "not a
  Stegstr image" -- that sends the user off to re-shoot a photo, which cannot
  possibly help when the truth is "the relay has not got it yet".

### 16.4 What it costs

Stated plainly because the UI states it plainly, and the README should too:

- **The image is no longer self-contained.** No relay, no content -- where a
  self-contained image works offline forever.
- **The fetch is observable.** Anyone watching the recipient's relay traffic
  sees a request for a specific event id at a specific time. That is a metadata
  leak the self-contained mode does not have.

Hence a per-embed toggle, defaulting **off**. Self-contained is the property
that makes a stego image worth sending; pointer mode trades it for quietness,
and that is the user's call per image, not a global setting.

### 16.5 Not yet verified -- read this before claiming it works

**Nothing here has been through a real platform.** The end-to-end test uses a
synthetic cover and the simulated channel, and §15.5 is exactly the record of a
synthetic cover certifying a profile that could not decode itself on a real
photo. What the tests prove is that the plumbing holds: the bytes embedded are
the bytes recovered, and the pointer resolves back to the original bundle.

The phone test that would settle it, in order:

1. Embed with pointer mode on, target `telegram_photo`, using a **real photo**.
2. Send through Telegram as a photo. Check the returned file's **dimensions
   before decoding anything** (§15.9 -- a false PASS from decoding the sent
   file cost a day).
3. Load the return into Detect on a device that can reach relays, and confirm
   the review modal lists the notes.
4. Compare the artifact by eye against the same cover carrying a full payload.
   The expected win is visible, not subtle: ~11% of capacity instead of ~100%.

Also unverified: whether the four default relays actually accept kind 30078.
`publishAndConfirm` reports which relays took it and the embed aborts if none
did, so this fails loudly rather than silently -- but it has not been run
against a live relay even once.

### 16.6 Remaining work, in order

1. **Phone-test the pointer tier** (§16.5) -- the only thing standing between
   this and being a claim worth making
2. Measure what Telegram's re-encode costs (§15.15 item 1) -- still the missing
   per-channel number, and it gates whether delta 28 can come down
3. Round 2: payload ceilings (§15.15 item 3) -- note pointer mode makes this
   less urgent for the tight channels, and no less urgent for `telegram_file`
4. WhatsApp HD (§15.15 item 4)
5. README with the measurement tables
6. NIP-44 into `stego-crypto.ts` (needs a version byte for old images)
7. Rust matched-table encoder -- would not help Instagram (§10.3)
8. MCP server
9. Audio

### 16.7 Relay capability: kind 30078 verified live

Run 2026-08-14 against the four default relays, publishing a real throwaway
event and reading it back **by id** from the same socket. An OK only says the
relay accepted it; being served back is the half the tier actually needs, so
both were checked.

```
wss://relay.primal.net    kind 30078: accepted + served back
wss://relay.damus.io      kind 30078: accepted + served back   (connected on retry)
wss://nos.lol             kind 30078: accepted + served back
wss://relay.nostr.band    UNREACHABLE from this network - no verdict
```

**3/3 reachable relays store and serve kind 30078.** The NIP-78 assumption in
§16.3 holds; the tier is not resting on a kind that relays quietly drop.

Two things this run surfaced that are worth carrying forward:

- **A first pass reported two "socket errors" and it was a false negative.**
  `relay.damus.io` connects intermittently from here -- 2 of 3 bare connection
  attempts succeeded -- so a single failed attempt looks identical to a
  rejection while meaning something completely different. Any relay check must
  retry the connection and report "unreachable" separately from "rejected",
  or it will invent relay problems that do not exist. `relay.nostr.band` fails
  consistently and its plain HTTPS also fails from this network, so that one is
  probably a local routing issue rather than an outage -- but it is untested
  from anywhere else, so treat it as unknown, not as broken.
- **The kind 1 control got no OK from any of the three relays**, while kind
  30078 on the same socket got one immediately. That is the opposite of what
  spam-filtering intuition predicts and it is unexplained. It does not affect
  the 30078 result, which stands on direct evidence, but kind 1 is the app's
  ordinary posting path and "publishes a note, relay never acknowledges" is
  exactly the shape of bug the Outbox was built to paper over. **Worth an
  hour before the README claims anything about publishing reliability.**
  Caveat before chasing it: the test pubkey was brand new with no kind 0 or
  kind 3, which is not how a real user's first post looks.

---

## 17. Pointer tier verified on Telegram, and Telegram's re-encode measured

Round 1 of the pointer tier, 2026-08-14, on a real Android phone.

### 17.1 It works

`telegram_photo` + pointer mode -> Telegram as photo -> return -> Detect ->
review modal lists the notes. **PASS.** Geometry survived exactly: 1280x960
uploaded, 1280x960 returned, both with and without pointer mode. Returns are
progressive JPEGs where the sent files were baseline, which confirms Telegram
genuinely re-encoded rather than passing the file through.

The pointer carried a **3921 B bundle through a cover with 2483 B of
capacity** -- self-contained mode could not have sent that feed at all without
dropping events. That result stands independently of how the image looks.

### 17.2 Telegram's re-encode cost (closes §15.15 item 1)

```
                     PSNR     carrier (0,1) drift, raw DCT units
Telegram photo      52.0 dB   p50 0.31  p90 1.09  p99 2.46  p99.9 3.89  max 6.17
WhatsApp (§15.1)    45.3 dB   p50 0.35  p90 1.01  p99 1.77  p99.9 3.95  max 6.50
```

**Telegram is gentler on PSNR but identical on the carrier** -- p99.9 drift 3.89
against WhatsApp's 3.95. The two channels cost the same where it matters, which
is the coefficient the payload actually lives in.

Headroom for lowering delta, stated both ways because §15.3 makes it ambiguous:
against nominal delta 28 (margin 14) the drift is 28% of margin; against
§15.3's measured *effective* ~12.6 (margin 6.3) it is 62%. The second is the
honest one. Delta can come down, but modestly -- 28 to ~20, not 28 to 14.

Repeatable via `calibration/analyze_pointer_pair.py SENT RETURNED`.

### 17.3 Why a 60x smaller payload is only slightly less visible

Exact slot usage, computed from the shipped constants at 1280x960:

| | slots used | AC positions | blocks touched | coeffs/block |
|---|---|---|---|---|
| pointer 264 B | 13,960 (**12.1%**) | **1 of 6** | **72.7%** | 1.00 |
| full 2483 B | 115,520 (100%) | 6 of 6 | 100% | 6.02 |

`buildCoeffStream` is AC-major: it fills zigzag 1 across *every block* before
touching zigzag 2. So a small payload modifies 8.3x fewer coefficients and
still covers 73% of the frame -- and puts **100% of its perturbation into
zigzag position 1**, which §15.2 measured as the coherent 8-pixel grating human
vision detects best. The full payload at least dilutes across zigzag 1-6.

**The pointer tier delivers the saving; the slot ordering spends it in the
worst available place.** That is the whole explanation for "I expected a huge
difference and got a small one".

A warning about measuring this: diffing the two *sent* images against each
other does not work. It measures the union of both payloads and is dominated by
the larger one, which produced a meaningless "92% of blocks differ". The table
above comes from the encoder's own arithmetic, not from image comparison.

### 17.4 The three currencies, and the trap in spending them

At 12% occupancy the saving can be spent three ways, and they are not
equivalent:

| lever | visibility | robustness |
|---|---|---|
| delta down | better | worse |
| spread across zigzag 1-6 | better | **worse** |
| repeat up | unchanged | better |

Spreading is **not free**, contrary to how it first looks. Within zigzag 1-6
lower is more survivable (§10.4 option 2 -- sharpening hits high frequencies
hardest, which is why `lumaAcCount` was cut to 6). A pointer currently sits
entirely on zigzag 1, the single most robust coefficient available. Moving bits
to 2-6 buys invisibility with robustness.

Repetition is the one lever that is genuinely affordable here: `repeat` 5 to 15
still uses only ~36% of capacity. So the safe combination is **spread the
frequencies and raise repeat to pay for it, leaving delta alone.**

Two constraints on any of it:

- **Delta is per-profile.** `universal` (WhatsApp) and `telegram_photo` are
  separate entries, so Telegram tuning cannot regress the WhatsApp pass. Do not
  touch `universal` without a WhatsApp round trip of its own -- it is the only
  confirmed pass on the platform the holder tests first.
- **Changing slot ordering changes the decoder.** Images made by the current
  build stop decoding unless the ordering is tied to the profile or a version
  byte. Decide that before writing code, not after a returned file fails.

### 17.5 Priority review at T-24h — read this before writing any more encoder code

Written 2026-08-14 with roughly 24 hours left, after a session that had drifted
into encoder research. Recording the reasoning because the drift was not
obvious from inside it.

**What the contest is judged on** (§1): invisibility, survival through
WhatsApp/Telegram/Instagram, networking reliability. Plus agent operability and
"more platforms is better". The holder runs submissions himself and there is no
defined test procedure.

**What is done:** WhatsApp PASS, Telegram-as-file PASS, Telegram-as-photo PASS,
pointer tier built and phone-verified, kind 30078 verified on live relays, 209
tests, `tsc` and build clean.

**What is not done, and is worth more than any remaining encoder work:**

1. **The release workflow has never been triggered on this fork.** It has been
   in the "do this early" position of §2 since the first version of this
   document and is still undone. Upstream's `release.yml` builds macOS
   (Intel + Apple Silicon), Windows and Linux. The holder said *"Mac, PC, more
   is better."* The cost is a `git tag` and a push. **Highest value per minute
   available, by a wide margin, and it needs lead time for CI to fail and be
   fixed.**
2. **The README still has no measurement tables.** 61 lines, zero measured
   numbers. §1 identified this as where a submission "sets the terms of
   comparison" against 34 entries, and it is the only artefact that makes the
   channel work legible to someone who will not read the code.
3. **Instagram ships a profile that has not been verified since §14.2.** The
   brief names Instagram as one of three platforms. Shipping a default that
   silently fails is worse than documenting it as unsupported with the §10.3
   explanation, which is a genuinely interesting finding in its own right.

**Why the AC-spreading change (§17.4) is the wrong thing to build now.** It
touches the stego core, so §15.5 requires verifying it against a real photo,
which means another phone round trip. It breaks decode compatibility unless
versioned first. It moves bits off the most robust coefficient available. And
it risks a working PASS on the one channel measured today. Expected value at
T-24h is negative -- not because the idea is wrong (it is the best remaining
encoder idea) but because it cannot be validated in the time left.

**Suggested order for the remaining time:**

1. Tag and trigger the release build. Do it first; it runs while you do
   everything else, and CI failures need slack to fix.
2. The kind-5 embed fix (§17.6) -- small, specified, and stops the app showing
   a judge content the user deleted.
3. README with the measurement tables from §15, §16 and §17.
4. Decide Instagram: re-verify, or document as unsupported and remove it from
   the default choices.
5. Only with time genuinely spare: §17.4, on `telegram_photo` only.

### 17.6 §17.4 built: spread slot ordering on telegram_photo

**213 tests**, `tsc` and build clean. `telegram_photo` now ships
`slotOrder: "spread", repeat: 15`. Nothing else changed profile.

**A latent bug found while building it, and this one matters beyond §17.4.**
`embedQim` did not use the stream `buildCoeffStream` returned. It recomputed
the position inline as `zi * blocksPerPlane + br * blocksX + bc` -- the
AC-major formula, hardcoded -- and used the stream only to decide which blocks
to touch. `detectQim` *does* iterate the stream. So the two agreed only as long
as the ordering happened to be AC-major, and any change to `buildCoeffStream`
would have been silently ignored on the embed side while the detector honoured
it. First symptom was spread failing its own round trip at every repeat value.

Embedding now derives an explicit inverse map from the stream, so the two sides
cannot disagree again. **Anyone touching slot ordering should know this trap
existed**: the encoder looked like it was driven by `buildCoeffStream` and was
not.

**Compatibility.** Ordering is not recoverable from a file -- a wrong order
reads the right coefficients in the wrong sequence and fails exactly like a
wrong delta. The blind sweep therefore tries both orderings for every
zigzag-restricted profile, and a test asserts an ac-major image still decodes
now that the profile declares spread. Cost is one extra detect attempt per
profile in that phase.

**Capacity.** `getQimCapacityForFile` now passes `repeat` from the profile. It
did not before, so with repeat 15 it would have quoted the repeat-5 figure and
overstated capacity 3x -- the packer would fill to a budget the encoder cannot
carry and fail after the work was done. telegram_photo capacity is now
**819 B** (was 2483 B at repeat 5), which still comfortably holds a 264 B
pointer at ~32%.

**What is verified and what is not.** Verified: round trip through the real
shipped encoder, old-image compatibility, and that the mapping is a bijection
covering every slot exactly once. The distribution claim is verified directly
on the mapping -- for a 13,960-slot payload, ac-major uses 1 of 6 frequencies
and 73% of block rows; spread uses 6 of 6 and 100% of rows, at the same one
coefficient per block.

**NOT verified: that it looks better, or that it survives Telegram.** Both need
a phone round trip on a real photo (§15.5). Until then this is a change that
passes CI, not a result. The comparison to shoot is the same cover, pointer
mode on, `telegram_photo`, against the returned file from §17.1 -- which is
already on disk and was made with ac-major, so it is a like-for-like control.

### 17.7 Round 2 came back WORSE, and why — repetition is not free

Phone test of §17.6 (spread + repeat 15) on the same cover: **visibly worse
than round 1**. The channel was not the cause -- PSNR 52.0 dB and p99.9 carrier
drift 4.04 against round 1's 52.0 dB and 3.89, i.e. identical. The image itself
was noisier before it was ever sent.

**Cause: `repeat` 5 -> 15 tripled the number of modified coefficients.**

```
round 1  repeat 5 :  13,960 coefficients modified  (12.1% of slots)
round 2  repeat 15:  41,880 coefficients modified  (36.4% of slots)
```

§17.4's table claimed "repeat up: visibility unchanged". **That is wrong and
the table has been corrected.** Repetition spends two things, not one: capacity
*and* perturbation, one modified coefficient per copy. Capacity was the
abundant resource; visible perturbation was the scarce one, and they were
treated as the same.

The premise was weak anyway. Q75 quantization steps across zigzag 1-6 are
**6, 6, 7, 7, 5, 8** -- flat. So spreading from zigzag 1 into 2-6 changes
neither the amplitude of a delta-28 step nor, by much, its survivability, which
means there was little for the extra repetition to buy.

**Also a bad experiment.** Round 2 changed the ordering AND the repeat, so it
cannot say which one hurt -- the same mistake as diffing the two sent images in
§17.3. One variable at a time.

**Corrected table (replaces the one in §17.4):**

| lever | visibility | robustness |
|---|---|---|
| delta down | better | worse |
| spread across zigzag 1-6 | better (untested) | slightly worse |
| repeat up | **worse, 1 coefficient per copy** | better |

**Current state:** `telegram_photo` is `slotOrder: "spread"` with repeat back at
the default 5, so the next test isolates the ordering change against round 1's
ac-major return, which is on disk and used the same cover and payload size. A
test pins `repeat` as unset so raising it again has to be deliberate.

If round 3 is still no better than round 1, the honest conclusion is that slot
ordering is not where the visibility win lives at this delta, and the remaining
lever is delta itself (§17.2 measured the headroom: 28 to ~20).

### 17.8 Pointer resolve ignored the Network toggle — privacy bug, fixed

Found by opening a pointer image with **Network OFF** and watching it decode
anyway.

`followPointerIfAny` called `fetchEventById` with no gate. Every other network
path in `App.tsx` is guarded by `networkEnabled` -- more than twenty call sites
-- and this one was not, because it was added with the pointer tier and the
guard was never carried over. `RelayPool` has no knowledge of the app-level
toggle, so the sockets opened and the blob was fetched.

The banner in that state reads *"No internet -- local only. Detect & Embed stay
in your browser; nothing is sent."* For pointer images it was false.

**Why this is more than a wrong switch.** The fetch names the exact event id
being read. So opening a hidden image told four relays which payload someone
had just opened, and roughly when -- in an application whose entire premise is
that nobody can tell. A user who deliberately turned the network off to read
something quietly got the opposite of what the UI promised.

Detect now refuses a pointer with the network off and says why, including that
turning it on is itself observable:

> This image holds a link to content on a relay, and Network is off. Turn
> Network on to fetch it -- note that doing so tells the relay which image you
> are reading.

**Generalisation worth acting on:** the embed side had this guard from the
start (§17 pointer branch), the detect side did not. Any new capability that
reaches the network needs the `networkEnabled` check on *both* sides, and the
absence of one is not visible in tests -- nothing in the suite exercises the
toggle. That is a gap: a test that asserts no socket is opened while the toggle
is off would have caught this immediately.

### 17.9 "You already have everything" after deleting — stale closure, not pointer mode

Reported as a pointer-mode bug: delete a note, decode a pointer image
containing it, and the review says *"Nothing new to add -- you already have
everything this image contained"*, while the same test without pointer mode
correctly offered the note.

**It is not pointer-specific.** Both images were decoded and compared directly:
each contained exactly one event, kind 1, id `c2a05d0618c29159…` -- the same
event. The payloads were identical, so the difference had to be in
classification, and it was.

**Cause: `handleLoadFromImage` reads `events` about thirty times, plus
`importedEventIds`, `selfPubkeys`, `ourPubkeysSet` and `contactsSet`, and none
of them were in its `useCallback` dependency array** -- only `viewingPubkeys`
was. The handler therefore classified against whatever feed existed the last
time a listed dep changed.

Deleting a note writes a kind-5 tombstone into `events`, and `tombstonedIds` is
precisely what tells the classifier the note is no longer held. A stale closure
cannot see the tombstone, so the note stays "duplicate".

**Why it looked like pointer mode:** `networkEnabled` *is* a dep (added in
§17.8). Toggling Network refreshes the closure, so any decode after a toggle
classified correctly. The non-pointer test happened to follow a toggle.

Fixed with a `detectStateRef` refreshed every render, destructured at the top of
the handler so all thirty-odd reads see live state. A ref rather than a
corrected dep list because `handleLoadFromImage` is the identity a Tauri
drag-drop listener is registered against; adding `events` would tear down and
re-register that listener on every feed change.

**Method note worth keeping.** The decisive step was decoding both images and
printing their contents, which took minutes and ended the speculation
immediately. Two rounds of reasoning about *why pointer mode might differ*
produced nothing, because the premise -- that the payloads differed -- was never
checked. Check what is actually in the file before theorising about why two
paths disagree.

### 17.10 Also fixed in the same pass

- **Deletions are no longer embedded.** `embedCandidates` now excludes kind 5
  and anything tombstoned by one of your own kind-5 events. A tombstone is
  ~380 bytes of pure overhead with no content, so `packForCapacity` scored it
  at ~2.3x the density of a real note and sorted it to the FRONT of the
  selection; the orphan-reply rule then pulled the deleted note in with it,
  because a tombstone's `["e", id]` tag looks like a reply. On a tight cover
  the image preferentially carried a note you deleted plus the tombstone that
  deleted it, crowding out the note actually in your feed.
- **`kindLabel` knows kind 5** ("deletion"), so a tombstone from an older image
  reads as something rather than `kind 5`.
- **The "Add to my feed" button is hidden when nothing is eligible.** It was
  offered alongside "Nothing new to add", where clicking it did nothing --
  which reads as the app being broken rather than as "no new content".

### 17.11 Instagram: same encoder output, opposite results — and the pass-through lead

Two Instagram round trips an hour apart, same cover, same profile, same
delta 56, same pointer mode:

```
sent 18:48  ->  PSNR 41.0 dB   carrier drift p50 2.05   p99.9 13.86 (49.5% of margin)   PASS
sent 19:48  ->  PSNR 32.0 dB   carrier drift p50 16.73  p99.9 149.95 (535% of margin)   DESTROYED
```

**The encoder output was identical.** Both sent files were measured against a
clean, unembedded 1440x1440 render of the same original photo:

| | PSNR vs clean | zigzag1 mean abs delta | p50 | blocks touched | total perturbation |
|---|---|---|---|---|---|
| 18:48 (passed) | 33.9 dB | 18.46 | 4.51 | 19,489 (60.2%) | 994,272 |
| 19:48 (failed) | 33.9 dB | 18.54 | 4.52 | 19,498 (60.2%) | 996,084 |

0.18% apart, which is just different random payload bits. The slot-ordering
feature added between the two runs did **not** change ac-major encoding. The
hypothesis that a code change caused the failure was tested and is false.

Incidentally this confirms §17.3's model from the other direction: 60.2% of
blocks touched matches the "covered about 60% from the top" observation by eye.
`spread` touches only 34.2% at zigzag 1 but carries 3.7% MORE total
perturbation across zigzag 1-6.

**Delta cannot fix this.** Surviving the bad session needs `delta/2 > 150`, so
delta > 300 against the 56 that already shows a visible crosshatch on flat
areas (§10.4). Instagram's bad-session processing is not survivable at any step
size that remains steganographic. §14.2's demotion was correct.

**Do not over-read the "second hop passed" result.** Re-uploading an
already-returned Instagram file passed twice, but those files carry Instagram's
own quantization table and progressive encoding, so there is little left for
the pipeline to change. A 2nd hop on Instagram's own output is an easy input,
not evidence the 1st hop is reliable.

### 17.12 Lead for the next improvement pass: mimic Instagram's own output

**Idea:** encode Stegstr's Instagram output to look like an Instagram return --
their measured luma quantization table (min 5, max 25, mean 15.84; chroma table
equals luma) and progressive scan -- on the theory that Instagram reprocesses
such an image lightly, which is what the 2nd-hop results hint at.

**Blocked in the browser.** `canvas.convertToBlob({quality})` accepts a quality
number only: no custom quantization table, no progressive flag (§6). Needs the
Rust `jpeg-encoder` path or a WASM mozjpeg build, plus a phone test. Several
hours, not a deadline-week item.

**Two caveats to weigh before building it:**

- The 2nd-hop evidence is confounded. Those files had been through Instagram's
  *whole* pipeline -- resample, sharpen, re-encode. Matching the quantization
  table and progressive flag copies only the final step, not the ones that did
  the damage. A fresh upload may be resampled regardless of how it is encoded.
- §10.3 measured Instagram's damage as **sharpening, not quantization**, which
  is why matched tables were set aside for Instagram in the first place. This
  lead does not overturn that; it proposes a different mechanism
  (format-based pass-through) that has not been tested.

**Cheapest test before any of it:** re-upload a failing sent file unchanged. If
it passes on retry, Instagram is simply non-deterministic and no encoding work
would have helped.

### 17.13 Instagram has two processing modes, and retry works

The re-upload test from §17.11 was run: the *sent* files that Instagram
destroyed at 20:15 were uploaded again unchanged at 21:26. **Both survived.**
Identified by pointer event id, so there is no ambiguity about which file is
which.

Five Instagram round trips of the same cover, same profile, delta 56:

| sent | returned | PSNR | carrier p99.9 | % of delta/2 margin | result |
|---|---|---|---|---|---|
| 18:48 | 19:05 | 41.0 dB | 13.86 | 49.5% | PASS |
| 19:48 ac-major | 20:15 | 32.0 dB | 149.95 | 535% | FAIL |
| 19:48 spread | 20:16 | 31.9 dB | 115.90 | 414% | FAIL |
| 19:48 ac-major (same file) | 21:26 | 41.0 dB | 13.42 | 47.9% | PASS |
| 19:48 spread (same file) | 21:26 | 40.7 dB | 13.74 | 49.1% | PASS |

**Light mode clusters at 40.7-41.0 dB; heavy mode at 31.9-32.0 dB. Nothing in
between.** Two server-side pipelines. Which one an upload gets is not a
property of the file -- byte-identical uploads went through both.

Three conclusions:

- **Instagram is non-deterministic and retry works.** The honest claim is
  "survives Instagram, 3 of 5 attempts in testing; retry on failure", not
  "unsupported". §17.11's lean toward documenting it as broken was wrong, and
  the user's instinct that a third attempt would pass was right.
- **Even light mode is marginal.** 47.9%, 49.1%, 49.5% of the decision margin
  -- half the budget gone on a *good* day, with nothing left for a bad one.
  That is why heavy mode is not a near miss but total destruction.
- **`spread` buys no robustness.** Light mode 47.9% vs 49.1% is a wash; heavy
  mode destroys both. Any case for spread is visual only.

**Method note.** Three files arrived as `.jfif`, so a `*.jpg -o *.jpeg` search
missed them entirely and reported "nothing new". Instagram and browsers hand
back that extension routinely -- search by content or use a wider glob.

**Still unknown: what triggers heavy mode.** Not the file. Not the ordering.
Candidates never isolated: single vs multi-image post, time of day, server-side
A/B, account state. Worth one controlled hour if Instagram matters; the
practical mitigation (retry) already works without knowing.
