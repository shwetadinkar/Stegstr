# Stegstr

**Steganographic social networking.** Hide messages in images and share them anywhere — local-first, with optional Nostr sync.

This fork adds one thing above all: **images that survive being sent through WhatsApp, Telegram and Instagram.** Those platforms re-encode every photo you send. An image that carries hidden data through your filesystem will usually lose it the moment it goes through a chat app. Every setting here was measured against the real platforms on a real phone, and the app ships the numbers that worked.

Stegstr gives you two ways to use it:

- **UI app** — Desktop and mobile. Write posts, hide them in a photo, and read hidden content out of photos you receive.
- **CLI module** — Command-line tool for scripts and automation.

Both use the same steganographic format. Data is stored and processed **locally**; Stegstr is **not exclusively Nostr**. You can use it fully offline. When you want to sync over the network, Stegstr acts as a Nostr client and uses relays.

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
sha256sum -c SHA256SUMS          # Linux
shasum -a 256 -c SHA256SUMS      # macOS
```

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

| Send it through | Choose | What the app does |
|---|---|---|
| WhatsApp | **Universal** | 1600×1200 — WhatsApp passes this through untouched |
| Telegram, as a photo | **Telegram, as photo** | 1280×960 — Telegram re-encodes every photo to this |
| Telegram, as a file | **Telegram, as file** | No resize — largest capacity, best quality |
| Instagram | **Instagram** | 1440×1440 square — Instagram normalises everything to this |
| Facebook / Twitter | **Universal** | 1600px |

**Universal** also covers Twitter and Facebook, so it's the right default when you're not sure or the image may be forwarded onward.

**Getting this wrong is the main reason hidden data disappears.** If a platform resizes your image, the data goes with it. Matching the platform's own output size is what keeps it intact.

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

Measured round trips: 1 MB, 5 MB and 10 MB all recovered byte-identical.

---

## Privacy and control

- **Nothing merges into your feed automatically.** Opening an image shows you exactly what it contained, grouped by author, with signature status. People you follow are pre-selected; strangers are not. Anyone can send you a photo — that must not be enough to write to your feed.
- **Every incoming event is signature-verified** before it reaches you, including events from relays.
- **Network is off by default.** With it off, embedding and detecting happen entirely in your browser and nothing is sent.
- **Recipients-only mode** encrypts the payload for specific people. Holding the image isn't enough to read it.
- **Your own relays first.** Relay selection uses your configured relays, then lists learned from the network, then defaults.
- **Adult content is filtered from the Global feed** by default, using authors' own NIP-36 content warnings.

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

## Command-line interface (CLI)

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
- **Texture-adaptive step size** varies the strength per region, so more data goes where the image can hide it.
- **Platform profiles** set geometry and encoder parameters per destination, measured against the real services.
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
