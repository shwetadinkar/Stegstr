---
name: stegstr
summary: Hide messages inside photos so they survive being sent through WhatsApp, Telegram and Instagram. Steganographic Nostr client — works offline, no registration.
description: Hide and recover messages in images. Use when the user wants to send something covertly through a chat app, extract hidden content from a photo they received, or work with steganographic social networking. The MCP server is the interface to use — it targets each platform's measured image processing so the payload survives recompression.
license: MIT
tags: steganography, nostr, images, crypto, privacy, mcp, cli, automation
install:
  requirements: |
    - Node.js 18+
    - Git
  steps: |
    1. git clone https://github.com/shwetadinkar/Stegstr.git
    2. cd Stegstr && npm install
    3. npm run build:mcp
    4. Register the server (see "Setup" below)
permissions:
  - filesystem
metadata:
  homepage: https://stegstr.com
  repo: https://github.com/shwetadinkar/Stegstr
---

# Stegstr

Hide a message inside an ordinary photo, send the photo through a normal chat
app, and have the recipient recover the message from it.

The hard part is not hiding data — it is surviving the journey. WhatsApp,
Telegram and Instagram re-encode and resize every photo they carry, and naive
steganography does not survive that. Each platform target here was derived by
sending real images through the real service and measuring what came back.

## When to use this skill

- Hide a message in a photo that will be **sent through** WhatsApp, Telegram,
  Instagram, Facebook or Twitter.
- Extract hidden content from a photo the user received.
- Check whether a photo is a suitable carrier before using it.
- Anything involving steganography, hidden messages in images, or Stegstr.

## Setup

```bash
git clone https://github.com/shwetadinkar/Stegstr.git
cd Stegstr && npm install && npm run build:mcp
```

Register the server with your MCP client. For Claude Desktop, add to
`claude_desktop_config.json`:

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

Use an absolute path, and restart the client afterwards.

## Tools

| Tool | Purpose |
|---|---|
| `stegstr_platforms` | The platform targets and the geometry each uses |
| `stegstr_inspect_cover` | Score a photo for how well it can hide data |
| `stegstr_capacity` | Bytes available for a given photo and target |
| `stegstr_embed` | Hide a message, verified by decoding it back before writing |
| `stegstr_detect` | Recover hidden content from an image |

## The two things that decide whether this works

**1. Pick the target that matches how the image will be sent.**

Each platform processes photos differently, and the encoder has to match. Send
an image built for `telegram_photo` as a *file* instead of a photo — or the
reverse — and the processing differs enough to lose the payload.

```
universal         1600px    WhatsApp, Twitter, Facebook. The safe default.
telegram_photo    1280x960  Telegram re-encodes every photo to this.
telegram_file     no resize Telegram as a file. Largest capacity.
instagram         1440 sq   Instagram normalises everything to a square.
```

Call `stegstr_platforms` when unsure. Choosing wrong is the most common reason
hidden data disappears.

**2. Use a detailed photo.**

Fine detail is what conceals the payload *and* what lets it survive
recompression. Foliage, fabric, crowds, brickwork, textured surfaces all work
well. Large smooth areas — open sky, plain walls, screenshots, logos — give the
data nowhere to hide; embedding into them is more visible and often fails
outright.

`stegstr_inspect_cover` scores this. Roughly: above 25 is good, 12–25 is usable,
below 12 will probably fail.

Also prefer a photo **at least as wide as the target** (1600px for `universal`).
Photos are never enlarged, so a small one keeps its own size and the platform
may resize it on arrival — which destroys the payload.

## Example

```
1. stegstr_inspect_cover  { image_path: "~/photos/garden.jpg" }
   -> detail 41.2, good — plenty of texture to hide in

2. stegstr_embed { image_path: "~/photos/garden.jpg",
                   message: "Meeting moved to Thursday 4pm",
                   output_path: "~/photos/send-me.jpg",
                   platform: "universal" }
   -> hidden, verified by decoding it back before writing

3. User sends send-me.jpg through WhatsApp.

4. Recipient: stegstr_detect { image_path: "~/Downloads/IMG-received.jpg" }
   -> "Meeting moved to Thursday 4pm"
```

## Things worth telling the user

- **Do not screenshot or re-save the image.** Either destroys the hidden data.
  Send the file itself.
- **Embedding is verified.** `stegstr_embed` decodes the image back before
  writing it, so a cover that cannot carry the message reports failure rather
  than producing an image that silently loses it.
- **Platform processing varies.** If a received image does not decode, having
  the sender re-send the same file often works — it is not necessary to
  re-embed.
- **The payload is encrypted**, so a relay or platform sees only an ordinary
  photo.

## Legacy CLI

The repo also ships `stegstr-cli`, a Rust binary using an older **PNG**
dot-matrix method.

**It does not survive platform processing.** PNG is lossless, but every chat
app converts uploads to JPEG, which destroys that method's payload entirely.
Use it only for local or offline transfer where the file is passed along
untouched — a USB stick, a file share, an email attachment that is not
re-encoded.

```bash
cd src-tauri && cargo build --release --bin stegstr-cli
./target/release/stegstr-cli post "message" --output bundle.json
./target/release/stegstr-cli embed cover.png -o out.png --payload @bundle.json --encrypt
./target/release/stegstr-cli detect out.png
```

For anything that will pass through a chat app, use the MCP server instead.

## Links

- **Repo:** https://github.com/shwetadinkar/Stegstr
- **What this fork changes:** https://github.com/shwetadinkar/Stegstr/blob/main/CHANGES.md
- **Downloads:** https://github.com/shwetadinkar/Stegstr/releases/latest
- **Upstream project:** https://stegstr.com
