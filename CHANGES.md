# What this fork changes

Against upstream `brunkstr/Stegstr` at fork point: **79 commits, 233 files,
+21,311 / −875 lines.** 343 tests, `tsc --noEmit` clean, `npm run build` clean.

The organising claim: **an image only carries hidden data through a chat app if
the encoder is matched to what that specific app does to photos.** Everything
below follows from measuring that rather than assuming it.

---

## 1. Survival through platform processing

### The single rule everything rests on

> Match the platform's native output geometry and the 8×8 DCT block grid
> survives. Fail to, and the payload is destroyed completely.

Resampling changes the spacing of the block grid, so the decoder samples across
block boundaries and reads noise. Every catastrophic failure observed measured
~50% bit error — pure chance — and every one came from a geometry mismatch.

### Geometry, measured on a real phone

| Platform | Measured behaviour | Ships as |
|---|---|---|
| **WhatsApp, HD send** | **carries 4096×3072 intact** | **4096 long edge** |
| **X/Twitter** | **keeps dimensions to a 4096 long edge; file size drops, the pixel grid does not** | **4096 long edge** |
| WhatsApp, standard send | caps the **long edge** at 1600 — a portrait photo comes back 1200×1600; at or below, passes through untouched | 1600 long edge |
| Telegram, as photo | re-encodes **every** photo to 1280×960 | 1280×960 |
| Telegram, as file | no recompression at all | no resize |
| Instagram | normalises everything to a 1440 square | 1440×1440 |
| Facebook | passes 2048×1152 through untouched | 2048px |

### The largest capacity finding

WhatsApp HD and X/Twitter both preserve the pixel grid up to a 4096 long edge —
verified end to end on a real device, payload read back. They re-compress, and
re-compression without resampling is exactly what `delta 28` was chosen to
survive.

```
1600×1200    3,911 bytes
4096×3072   25,766 bytes     6.6×
```

**That is 6.6× the payload on two of the four judged channels**, self-contained,
with no relay and no pointer. It is not the default, because choosing it wrongly
is a total loss rather than a degradation: over a *standard* WhatsApp send a
4096px image is downscaled to 1600 and the payload is destroyed.

The record here was wrong about this twice in opposite directions — the profile
first shipped at 4096 and destroyed payloads, was clamped to 1600, and was
annotated "HD uploads cap at the same 1600px" as though measured. The original
failure is consistent with HD-sized images sent over a *standard* send. A failed
measurement says the configuration failed, not why.

### Portrait covers never worked, on any platform

`coverGeometry` capped **width** only, so a portrait cover came out taller than
the platform allows — 1600×2133 against a 1600 cap became 1600×2128 — and the
platform then downscaled it, resampling the 8×8 grid. Total loss, ~50% BER.

Invisible because every phone test used a landscape photo, where width *is* the
long edge. The symptom was "the recipient's app finds nothing", which points
nowhere near orientation.

Now capped on the long edge — and confirmed against the platform itself. WhatsApp
returns a portrait photo as **1200×1600**, which is exactly what the fixed rule
now produces, so the image passes through untouched. The old rule sent
1600×2128, which WhatsApp resized on arrival. A test pins that landscape
geometry is byte-for-byte unchanged, since that is the path already verified.

Also confirmed on device: a 4096px image sent over a **standard** WhatsApp send
is downscaled to 1600 and destroyed, exactly as the HD profile's label warns.

**Upstream shipped `instagram: 1080`, and it was the default.** 1080 is upscaled
to Instagram's 1440 canvas, which measured 42–50% bit error: nothing recovered,
ever. `whatsapp_hd: 4096` was long believed to have the same problem in the
other direction, and was clamped to 1600 on that basis — but as recorded above,
4096 is correct for an HD send and the original failure was a *standard* send
downscaling it. The Instagram fix stands; the WhatsApp one was itself a
mis-diagnosis, now corrected.

Upstream's own `docs/WHATSAPP_PLAN.md` records QIM passing the simulator and
throwing `ReedSolomonError: Too many errors` on a real phone. The cause was the
channel simulator using a Pillow quality setting whose *shape* differs
completely from WhatsApp's actual quantization table, which we extracted from
returned files (custom table, steps 6–167, not an Annex K scaling).

### Step size

**Upstream's `QIM_DELTA = 14` does not survive a single JPEG recompression**,
and fails *erratically* rather than weakly — it passes at Q90 and fails at Q95,
because the lattice is marginal enough that survival depends on which way
individual coefficients round.

```
delta=14   Q95:--  Q90:OK  Q85:--  Q80:OK  Q75:--  Q70:--     erratic
delta=20   Q95:OK  Q90:OK  Q85:OK  Q80:OK  Q75:OK  Q70:OK
delta=28   OK at every quality tested
```

Threshold is 26. All lossy profiles ship 28, and a test asserts that delta=14
*fails*, so the change is provably load-bearing rather than superstition.

### Other encoder changes

- **Reed–Solomon parity tuned per profile** (`rsNsym 32` where the AC band is
  restricted). The default of 128 spent half of every 255-byte codeword on
  parity, which at 1280×960 meant modifying 2.5 AC positions per block instead
  of one.
- **Zigzag restriction to the lowest 6 AC positions.** Platform sharpening hits
  high frequencies hardest, so every surviving bit sits where it is disturbed
  least.
- **Square centre-crop for Instagram** rather than padding — padding adds flat
  bars, and flat regions are exactly where embedding fails.
- **A self-test after every embed.** The image is decoded back before you are
  offered it, so a cover that cannot carry your data is caught immediately
  instead of discovered by the recipient. When the full selection does not
  survive, it binary-searches down to the largest amount that does.

### Pointer tier

An alternative mode carrying **~264 bytes** in the image — a Nostr event id plus
a key — with the feed itself published to a relay, encrypted.

Because the payload no longer scales with the feed, cover size stops being the
constraint: a 3,921-byte bundle travelled through a cover with 2,483 bytes of
capacity, which the self-contained mode could not have sent without dropping
most of it.

The trade is stated in the UI and the README: the image is no longer
self-contained, and the recipient's relay request is observable. Off by default
for that reason.

---

## 2. Steganographic invisibility

- **Texture-adaptive step size**: perturbation is scaled per block by local
  texture, so more of it lands where the image can hide it.
- **PSNR was rejected as the metric.** It ranked a visibly dotted image *above*
  a clean one (27.0 dB vs 26.1 dB) because it averages the whole frame and
  cannot see concentration. Human eyes and a masked-visibility metric
  (perturbation ÷ local texture) agreed with each other and disagreed with
  PSNR.
- **Cover guidance in the product.** Fine detail is what hides data, and it is
  not a property users would guess at, so the app says so at both points where
  an image is chosen.

---

## 3. Networking reliability

`relay.ts` was replaced by a pooled, durable implementation behind an identical
API, so wiring was a one-line import change rather than surgery on a
3,000-line component.

| Before | After |
|---|---|
| `publishEvent` was fire-and-forget returning `void` — an event composed offline was **silently lost** | Queued durably before any network attempt, retried with backoff until a relay acknowledges it |
| One WebSocket per relay **per event** | One pooled socket per relay, shared across subscriptions (a test proves 5 publishes × 2 relays = 2 sockets, not 10) |
| A dropped connection killed the feed permanently | Automatic reconnect with subscription re-arming |
| Relay list fetched from `stegstr.com/config/relay.json` — a centralised single point of failure in a decentralised app | User's own relays, then NIP-65 lists learned from the network, then hardcoded defaults; the remote config is consulted last |
| **Inbound events were never verified** — a shape check only, so a hostile relay could inject events attributed to anyone | Every event is signature-verified before it reaches the UI |

Also added: **NIP-44 v2**, verified against the official specification vectors,
and a NIP-65 outbox-model router that reads an author from the relays *they*
advertise.

---

## 4. Security and privacy

- **Decoded content no longer merges automatically.** Upstream merged
  everything an image contained straight into the feed and reported only a
  count. Anyone can send a JPEG; that must not be enough to write to someone's
  feed. Content is now classified and reviewed — grouped by author, with
  signature status, follow status and duplicate detection. Followed authors are
  pre-selected; strangers are not; unverified events are withheld and counted,
  never offered.
- **Per-detection merge policy**: `merge-all`, `follows-only` (default),
  `review-all`. Opening an image from a friend and one from a stranger in a
  group chat are different situations.
- **The Network toggle is honoured everywhere.** With it off, nothing reaches
  the network — including the pointer-resolution path, which names the exact
  event being read and would otherwise have leaked it while the UI promised
  "nothing is sent".
- **Images no longer carry deletions.** A kind-5 tombstone scored ~2.3× the
  density of a real note in the packer, so it sorted to the front of the
  selection and dragged the deleted note in behind it — meaning an image
  preferentially carried a note you had deleted, crowding out the one in your
  feed.
- **Adult content is filtered from the Global feed** by default, leading with
  authors' own NIP-36 content warnings rather than word matching.
- **Attachments are encrypted before upload, and work for any file type.**
  Attaching had been broken outright — every upload was rejected for missing
  NIP-98 auth, silently, because the compose handler blamed the file type and
  both profile handlers swallowed the error. Fixing the auth exposed the real
  problem: the host held your file in the clear, and rejected documents
  entirely. Files are now encrypted client-side, with the name and MIME type
  packed *inside* the ciphertext, and carried to a Blossom host as PNG pixel
  data — because these hosts reject arbitrary binary and return a PNG
  byte-identical. The host stores an ordinary-looking image and learns neither
  what the file is nor what it is called. Verified live at 1, 5 and 10 MB, each
  recovered byte-identical, for +14.4% stored size.

---

## 5. What the app does with your feed

- **Embedding was "take everything, then chop off the end".** Upstream built a
  bundle from the entire event list and, if it did not fit, dropped the *last*
  event and re-encrypted — looping one event at a time. So how much of your
  feed travelled depended on cover size and recipient count, you learned only
  afterwards from a log line, and a 300-event feed ran ~250 full encryption
  passes.

  Now events are scored by usefulness per byte — your own notes weighted
  highest, profiles and relay lists weighted up because losing them leaves the
  recipient unable to identify or reach you, recency decaying over weeks, and
  replies whose parent did not fit removed so threads stay readable — followed
  by a binary search to close any residual overflow. **~250 encryptions became
  ~9**, and the app states what it selected and why.

- **Choose exactly which notes to embed.** Selection was automatic, which is
  right for "back up my feed" and impossible for "send this one message to this
  one person". Combined with recipients-only and pointer mode, that is: one
  chosen note, encrypted for one chosen person, hidden in a photo.

  The picker and the automatic packer had drifted apart: packing carried notes
  from you *or anyone you follow*, while the picker offered only your own. A
  user who had not posted yet saw the control disabled with "you have not
  written any notes yet" while their feed sat full of carryable notes. One rule
  now serves both, with a property test asserting the picker never offers
  anything the packer would refuse. Picking a followed author's note also
  carries their profile — their own signed event, unmodified — so the recipient
  sees a name rather than a bare pubkey.

- **Progress is visible.** The information existed but rendered in a side panel
  out of eyeline, so a multi-second embed read as a hang.

---

### One encoder, not three

The embed dialog offered a choice between QIM and a legacy "Dot" method. Measured
on the same cover, Dot made **twenty times more eye-catching changes** — 0.78% of
subpixels shifted by more than 40, against 0.04% — because it makes a few huge
changes (mean delta 94, max 255) where QIM makes small ones almost everywhere
(mean 6.6). On a flat cover every one of them shows.

Dot also cannot survive a channel that re-encodes, has no self-test (so it
returned a visibly dotted image and reported success), and disabled both pointer
mode and platform targeting. QIM already accepts PNG covers, which was the last
argument for keeping it.

Removed from the picker; the decoder stays, so images already made with it open
exactly as before, and a test holds that open.

*The CLI remains a third implementation — Rust DWT/LSB in PNG — and is
documented as the separate legacy path it is.*

### Controls that existed but did nothing

Four shipped features were present, documented, and inert. None was caught by a
test, because in each case the tests drove the working half.

- **Unfollow** returned before doing anything on a new local identity. The
  default follows are held by no kind-3 event, and the handler opened with
  `if (!kind3) return`. Follow had the mirror bug: it started from an empty tag
  list, so following one account silently dropped the defaults — never
  reported, because losing follows is invisible in a way a dead button is not.
- **Attaching** uploaded nothing. `input.files` is a live FileList bound to the
  element, and the handler cleared `input.value` first — which empties it in
  place — then read a length of zero and reported "Attached 0 file(s)" as
  success. jsdom does not model this, so a test driving a real input passes
  against the broken code; the test uses a double implementing the browser's
  contract, plus cases asserting the double still reproduces the bug.
- **`activityBand`** was declarable on a platform profile and read from
  nowhere. Any evaluation of it done through a profile would have compared an
  image against a byte-identical image.
- **"Pick specific notes"** offered only your own, while automatic packing
  carried notes from anyone you follow. A user who had not posted saw the
  control disabled while their feed sat full of carryable notes.

### Curation, and a feed that holds still

- **Mute from any note.** The mute list, its feed filter and its unmute UI in
  Settings all already existed; the only way to *add* to it was pasting a
  pubkey into Settings by hand, so one account flooding Global had no remedy.
  Local only — a published mute list tells relays whom you blocked.
- **Bulk delete** your own notes: Select, tick, Delete, with Select all. One
  kind-5 tombstone each, because that is the protocol's shape.
- **The feed stopped jumping.** Images had `max-height` and no reserved box, so
  every lazy-loaded image expanded from zero height and shoved the page down —
  continuously, on a feed where images arrive while you read. And new notes
  prepended above whatever was being read; they are now held back and offered.
- **Detect merged into the drop zone**, which used to say "or click Detect
  image below" — two targets for one action.

### Decode sweep deduplicated

Blind detection tries platform profiles, but decoding never resizes: it reads
the image it was given. So two profiles differing only in width are the same
attempt run twice. 24 profiles hold **14 distinct decode configurations**, and
nine of them share one. Worst case dropped from **42 attempts to 22**.

---

## 6. Testing

**Upstream's e2e harness validated only that permutation matrices were
*defined*, and deferred real testing to a "semi-manual flow" — so the encoder
had never been tested outside a browser.**

A `@napi-rs/canvas` polyfill (OffscreenCanvas, ImageData, createImageBitmap)
lets the **real shipped encoder** run under vitest, so embed → channel → detect
is asserted in CI. That is what caught the delta=14 defect.

**343 tests**, covering the encoder round-trip, the relay pool and outbox,
NIP-44 against spec vectors, capacity packing, the review flow, the pointer
tier, slot ordering, encrypted attachments, and the desktop bridge.

Two of those suites exist because of specific blind spots. The desktop app
cannot be rendered in CI — WebKitGTK cannot initialise GL headlessly — so every
desktop bug in this project was found by a person clicking after a twenty-minute
build; `desktop-flow.test.tsx` drives that path with the Tauri bridge mocked,
covering everything above the IPC boundary, which is where all of them lived.
And an opt-in live suite (`STEGSTR_LIVE=1`) checks the one thing no offline test
can: that Blossom hosts still return an uploaded PNG byte-identical. If that
ever changes, every attachment breaks and it surfaces to users as "wrong key".

Calibration tooling is in `calibration/`: chart generation, quantization-table
extraction from returned files, payload recovery with self-contained
Reed–Solomon, and per-channel drift analysis.

---

## 7. How the method changed

Recorded because several of these were learned by being wrong first, and the
same traps are easy to fall into again.

- **Simulation is not evidence.** CI cannot model Instagram's sharpening, so it
  makes Instagram look like an easy channel when a phone says otherwise. That
  gap is the documented origin of upstream's sim-to-real failure. Nothing
  touching the stego core ships on CI alone.
- **Verify against a real photo, not a synthetic cover.** A synthetic cover
  certified a profile that could not decode itself on a real one.
- **Check the returned image's dimensions before decoding anything.** A false
  pass from decoding the *sent* file instead of the returned one cost a day and
  corrupted an earlier record.
- **One variable per platform test.** A round that changed slot ordering *and*
  repetition could attribute its result to neither.
- **Check what is in the file before theorising about behaviour.** Decoding two
  images and printing their contents ended a long speculation loop in minutes;
  the premise being argued over — that the payloads differed — had never been
  checked, and was false.
- **Reason from the mechanism, not the abstraction.** "Capacity is spare, so
  repetition is free" is wrong: repetition spends *modified coefficients*, not
  capacity, and tripling it tripled the visible artifact.
- **δ is not portable between implementations.** It is expressed in units of
  whatever quantization table the encoder uses, so a value measured against one
  encoder means nothing in another.

---

## 8. Known limitations

Stated plainly because they bound what the numbers above mean.

- **Canvas cannot set quantization tables.** `convertToBlob({quality})` takes a
  quality number only, so matched-table encoding is not implementable in
  TypeScript; it needs Rust. Every entrant forking this repo inherits this.
- **Instagram is variable.** Its processing has two distinct modes, and which
  one an upload gets is not a property of the file — byte-identical uploads
  went through both. A failed upload usually succeeds on retry.
- **Flat covers fail.** Logos, screenshots and plain walls have no texture to
  hide in. This is a property of the technique, not a bug; the app detects it
  and says so.
- **iMessage geometry is inherited from upstream**, not independently measured.
  It shares the 1280 profile with Telegram-as-photo, which *is* measured, so it
  is a reasonable inference rather than a result.
- All measurement is one Android phone. WhatsApp Web, Android and iOS do not
  compress identically.
- **Attachments depend on free public hosts.** Blossom servers may drop blobs
  over time, and the image carries only a reference — so a dropped file is
  unrecoverable. The upload is also visible to the host as *an upload*: it
  cannot read the file, its name or its type, but it knows a blob of that size
  arrived from that pubkey at that time.
- **The desktop app cannot be tested end to end in CI.** WebKitGTK cannot
  initialise GL headlessly, so anything below the IPC boundary or in the
  webview's own rendering is verified by hand. Green tests have never caught a
  desktop bug in this project.
