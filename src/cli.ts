/**
 * cli.ts — Stegstr's QIM encoder as a command-line tool.
 *
 * WHY THIS EXISTS.
 *
 * The only command-line interface that shipped before this was `stegstr-cli`,
 * the Rust binary implementing the legacy PNG dot method. That method does not
 * survive chat apps: WhatsApp, Telegram-as-photo, Instagram, Facebook and X all
 * re-encode uploads to JPEG, and JPEG quantisation discards exactly the
 * wavelet detail those bits live in. So anything driving Stegstr from a script
 * -- a test harness, CI, an evaluator -- reached the one encoder this project
 * exists to replace, and would measure it failing every channel.
 *
 * This calls the SHIPPED TypeScript QIM encoder: the same code path the UI
 * uses, the same one the MCP server uses, and the same one every platform
 * measurement was made against. There is deliberately no second implementation
 * to drift out of step.
 *
 * Running a browser encoder headless works because node-canvas.ts supplies
 * OffscreenCanvas, ImageData and createImageBitmap on globalThis.
 *
 * DESIGNED TO BE DRIVEN BY A MACHINE. Every subcommand takes --json and
 * returns a structured object on stdout; human-readable text goes to stderr so
 * the two never interleave. Exit codes are distinct per failure mode so a
 * harness can branch on them without parsing prose:
 *
 *   0  success
 *   1  usage or unexpected error
 *   2  payload exceeds capacity for that platform
 *   3  embed succeeded but failed read-back verification
 *   4  detect found no Stegstr payload
 *
 * The distinction between 2, 3 and 4 matters. "Too large", "written but
 * unverifiable" and "nothing there" are different results, and collapsing them
 * into a single non-zero exit is how a harness ends up reporting a capacity
 * limit as a codec failure.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { webcrypto } from "node:crypto";

import { installCanvasPolyfill } from "./node-canvas";

// Must run before anything imports the encoder.
installCanvasPolyfill();
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
}

const { PLATFORM_PROFILES, USER_PLATFORMS, profileFor, DEFAULT_PLATFORM } = await import("./stego-adaptive");
const {
  encodeQimImageFile, decodeQimImageFile, getQimCapacityForFile, qimSelfTest,
  resizeCoverForPlatform,
} = await import("./stego-qim");
const { encryptOpen, decryptApp, isEncryptedPayload } = await import("./stego-crypto");

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        out[a.slice(2)] = argv[++i];
      } else {
        out[a.slice(2)] = true;
      }
    } else {
      (out._ as string[]).push(a);
    }
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));
const cmd = (argv._ as string[])[0];
const asJson = argv.json === true;

/**
 * Route library chatter to stderr.
 *
 * stego-crypto logs its magic bytes and IV through console.log, which in Node
 * writes to stdout. That contaminates --json output: a caller doing
 * JSON.parse(stdout) gets a syntax error and reports a failure that never
 * happened. stdout belongs to the result; everything else goes to stderr.
 */
{
  const toErr = (...a: unknown[]) =>
    process.stderr.write(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
  console.log = toErr as typeof console.log;
  console.info = toErr as typeof console.info;
  console.debug = toErr as typeof console.debug;
}

/** Human output goes to stderr so --json stdout stays parseable. */
const say = (s: string) => process.stderr.write(s + "\n");

function emit(obj: Record<string, unknown>, human: string, code = 0): never {
  if (asJson) process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  else say(human);
  process.exit(code);
}

function die(message: string, code = 1, extra: Record<string, unknown> = {}): never {
  emit({ ok: false, error: message, ...extra }, `error: ${message}`, code);
}

function str(name: string, fallback?: string): string {
  const v = argv[name];
  if (typeof v === "string") return v;
  if (fallback !== undefined) return fallback;
  return die(`missing required --${name}`);
}

async function fileFrom(path: string): Promise<File> {
  const bytes = await readFile(path);
  return new File([new Uint8Array(bytes)], basename(path), { type: "image/jpeg" });
}

/**
 * Resolve the payload.
 *
 * --raw embeds bytes verbatim with no encryption. That is what a survival test
 * wants: embed known bytes, put the image through a channel, recover, compare.
 * Encryption in the loop only adds a way for the comparison to fail for
 * reasons unrelated to the channel.
 */
async function resolvePayload(): Promise<{ bytes: Uint8Array; raw: boolean }> {
  const raw = argv.raw === true;
  if (typeof argv["payload-file"] === "string") {
    const bytes = new Uint8Array(await readFile(resolve(argv["payload-file"] as string)));
    return { bytes: raw ? bytes : await encryptOpen(new TextDecoder().decode(bytes)), raw };
  }
  if (typeof argv.message === "string") {
    const msg = argv.message as string;
    return { bytes: raw ? new TextEncoder().encode(msg) : await encryptOpen(msg), raw };
  }
  return die("provide --message <text> or --payload-file <path>");
}

// ---------------------------------------------------------------------------

const USAGE = `stegstr — hide data in photos so it survives chat apps

  stegstr platforms [--json]
  stegstr capacity --in <cover> [--platform <name>] [--json]
  stegstr resize   --in <cover> --out <file> [--platform <name>] [--json]
  stegstr embed    --in <cover> --out <file> (--message <text> | --payload-file <path>)
                   [--platform <name>] [--raw] [--no-verify] [--json]
  stegstr detect   --in <image> [--out <file>] [--raw] [--json]

Platforms: ${USER_PLATFORMS.join(", ")}
Default:   ${DEFAULT_PLATFORM}  (used when --platform is omitted)

  --raw         embed/extract bytes verbatim, no encryption (for round-trip tests)
  --no-verify   skip decoding the result back before writing (not recommended)
  --json        machine-readable output on stdout

Exit codes: 0 ok · 1 error · 2 payload too large · 3 verification failed · 4 nothing found

The platform target must match how the image will actually be SENT. Choosing
wrong is the main reason hidden data is lost: if a platform resizes the image,
the 8x8 DCT grid moves and the payload is destroyed rather than degraded.`;

// ---------------------------------------------------------------------------

try {
  if (!cmd || cmd === "help" || argv.help === true) {
    say(USAGE);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === "platforms") {
    const rows = USER_PLATFORMS.filter((k) => k in PLATFORM_PROFILES).map((k) => {
      const p = PLATFORM_PROFILES[k];
      return {
        platform: k,
        width: p.width,
        square: p.square,
        geometry: p.width === 0
          ? "no resize"
          : p.square ? `${p.width}x${p.width}` : `${p.width}px long edge`,
        note: p.note,
      };
    });
    emit(
      { ok: true, platforms: rows },
      rows.map((r) => `${r.platform}\n    ${r.geometry}\n    ${r.note}`).join("\n\n"),
    );
  }

  if (cmd === "capacity") {
    const platform = str("platform", DEFAULT_PLATFORM);
    if (!(platform in PLATFORM_PROFILES)) die(`unknown platform '${platform}'`);
    const cap = await getQimCapacityForFile(await fileFrom(resolve(str("in"))), platform);
    emit(
      {
        ok: true, platform,
        capacityBytes: cap.capacityBytes,
        width: cap.width, height: cap.height,
      },
      `capacity ${cap.capacityBytes} bytes for '${platform}' (${cap.width}x${cap.height})`,
    );
  }

  /**
   * Write the cover through the platform's resize with NOTHING embedded.
   *
   * This is the honest baseline for an invisibility measurement. Comparing a
   * stego image against the original full-size cover measures resampling and
   * JPEG loss as well as embedding, and resampling dominates -- a 4096px cover
   * against a 1600px stego reports ~37 dB when the embedding itself is far
   * quieter than that. Comparing against this baseline isolates the
   * perturbation the encoder is actually responsible for.
   */
  if (cmd === "resize") {
    const platform = str("platform", DEFAULT_PLATFORM);
    if (!(platform in PLATFORM_PROFILES)) die(`unknown platform '${platform}'`);
    const prof = profileFor(platform);
    const resized = await resizeCoverForPlatform(
      await fileFrom(resolve(str("in"))), prof.width, prof.square,
    );
    const outPath = resolve(str("out"));
    await writeFile(outPath, new Uint8Array(await resized.arrayBuffer()));
    const bmp = await createImageBitmap(resized);
    const [w, h] = [bmp.width, bmp.height];
    bmp.close?.();
    emit(
      { ok: true, output: outPath, platform, width: w, height: h },
      `wrote ${outPath} (${w}x${h}, no payload) — baseline for invisibility comparison`,
    );
  }

  if (cmd === "embed") {
    const platform = str("platform", DEFAULT_PLATFORM);
    if (!(platform in PLATFORM_PROFILES)) {
      die(`unknown platform '${platform}'. Options: ${USER_PLATFORMS.join(", ")}`);
    }
    const inPath = resolve(str("in"));
    const outPath = resolve(str("out"));
    const cover = await fileFrom(inPath);
    const { bytes: payload, raw } = await resolvePayload();

    const cap = await getQimCapacityForFile(cover, platform);
    if (payload.length > cap.capacityBytes) {
      die(
        `payload ${payload.length} bytes exceeds capacity ${cap.capacityBytes} for '${platform}'`,
        2,
        { payloadBytes: payload.length, capacityBytes: cap.capacityBytes, platform },
      );
    }

    const prof = profileFor(platform);
    const resized = await resizeCoverForPlatform(cover, prof.width, prof.square);
    const blob = await encodeQimImageFile(resized, payload, { platform });

    // Read the payload back out before writing. An image that looks fine and
    // carries nothing is the worst outcome, because every indicator short of a
    // read-back reports success.
    let verified = false;
    if (argv["no-verify"] !== true) {
      const st = await qimSelfTest(blob, payload);
      if (!st.ok) {
        die(
          `embedded but failed read-back verification: ${st.error ?? "unknown"}. ` +
          `Usually the cover — try a more detailed photo.`,
          3,
          { platform, payloadBytes: payload.length },
        );
      }
      verified = true;
    }

    // Covers are never upscaled, so a photo narrower than the target keeps its
    // own size, gets resampled on arrival, and the payload dies. The self-test
    // cannot catch this: it verifies the image as written, not as the platform
    // will return it.
    // The profile's `width` is a cap on the LONG EDGE, not on the width. A
    // portrait cover correctly comes out 896x1600 for a 1600 profile, and
    // comparing against width alone reported that as a failure -- a false
    // alarm on a perfectly good image, which is worse than no warning at all.
    let warning: string | null = null;
    if (prof.width > 0) {
      const longEdge = Math.max(cap.width, cap.height);
      const bad = prof.square
        ? cap.width !== prof.width || cap.height !== prof.width
        : longEdge < prof.width;
      if (bad) {
        warning =
          `cover produced ${cap.width}x${cap.height}, short of what '${platform}' expects ` +
          `(${prof.square ? `${prof.width}x${prof.width}` : `${prof.width}px long edge`}). ` +
          `Covers are never upscaled, so the platform will resize this on arrival and the ` +
          `payload will be lost. Use a photo at least ${prof.width}px on its long edge.`;
      }
    }

    await writeFile(outPath, new Uint8Array(await blob.arrayBuffer()));
    emit(
      {
        ok: true, output: outPath, platform, encrypted: !raw, verified,
        payloadBytes: payload.length, capacityBytes: cap.capacityBytes,
        width: cap.width, height: cap.height, warning,
      },
      `wrote ${outPath}\n` +
      `  platform ${platform} (${cap.width}x${cap.height})\n` +
      `  payload ${payload.length} of ${cap.capacityBytes} bytes` +
      (raw ? " (raw, unencrypted)" : " (encrypted)") +
      (verified ? "\n  verified: decoded back before writing" : "") +
      (warning ? `\n  WARNING: ${warning}` : ""),
    );
  }

  if (cmd === "detect") {
    const inPath = resolve(str("in"));
    const res = await decodeQimImageFile(await fileFrom(inPath));
    if (!res.ok) {
      die(
        `no Stegstr payload in ${basename(inPath)} (${res.error ?? "no payload"}). ` +
        `The image may have been resized, screenshotted or re-saved in transit.`,
        4,
        { input: inPath },
      );
    }

    const rawStr = res.payload ?? "";
    const bytes = rawStr.startsWith("base64:")
      ? Uint8Array.from(atob(rawStr.slice(7)), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(rawStr);

    let text: string | null = null;
    let encrypted = false;
    if (argv.raw !== true && isEncryptedPayload(bytes)) {
      encrypted = true;
      text = await decryptApp(bytes);
    }

    if (typeof argv.out === "string") {
      const outPath = resolve(argv.out as string);
      await writeFile(outPath, text !== null ? new TextEncoder().encode(text) : bytes);
      emit(
        { ok: true, output: outPath, bytes: bytes.length, encrypted },
        `recovered ${bytes.length} bytes -> ${outPath}`,
      );
    }

    emit(
      { ok: true, bytes: bytes.length, encrypted, payload: text ?? rawStr },
      text ?? rawStr,
    );
  }

  die(`unknown command '${cmd}'. Run 'stegstr help'.`);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
