# Stegstr

**Steganographic social networking.** Hide messages in images and share them anywhere — local-first, with optional Nostr sync.

**[Read the measurements](https://dev.to/shwetadinkar/what-whatsapp-instagram-and-telegram-actually-do-to-your-photos-2gjd)** — what WhatsApp, Instagram and Telegram actually do to a photo, and how each platform profile here was derived.

**[Try Stegstr](https://stegstr.com/r/UE8635)** — browser or desktop, nothing to sign up for.

This fork adds one thing above all: **images that survive being sent through WhatsApp, Telegram and Instagram.** Those platforms re-encode every photo you send. An image that carries hidden data through your filesystem will usually lose it the moment it goes through a chat app. Every setting here was measured against the real platforms on a real phone, and the app ships the numbers that worked.

## What this fork adds

Everything below was measured against the real services on a real device, and the numbers are the ones the app ships.

| | |
|---|---|
| **6.6× the hidden capacity** | X/Twitter and WhatsApp HD keep a 4096px image intact, carrying **~25 KB per photo** against 3.9 KB at 1600px. Verified end to end on a phone. |
| **Every channel measured** | WhatsApp (normal and HD), Telegram (as photo and as file), Instagram, X/Twitter and Facebook — each confirmed by sending an image through it and reading the payload back. |
| **Instagram matched at the format level** | The encoder writes JPEG on **Instagram's own quantization table**, extracted from images Instagram returned. Its re-encode then has nothing to change: 100% of the hidden data survives, against 85.9% on a generic table. Three consecutive clean round trips where the previous profile failed — at half the step size, so the photo is visibly cleaner too. **Instagram is the only target that ships a matched table.** Facebook returns the same Meta table, but the profile built on it (`facebook_matched`) is unresolved — its one real-account attempt returned nothing recoverable, having changed both the table and the step in the same round, so it attributes to neither. It is **not offered in the picker**; it is retained only so images already made with it still decode. Plain **Facebook** encodes on a generic table and is the target that was verified end to end. |
| **Encrypted attachments, any file type** | Documents, video, archives. Encrypted before upload; the host stores ciphertext and never learns the filename or the type. 50 MB tested. |
| **Pointer mode** | A ~260-byte reference in the photo, content encrypted on a relay — for channels too tight for a full payload. |
| **Built for AI agents** | An MCP server exposing the same encoder the app uses, so an agent can embed and detect directly. |
| **380 tests** | 380 passing and 4 skipped (a live-network suite, opt-in via `STEGSTR_LIVE=1`). They include the real shipped encoder driven through a simulated channel, which is what caught a step size that failed on a phone while passing every unit test. |

The organising claim, and the reason most of this exists: **an image only carries hidden data through a chat app if the encoder is matched to what that specific app does to photos.** Get the geometry wrong and the payload is not degraded — it is destroyed.

[CHANGES.md](CHANGES.md) has the full list against upstream, with the measurements behind each number.

---

Stegstr gives you two ways to use it:

- **UI app** — Desktop and mobile. Write posts, hide them in a photo, and read hidden content out of photos you receive.
- **CLI module** — Command-line tool for scripts and automation.

The app uses one method throughout — QIM in JPEG DCT coefficients — and accepts PNG or JPEG covers. (The CLI is a separate, older implementation; see its section below.) Data is stored and processed **locally**; Stegstr is **not exclusively Nostr**. You can use it fully offline. When you want to sync over the network, Stegstr acts as a Nostr client and uses relays.

---

## Quick start

### Try it in a browser — nothing to install

**https://shwetadinkar.github.io/Stegstr/**

Works on desktop and mobile. Embedding and detecting run entirely in your
browser; with the Network toggle off, nothing is sent anywhere. This is the
same code as the desktop app and the build every platform measurement was
made against.

### Graphical app (UI)

Download the latest release for your platform:

- [macOS](https://github.com/shwetadinkar/Stegstr/releases/latest/download/Stegstr-macOS.dmg) · [Windows](https://github.com/shwetadinkar/Stegstr/releases/latest/download/Stegstr-Windows.exe) · [Linux](https://github.com/shwetadinkar/Stegstr/releases/latest/download/Stegstr-Linux.deb) / [AppImage](https://github.com/shwetadinkar/Stegstr/releases/latest/download/Stegstr-Linux.AppImage)

See [Releases](https://github.com/shwetadinkar/Stegstr/releases) for all builds.

### Verifying your download

Every release states the commit it was built from, and the build runs in public
CI, so a binary can be traced to its source and rebuilt from scratch. Compare
the checksum of what you downloaded against `SHA256SUMS` on the release page:

```bash
sha256sum --ignore-missing -c SHA256SUMS      # Linux
shasum -a 256 --ignore-missing -c SHA256SUMS  # macOS
```

`--ignore-missing` matters: `SHA256SUMS` lists every installer, so without it
the ones you did not download are reported as failures.

```powershell
Get-FileHash Stegstr-Windows.exe -Algorithm SHA256    # Windows
```

If you would rather not run someone else's binary at all, building from source
takes two commands and is documented below.

**macOS — first launch.** The build is not signed with an Apple Developer
certificate, so macOS blocks it the first time. To allow it:

1. Try to open **Stegstr** — macOS will refuse and say it cannot be verified.
2. Open **System Settings → Privacy & Security**, scroll to the **Security**
   section at the bottom.
3. Next to "Stegstr was blocked", click **Open Anyway**, then **Open** to
   confirm.

You only do this once. Note that Control-clicking the app and choosing Open no
longer bypasses this on macOS Sequoia (15) and later — the Privacy & Security
route is the only one.

If you prefer the terminal, this achieves the same thing in one step:

```bash
xattr -cr /Applications/Stegstr.app
```

**Linux.** The `.deb` declares its dependencies, so install it with apt rather
than dpkg and they resolve automatically:

```bash
sudo apt install ./Stegstr-Linux.deb
```

The `.AppImage` needs no installation — `chmod +x` it and run it.

### Send your first hidden message

1. Write a post, or let your existing feed be the payload.
2. Click **Embed image** and choose a cover photo.
3. Pick the platform you're going to send it through — this matters, see below.
4. Send the downloaded image through that platform.
5. The recipient drops it on **Detect image** and sees what it held.

---

## Choosing a cover photo

**Pick a detailed photo** — foliage, fabric, crowds, brickwork, textured surfaces.

Detail is what hides the data. Fine texture in a photo masks the changes the encoder makes, and the same texture is what lets those changes survive a platform's re-compression.

**Avoid large smooth areas** — open sky, plain walls, screenshots, logos, flat graphics. A smooth region gives the data nowhere to hide, so it is both more visible and more fragile. The app runs a self-test after embedding and will tell you if a cover can't carry your data reliably.

A good rule of thumb: if the photo looks "busy", it's a good cover.

---

## Pick the right platform target

Every platform resizes and re-compresses photos differently. Choosing the right target sets the geometry and encoder settings that survive that specific pipeline.

| Send it through | Choose | What the app does | Carries |
|---|---|---|---|
| **X/Twitter** | **Large (4096px)** | Keeps your image's own size up to a 4096 long edge | **~25 KB** |
| **WhatsApp, HD toggle ON** | **Large (4096px)** | Same — an HD send carries 4096×3072 intact | **~25 KB** |
| WhatsApp, normal send | **Universal** | 1600×1200 — passed through untouched | ~3.9 KB |
| Facebook | **Facebook** | 2048×1152 — passed through untouched | ~6.4 KB |
| Telegram, as a photo | **Telegram as photo** | 1280×960 — Telegram re-encodes every photo to this | ~2.5 KB |
| Telegram, as a file | **Telegram, as file** | No resize — largest capacity of all | biggest |
| Instagram | **Instagram** | 1440×1440 square, encoded on Instagram's own quantization table | ~3 KB |
| Not sure, or it may be forwarded | **Robust** *(default)* | No resize — keeps your image's own size, and settles for redundancy instead of guessing a channel | ~4 KB on a 1920px photo |
| A known 1600px channel | **Universal** | 1600px — WhatsApp normal send, X/Twitter, Facebook | ~3.9 KB |

### The default target: Robust

**If you do not name a platform, you get Robust.** That is what the CLI, the
MCP server and any API caller use when the argument is omitted.

Every other target answers a channel somebody measured: a geometry a real
service was observed to return, and a step size probed against that service's
own quantization table. Robust answers the case those cannot — nobody said
where the image is going, so there is no table to match and no geometry to
pre-empt. It does not resize, and it turns off the texture-adaptive step for
the reason described under [How it works](#how-it-works).

It used to be **Universal**, which is tuned — but tuned *for* something. 1600px
because WhatsApp returns 1600; step 28 because WhatsApp's table quantizes the
embedding band at 6,6,6,7,6,7. That is the right answer for WhatsApp and a
guess otherwise, and measured blind against generic recompression it carried
data through 40% of the test profiles. Robust carries it through 100%, on a
busy photo, a gradient and a smooth cover alike, and does it at a *smaller*
step — so the image is no more marked than before.

**Name your platform when you know it.** Robust is deliberately generic; a
measured profile matches a real service's geometry and quantization table, and
that is still the thing this project is for. Robust exists so that not knowing
is no longer the worst case.

**Instagram and Telegram-as-photo need their own targets** — Instagram normalises to a 1440 square and Telegram re-encodes every photo to 1280×960, so a 1600px image is resized by both and the data goes with it.

**Large (4096px) carries about six times as much**, and both channels are verified end to end on a real device. It is not the default because getting it wrong is expensive: sent over a *normal* WhatsApp send, a 4096px image is downscaled to 1600 and the hidden data is destroyed completely. Use it when you know the channel; use **Universal** when you don't.

**Getting this wrong is the main reason hidden data disappears.** If a platform resizes your image, the data goes with it. Matching the platform's own output size is what keeps it intact.

### Two measurements behind that, with the files committed

**Telegram as a photo, verified both ways.**
[`calibration/telegram_returns/`](calibration/telegram_returns/) holds a send
and its return from a real Telegram account, with checksums. A 1280×960 cover
came back 1280×960 and the payload read back through the CLI — the first
round trip at this geometry, which the profile previously only inferred.
Telegram re-encodes on a scaled Annex K table near Q87, finer than the
send-side table, so the embedding band survives its second quantisation.

The same directory holds the **negative**, which is the more useful half: the
same payload in a 4096×3072 cover came back 1280×960 with **nothing
recoverable**. The payload is provably in the file that was sent and provably
gone from the file that came back, and the only thing in between is the
downscale. Resampling shifts the 8×8 DCT grid, so the decoder walks
coefficients that were never written — a total loss with no partial recovery to
fall back on. That is why Telegram-as-photo targets 1280 and why
Telegram-as-file exists for anything larger.

**WhatsApp HD keeps your pixels, and rotates them.**
[`calibration/whatsapp_hd_returns/`](calibration/whatsapp_hd_returns/): a
3840×2160 upload came back with its 3840 long edge intact, where the same
pipeline's *normal* send caps a 4096px image at 1600×1200. The two modes also
quantize differently — HD at 4/19/12.2 against the normal send's 6/167/35.6 —
confirmed across two geometries, so it is the send mode that picks the table,
not the image size.

It also **applies EXIF orientation physically and drops the flag**: that upload
was `orientation=6` at 3840×2160 and came back 2160×3840 with no orientation
tag. A 90° rotation is not a degradation of hidden data, it is the end of it —
the grid is transposed and the decoder reads coefficients that were never
written. Measured here: an upright stego image decodes, the same image rotated
90° recovers nothing.

**This encoder is not exposed to that**, because it rasterises the cover
through the same orientation-applying path and writes output through canvas,
which emits no EXIF — so what leaves is already upright with no flag and
WhatsApp has nothing left to act on. `src/__tests__/exif-orientation.test.ts`
holds that open. Without it, every payload sent to WhatsApp from a portrait
phone photo would die silently, and the failure would look like "the
recipient's app finds nothing".

---

## Two ways to carry your feed

**Self-contained (default).** Everything travels inside the image. Works offline, forever, and leaks nothing — the image is the whole message. How much of your feed fits depends on the cover photo's size.

**Send a link instead ("pointer mode").** The image carries a ~260-byte reference and your feed goes to a Nostr relay, encrypted. Because the payload is tiny, it stays intact through tighter channels and carries your whole feed regardless of cover size.

The trade: the recipient needs to be online to read it, and their relay request is visible to anyone watching their network traffic. The self-contained mode has neither of those properties. Pointer mode is off by default for that reason — turn it on when the channel is tight or the feed is large.

Content on the relay is encrypted; the key travels in the image. A relay operator sees an opaque blob.

---

## Attaching files

Notes can carry a file of any type — a document, a video, an archive. The file is **encrypted before it leaves your machine**, and only a reference travels inside the photo, so a small cover image can deliver something arbitrarily large.

The host stores what looks like an ordinary image and learns nothing useful:

| | visible to the host |
|---|---|
| File contents | no |
| File name | no |
| File type | no |
| That *something* was uploaded, its size, and by which pubkey | yes |

The name and MIME type are packed *inside* the encrypted data rather than sent alongside it. A host that could read `salary-2026.pdf` would learn most of what matters without ever opening the file.

Attachments are fetched **only when you click**, never in the background — pre-fetching would tell a third-party server you had opened a note. The decryption key is stripped from the note's displayed text.

**Two things to know before relying on it.** Files are stored on free public [Blossom](https://github.com/hzrd149/blossom) servers, which **may drop them over time** — the photo carries only a reference, so a dropped file is gone. And attachments add about 14% to the stored size.

Measured round trips: 1 MB, 5 MB and 10 MB recovered byte-identical, and a 50 MB zip uploaded and posted successfully.

---

## Reading and tidying your feed

**Detect an image** by dropping it on the drop zone, or clicking it to choose a
file. Nothing merges into your feed automatically — you see exactly what the
image contained, grouped by author, and choose what to keep.

**Mute an account** from any note. Their posts disappear from your feed on this
device only: nothing is published, and the author is not told. Undo it in
**Settings → Muted users**, where you can also mute by keyword.

**Delete several of your own notes at once.** Press **Select** in the feed
header, tick the notes, then **Delete** — or **Select all** for everything of
yours currently on screen. Checkboxes appear only on your own notes, because
nostr has no way to withdraw someone else's note from the network; a button
implying otherwise would be a lie about what the app can do.

**New notes wait for you.** When posts arrive while you are reading, they are
held back and offered as a *"N new notes"* button rather than being inserted
above what you are looking at.

---

## Privacy and control

- **Nothing merges into your feed automatically.** Opening an image shows you exactly what it contained, grouped by author, with signature status. People you follow are pre-selected; strangers are not. Anyone can send you a photo — that must not be enough to write to your feed.
- **Every incoming event is signature-verified** before it reaches you, including events from relays.
- **Network is off by default.** With it off, embedding and detecting happen entirely in your browser and nothing is sent.
- **Recipients-only mode** encrypts the payload for specific people. Holding the image isn't enough to read it.
- **Your own relays first.** Relay selection uses your configured relays, then lists learned from the network, then defaults.
- **Adult content is filtered from the Global feed** by default, using authors' own NIP-36 content warnings.
- **Muting is local.** A published mute list would tell relays, and anyone reading them, exactly whom you have blocked. NIP-51 defines a list for people who want that; this deliberately is not it.
- **Attachments are fetched only when you click**, never in the background — pre-fetching would tell a third-party server that you had opened a note.

---

## Troubleshooting

**"This cover image cannot reliably carry your feed."**
The photo is too smooth or too small. Use a more detailed photo, or a target with a larger canvas (Telegram-as-file, or Facebook at 2048px).

**The recipient's app finds nothing in the image.**
Almost always the image was resized in transit. Check that the platform target matched how you actually sent it — sending a "Telegram, as photo" image as a *file*, or vice versa, changes the processing. Also check the image wasn't screenshotted or re-saved along the way; that destroys hidden data.

**A platform mangled it.**
Platform processing isn't perfectly consistent. If an image comes back unreadable, send the same file again — it usually goes through. Re-embedding isn't necessary; the downloaded file is fine.

**Pointer mode says it can't publish.**
It needs the network, since your feed goes to a relay. Turn Network on, or untick it to embed everything in the image instead.

**"The attachment is no longer on that server."**
The file was dropped by the host, which free Blossom servers may do over time. The reference in the image is intact but there is nothing left to fetch. This is deliberately worded differently from a key error — if it says the key is wrong instead, the link or key is at fault, not retention.

**Attaching says it needs an identity, or needs the network.**
Uploads are signed, so you must be logged in, and they go to a host, so Network must be on. With Network off the app will refuse rather than quietly sending your file.

---

## Command-line interface

Two command-line tools ship in this repo, and they are not interchangeable.
This one — `stegstr` — drives the **same QIM encoder the app and the MCP server
use**, so anything it produces carries the platform measurements. The Rust
`stegstr-cli` below is the older PNG method and does not.

```bash
npm install && npm run build:cli
node dist-cli/stegstr.mjs --help
```

### Commands

```
stegstr platforms [--json]
stegstr capacity --in <cover> [--platform <name>] [--json]
stegstr resize   --in <cover> --out <file> [--platform <name>] [--json]
stegstr embed    --in <cover> --out <file> (--message <text> | --payload-file <path>)
                 [--platform <name>] [--raw] [--no-verify] [--json]
stegstr detect   --in <image> [--out <file>] [--raw] [--json]
```

| | |
|---|---|
| `platforms` | List the targets, their geometry and what each is for |
| `capacity` | How many bytes this cover carries for a target, before you embed |
| `resize` | Write the cover through a target's geometry with **nothing embedded** — the baseline for a like-for-like comparison |
| `embed` | Hide a payload. Decodes the result back before writing unless `--no-verify` |
| `detect` | Recover a payload. Needs no hints — it identifies the settings itself |

Omit `--platform` and you get **Robust**, the unnamed-channel default.

### Flags

- `--raw` — embed and extract bytes verbatim, no encryption. This is what a
  survival test wants: embed known bytes, push the image through a channel,
  recover, compare. Encryption in the loop only adds a way for the comparison
  to fail for reasons that have nothing to do with the channel.
- `--no-verify` — skip decoding the result back before writing. Not recommended.
- `--json` — machine-readable output.

### Built to be driven by a machine

**`--json` puts a structured object on stdout and everything else on stderr**,
so the two never interleave and a harness can `JSON.parse(stdout)` without
filtering prose out of it first.

**Exit codes are distinct per failure mode**, so a caller can branch without
parsing messages:

| code | meaning |
|---|---|
| `0` | success |
| `1` | usage error, or something unexpected |
| `2` | payload exceeds capacity for that platform |
| `3` | embed succeeded but failed read-back verification |
| `4` | detect found no Stegstr payload |

The distinction between 2, 3 and 4 is the point. "Too large", "written but
unverifiable" and "nothing there" are different results, and collapsing them
into one non-zero exit is how a harness ends up reporting a capacity limit as a
codec failure.

### Example: measure survival end to end

```bash
npm run build:cli
head -c 800 /dev/urandom > payload.bin

node dist-cli/stegstr.mjs embed  --in cover.jpg --out stego.jpg \
     --payload-file payload.bin --raw --json
# ...push stego.jpg through a channel, or through judge_harness.py...
node dist-cli/stegstr.mjs detect --in returned.jpg --raw --out recovered.bin
cmp payload.bin recovered.bin && echo "survived"
```

`judge_harness.py` in the repo root does exactly this across five recompression
profiles and reports survival and PSNR. It drives the CLI, so it measures the
shipped encoder rather than a copy of it.

---

## Legacy CLI (`stegstr-cli`, Rust/PNG)

**Read this before using it.** This CLI is an older, separate implementation and
**does not produce images that survive chat apps.** It embeds in the LSB of
wavelet detail coefficients and writes PNG; WhatsApp, Telegram-as-photo,
Instagram, Facebook and X all re-encode uploads to JPEG, and JPEG quantisation
discards exactly the detail those bits live in.

Everything this fork measured — the platform geometry, the 4096px capacity, the
step size — belongs to the **QIM** encoder, which the app, the MCP server and
the `stegstr` CLI above all share. `stegstr-cli` does not.

| | survives a chat app | notes |
|---|---|---|
| App (browser or desktop) | **yes** | QIM in JPEG DCT, measured on real devices |
| MCP server | **yes** | same encoder as the app |
| `stegstr` CLI (Node) | **yes** | same encoder as the app; JPEG, takes a platform target |
| `stegstr-cli` (Rust) | **no** | the legacy method — PNG only, for direct file transfer |

**Use the CLI when the file will not be re-encoded** — Telegram *sent as a
file*, email attachments, USB, cloud storage. PNG is lossless, so the bytes
arrive exactly as sent and the payload is intact.

**For anything going through a chat app, use the `stegstr` CLI above or the
[MCP server](#for-ai-agents-mcp)** — both expose the same encoder the app uses
and take a platform target.

> Not yet measured: we have not sent a `stegstr-cli`-made PNG through a platform and
> recorded the result. The reasoning above follows from how those pipelines
> behave, and matches how the JPEG-domain encoder was arrived at, but it is an
> inference rather than a measurement — and this project has been wrong that way
> before. Treat the "no" as strong expectation, not a number.

You need [Rust](https://rustup.rs) (latest stable):

```bash
git clone https://github.com/shwetadinkar/Stegstr.git
cd Stegstr
cd src-tauri && cargo build --release --bin stegstr-cli
```

Binary: `target/release/stegstr-cli` (Windows: `stegstr-cli.exe`).

```bash
./target/release/stegstr-cli post "Hello from CLI" --output bundle.json
./target/release/stegstr-cli embed cover.png -o out.png --payload @bundle.json --encrypt
./target/release/stegstr-cli detect out.png
```

---

## For AI agents (MCP)

Stegstr exposes its steganography as tools any MCP client can call — hide a
message in a photo, recover one, check whether a photo is a good carrier, and
list the platform targets.

```bash
npm install && npm run build:mcp
```

Then register it. For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stegstr": {
      "command": "node",
      "args": ["/absolute/path/to/Stegstr/dist-mcp/server.mjs"]
    }
  }
}
```

Tools: `stegstr_platforms`, `stegstr_inspect_cover`, `stegstr_capacity`,
`stegstr_embed`, `stegstr_detect`.

The server calls the same encoder the app uses, so an agent and a person
clicking **Embed** produce comparable images. Embedding is verified by decoding
the result back before the file is written.

Full skill definition: [`skill/stegstr/SKILL.md`](skill/stegstr/SKILL.md).

**Note on the legacy CLI.** `stegstr-cli` uses an older PNG method that does
**not** survive platform processing — chat apps convert uploads to JPEG, which
destroys it. Use it only for offline transfer where the file is passed along
untouched; use the MCP server for anything sent through a platform.

---

## Build from source

Prerequisites: Node.js 18+, Rust (latest stable).

```bash
git clone https://github.com/shwetadinkar/Stegstr.git
cd Stegstr
npm install
npm run build:mac   # or build:win, build:linux
```

Run the test suite:

```bash
npm test
```

See the repo for platform-specific build deps (Xcode CLI tools, Visual Studio Build Tools, Linux dev packages).

---

## How it works

Data is hidden using **QIM (Quantization Index Modulation)** in the mid-frequency DCT coefficients of the image — the same domain JPEG itself works in. That's what lets it survive re-compression: the data lives where the format is already stable, rather than in pixel values a re-encode would discard.

On top of that:

- **Reed–Solomon error correction** repairs the damage a platform's re-encode does.
- **Bit repetition with majority voting** adds a second layer of redundancy.
- **Texture-adaptive step size** varies the strength per region, so more of the
  perturbation lands where the image can hide it. **It is off in the default
  profile**, and the reason is worth stating plainly: it is not a free win, and
  on detailed photos going through hard recompression it is worse than doing
  nothing.

  The ladder gives each block a step derived from that block's own texture, and
  the decoder has to derive the same number from the image the channel handed
  back. Hard recompression flattens the coefficients the measurement reads, so
  blocks migrate to a different rung between embed and decode — and every bit
  in a migrated block is then read at the wrong step. That is whole-block
  error, which is exactly what Reed–Solomon and majority voting cannot absorb;
  both assume errors are sparse and independent.

  Measured on a 1920×1080 photo carrying 800 bytes, through five recompression
  profiles, with no platform named:

  ```
  ladder on    40% survived    and raising the step to 40 did not change it
  ladder off  100% survived    at a SMALLER step than the ladder was using
  ```

  Bit repetition (5 → 9 → 15 → 21) and Reed–Solomon parity (32 → 64 → 96) both
  saturated at 60%. Three levers reaching the same ceiling is what identified
  the ladder rather than margin as the cause.

  Smooth and gradient covers never showed it — almost every block there sits on
  the lowest rung with nothing near a boundary, so no rung can move. It is a
  detailed-photo failure, which is why it survived so long. The ladder stays on
  for the per-platform profiles, where the channel is known and measured and
  the recompression is gentler than the worst case above.
- **Platform profiles** set geometry and encoder parameters per destination, measured against the real services. The size is a cap on the image's **long edge**, so portrait and landscape covers are handled alike.
- **A self-test after every embed** decodes the image back before you send it, so a cover that can't carry your data is caught immediately rather than discovered by the recipient.

Payloads are encrypted (AES-GCM), with NIP-44 available for direct messages.

---

## Reproducing the measurements

```bash
npm run bench
```

Runs the platform matrix and the step-size probe and writes
[`benchmarks/results/RESULTS.md`](benchmarks/results/RESULTS.md), which is
committed — so you can re-run it and diff against what is checked in.

Note what it does and does not establish. The channel it models is a resize
plus a JPEG re-encode. Real platforms also sharpen, and Instagram's damage is
sharpening rather than compression, so a simulator flatters it. A pass there
means the encoder is internally consistent and survives recompression; the
claim that payloads survive real platforms rests on phone testing, not on this.

## What this fork changes

See [CHANGES.md](CHANGES.md) for the full list against upstream — platform
measurements, the encoder defaults that were fixed, the networking rewrite, the
security changes, and the limitations that bound all of it.

## Links

- [Website](https://stegstr.com) — Downloads, getting started, wiki
- [Wiki / CLI docs](https://stegstr.com/wiki/cli.html) — Full CLI reference
- [Releases](https://github.com/shwetadinkar/Stegstr/releases)

## License

MIT
