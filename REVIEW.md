# Stegstr code review guidelines

## Project context

Stegstr is a steganographic Nostr client. It hides data in **JPEG DCT
coefficients using QIM** (quantization index modulation), tuned so the payload
survives being re-compressed by WhatsApp, Telegram, Instagram, X/Twitter and
Facebook.

Stack: React + TypeScript, packaged for desktop with Tauri (Rust). The same
TypeScript encoder runs in the browser, in the desktop webview, and in the MCP
server — there is deliberately only one implementation.

> An earlier version of this file described LSB embedding in PNGs. That was the
> upstream method and has not been the shipped one for a long time. PNG output
> survives only a direct file transfer; every chat app re-encodes, and LSB does
> not survive re-encoding at all.

## The rule everything rests on

**Match the platform's native output geometry and the 8×8 DCT block grid
survives. Fail to, and the payload is destroyed completely** — not degraded.
Every catastrophic failure measured in this project was ~50% bit error, which
is chance, and every one came from a geometry mismatch.

So any change touching resize, crop or target dimensions is high risk, whatever
the tests say.

## Always check

- **Geometry.** Does the change alter what dimensions leave the encoder? The
  cap applies to the **long edge**, not the width — capping width alone
  silently destroyed every portrait cover on every platform, and no test caught
  it because every device test used a landscape photo.
- **One implementation.** A rule written twice will drift. Three separate bugs
  in this project came from exactly that: a duplicate desktop detect path that
  never received the review dialog, a note picker that disagreed with the
  packer about whose notes could be carried, and a mute feature nearly built a
  second time when a working one already existed.
- **Does the switch do anything?** Two features have shipped here that were
  present, documented, and inert — `activityBand` was declarable on a profile
  and read from nowhere, and Unfollow returned before doing anything. Prefer a
  test that fails without the change.
- **Is the error visible where the user is?** Attaching reported every failure
  correctly, into a panel on the other side of the screen. A dead button and an
  invisible error are the same thing from outside.
- **Network gating.** With the Network toggle off, nothing may reach the
  network. Where an action genuinely needs it, the app turns it on and *says
  so* rather than refusing — but the disclosure is not optional, particularly
  for pointer resolution, which names the exact event being read.
- **Signature verification** on every inbound event, including from relays.
- **Nothing re-signed under another key.** Carrying someone's profile or note
  means carrying their signed event unmodified. Attributing words or a name to
  a key that is not theirs is the one thing this app must never do.
- No secrets or private keys in committed code.
- Rust: no `unsafe` without justification.

## What tests here can and cannot catch

`npm test` runs the **real shipped encoder** under vitest via a
`@napi-rs/canvas` polyfill, so embed → channel → detect is asserted in CI. That
is what caught the delta=14 defect.

What it cannot catch:

- **Anything visual.** PSNR was explicitly rejected as a metric here — it once
  ranked a visibly dotted image *above* a clean one, because it averages the
  frame and cannot see concentration.
- **The desktop app end to end.** WebKitGTK cannot initialise GL headlessly, so
  the window opens at the right size and paints nothing. Every desktop bug in
  this project was found by a person clicking after a twenty-minute build.
  `desktop-flow.test.tsx` covers everything above the IPC boundary, which is
  where all of them lived, but it cannot cover rendering.
- **Real platform behaviour.** Only a phone can settle that. The channel
  simulator once passed an encoder that failed on a real device, because its
  quantization table had the wrong *shape*.
- **Browser DOM quirks.** jsdom does not model a live `FileList`, so a test
  driving a real file input passed against code that uploaded nothing.

Green tests have never once caught a desktop bug in this project. Treat them as
necessary, not sufficient.

## Measurement discipline

Numbers in comments and docs are load-bearing here and are expected to be real.

- Measure the thing that ships, not a proxy. Sizing a carrier by compressing a
  **zero-filled** buffer reported 0.02 MB for 10 MB of input, because PNG
  deflates a run of zeros to nothing and ciphertext is incompressible.
- A failed measurement tells you the configuration failed, **not why**.
  `whatsapp_hd` was clamped from 4096 to 1600 on the strength of one failure,
  annotated as measured fact, and left six times the available capacity unused
  until a device test contradicted it.
- If a test passes, confirm it fails without the change before trusting it.
