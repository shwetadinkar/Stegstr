/**
 * mcp-server.ts — Stegstr as tools an AI agent can call.
 *
 * WHY THIS EXISTS, beyond "the brief asks for agent operability".
 *
 * The agent surface that shipped before this exposed the wrong transport. The
 * Rust CLI implements the legacy PNG dot method, and `skill/stegstr/SKILL.md`
 * documents that method throughout -- so an agent following the documented
 * interface produced images that do not survive WhatsApp, Telegram or
 * Instagram. That is the exact failure the rest of this project exists to fix,
 * reachable through the one interface nobody was testing by hand.
 *
 * This server calls the SHIPPED TypeScript QIM encoder directly -- the same
 * code path the UI uses and the same one every platform measurement in
 * the engineering log was made against. There is deliberately no second implementation
 * to drift out of step: an agent and a human clicking Embed produce byte-for-
 * byte comparable images.
 *
 * Running a browser encoder headless is possible because `node-canvas.ts`
 * provides OffscreenCanvas, ImageData and createImageBitmap on globalThis. It
 * was written so CI could test the real encoder; it turns out to be exactly
 * what an agent needs too.
 *
 * Transport is stdio, which is what MCP clients launch by default.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { webcrypto } from "node:crypto";

import { installCanvasPolyfill } from "./node-canvas";

// Must run before anything imports the encoder, which reaches for
// OffscreenCanvas at call time.
installCanvasPolyfill();
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
}

const { PLATFORM_PROFILES, USER_PLATFORMS, profileFor, DEFAULT_PLATFORM } = await import("./stego-adaptive");
const {
  encodeQimImageFile, decodeQimImageFile, getQimCapacityForFile, qimSelfTest,
} = await import("./stego-qim");
const { encryptOpen, decryptApp, isEncryptedPayload } = await import("./stego-crypto");

// ---------------------------------------------------------------------------

/** Wrap raw file bytes as the File the encoder expects. */
async function fileFrom(path: string): Promise<File> {
  const bytes = await readFile(path);
  return new File([new Uint8Array(bytes)], basename(path), { type: "image/jpeg" });
}

/**
 * Mean absolute Laplacian: how much fine detail a photo carries.
 *
 * Detail is what hides the payload and what lets it survive recompression, and
 * it is not a property anyone would guess at -- a flat cover fails the
 * round-trip outright (the engineering log §10.6). Measured covers ranged from ~9 on a
 * smooth interior shot to ~45 on dense foliage, and the foliage ones passed
 * Instagram first time where the smooth one was marginal.
 */
async function coverDetail(path: string): Promise<{ detail: number; verdict: string }> {
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  const img = await loadImage(await readFile(path));
  const w = Math.min(img.width, 1024);
  const h = Math.round((img.height / img.width) * w);
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const lum = (i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  let sum = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      sum += Math.abs(
        4 * lum(i) - lum(i - 4) - lum(i + 4) - lum(i - w * 4) - lum(i + w * 4),
      );
      n++;
    }
  }
  const detail = n ? sum / n : 0;
  const verdict = detail >= 25
    ? "good — plenty of texture to hide in"
    : detail >= 12
      ? "usable — some flat areas, expect a fainter margin"
      : "poor — largely smooth. Embedding may fail its self-test, and will be more visible if it succeeds. Prefer foliage, fabric, crowds or brickwork.";
  return { detail: Number(detail.toFixed(2)), verdict };
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "stegstr_platforms",
    description:
      "List the platform targets and the geometry each one uses. Every figure comes from " +
      "round-tripping real images through the real service on a phone. Call this before " +
      "embedding if unsure which target to pick: choosing one that does not match how the " +
      "image will be sent is the main reason hidden data is lost.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "stegstr_inspect_cover",
    description:
      "Score a candidate cover photo for how well it can hide data. Detail is what conceals " +
      "the payload and what lets it survive recompression; smooth images (sky, plain walls, " +
      "screenshots, logos) fail. Worth calling before embedding, since a poor cover wastes " +
      "the attempt.",
    inputSchema: {
      type: "object",
      properties: { image_path: { type: "string", description: "Path to the candidate photo." } },
      required: ["image_path"],
    },
  },
  {
    name: "stegstr_capacity",
    description:
      "How many bytes a given cover can carry for a given platform target, with the geometry " +
      "the image will be resized to.",
    inputSchema: {
      type: "object",
      properties: {
        image_path: { type: "string" },
        platform: { type: "string", description: `One of: ${USER_PLATFORMS.join(", ")}` },
      },
      required: ["image_path"],
    },
  },
  {
    name: "stegstr_embed",
    description:
      "Hide a text message inside a photo so it survives being sent through the named " +
      "platform. The payload is encrypted, and the result is verified by decoding it back " +
      "before the file is written — if the cover cannot carry the message reliably, this " +
      "reports failure rather than producing an image that silently loses it.",
    inputSchema: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "Cover photo. Detailed photos work best." },
        message: { type: "string", description: "The text to hide." },
        output_path: { type: "string", description: "Where to write the resulting JPEG." },
        platform: {
          type: "string",
          description:
            `Where the image will be SENT. One of: ${USER_PLATFORMS.join(", ")}. ` +
            `Defaults to "universal", which covers WhatsApp, Twitter and Facebook.`,
        },
      },
      required: ["image_path", "message", "output_path"],
    },
  },
  {
    name: "stegstr_detect",
    description:
      "Extract hidden content from an image. Works on images that have been through a " +
      "platform. Returns the message, or an explanation if the image carries nothing.",
    inputSchema: {
      type: "object",
      properties: { image_path: { type: "string" } },
      required: ["image_path"],
    },
  },
] as const;

// ---------------------------------------------------------------------------

const server = new Server(
  { name: "stegstr", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const a = (req.params.arguments ?? {}) as Record<string, string>;

  try {
    if (name === "stegstr_platforms") {
      const rows = USER_PLATFORMS.filter((k) => k in PLATFORM_PROFILES).map((k) => {
        const p = PLATFORM_PROFILES[k];
        const geom = p.width === 0
          ? "no resize"
          : p.square ? `${p.width}x${p.width} square` : `${p.width}px wide`;
        return `${k}\n    geometry: ${geom}\n    ${p.note}`;
      });
      return ok(
        "Platform targets (geometry measured from real round-trips):\n\n" + rows.join("\n\n") +
        "\n\nPick the target matching how the image will actually be sent. Sending a " +
        "'telegram_photo' image as a file, or vice versa, changes the processing it receives.",
      );
    }

    if (name === "stegstr_inspect_cover") {
      const { detail, verdict } = await coverDetail(resolve(a.image_path));
      return ok(`Cover detail score: ${detail}\nVerdict: ${verdict}`);
    }

    if (name === "stegstr_capacity") {
      const platform = a.platform || DEFAULT_PLATFORM;
      const cap = await getQimCapacityForFile(await fileFrom(resolve(a.image_path)), platform);
      return ok(
        `Capacity for '${platform}': ${cap.capacityBytes} bytes ` +
        `(image resized to ${cap.width}x${cap.height}).`,
      );
    }

    if (name === "stegstr_embed") {
      const platform = a.platform || DEFAULT_PLATFORM;
      if (!(platform in PLATFORM_PROFILES)) {
        return fail(`Unknown platform '${platform}'. Options: ${USER_PLATFORMS.join(", ")}`);
      }
      const inPath = resolve(a.image_path);
      const cover = await fileFrom(inPath);

      const { detail, verdict } = await coverDetail(inPath);
      const payload = await encryptOpen(a.message);
      const cap = await getQimCapacityForFile(cover, platform);
      if (payload.length > cap.capacityBytes) {
        return fail(
          `Message too large for this cover at '${platform}': needs ${payload.length} bytes, ` +
          `capacity is ${cap.capacityBytes}. Use a larger photo, a target with a bigger canvas ` +
          `(telegram_file, or facebook at 2048px), or a shorter message.`,
        );
      }

      const { resizeCoverForPlatform } = await import("./stego-qim");
      const prof = profileFor(platform);
      const resized = await resizeCoverForPlatform(cover, prof.width, prof.square);
      const blob = await encodeQimImageFile(resized, payload, { platform });

      // Decode it back before writing. An image that looks fine and carries
      // nothing is the worst outcome here, because every indicator short of a
      // read-back says success.
      const st = await qimSelfTest(blob, payload);
      if (!st.ok) {
        return fail(
          `Embedded, but the result failed read-back verification (${st.error}), so it was not ` +
          `written. This is almost always the cover: detail score ${detail} (${verdict}). ` +
          `Try a more detailed photo.`,
        );
      }

      // Warn when the output geometry does not match what the platform will
      // produce. coverGeometry only DOWNSCALES -- a cover narrower than the
      // target is left as-is -- so a small photo aimed at telegram_photo goes
      // out under 1280 wide, gets resampled to 1280x960 on arrival, and the
      // payload dies. The self-test cannot catch this because it verifies the
      // image as written, not as the platform will return it.
      let geomWarning = "";
      if (prof.width > 0) {
        const expectW = prof.width;
        const expectH = prof.square ? prof.width : null;
        const mismatch = cap.width !== expectW || (expectH !== null && cap.height !== expectH);
        if (mismatch) {
          geomWarning =
            `\n  WARNING: this cover produced ${cap.width}x${cap.height}, but '${platform}' ` +
            `expects ${expectW}${expectH ? "x" + expectH : "px wide"}. Covers are never upscaled, ` +
            `so a photo smaller than the target keeps its own size. If the platform resizes it on ` +
            `arrival the hidden data will be lost. Use a photo at least ${expectW}px wide.`;
        }
      }

      const outPath = resolve(a.output_path);
      await writeFile(outPath, new Uint8Array(await blob.arrayBuffer()));
      return ok(
        `Hidden ${a.message.length} characters in ${outPath}\n` +
        `  target platform: ${platform} (${cap.width}x${cap.height})${geomWarning}\n` +
        `  payload: ${payload.length} of ${cap.capacityBytes} bytes capacity\n` +
        `  cover detail: ${detail} — ${verdict}\n` +
        `  verified: decoded back successfully before writing\n\n` +
        `Send this file through ${platform}. Do not screenshot or re-save it; that destroys ` +
        `the hidden data.`,
      );
    }

    if (name === "stegstr_detect") {
      const path = resolve(a.image_path);
      const res = await decodeQimImageFile(await fileFrom(path));
      if (!res.ok) {
        return ok(
          `No hidden Stegstr content found in ${basename(path)}.\n` +
          `(${res.error ?? "no payload"})\n\n` +
          `If you expected content: the image may have been resized in transit, screenshotted, ` +
          `or re-saved — any of which destroys it.`,
        );
      }
      const raw = res.payload ?? "";
      const bytes = raw.startsWith("base64:")
        ? Uint8Array.from(atob(raw.slice(7)), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(raw);
      if (!isEncryptedPayload(bytes)) return ok(`Recovered payload:\n\n${raw}`);
      const text = await decryptApp(bytes);
      return ok(`Hidden message recovered from ${basename(path)}:\n\n${text}`);
    }

    return fail(`Unknown tool: ${name}`);
  } catch (e) {
    return fail(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});

await server.connect(new StdioServerTransport());
