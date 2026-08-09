/**
 * canvas-polyfill.ts — run the real browser encoder under Node.
 *
 * stego-qim.ts encodes and decodes JPEG through OffscreenCanvas, so its actual
 * behaviour has never been testable outside a browser. The existing e2e harness
 * says as much: it validates that the permutation matrices are defined and
 * defers the real work to a "semi-manual flow".
 *
 * That is the wrong place for a gap. The encoder is the part of this project
 * most likely to break silently -- a wrong quantization table or an off-by-one
 * in block ordering produces an image that looks fine and decodes to nothing.
 *
 * Providing OffscreenCanvas, ImageData and createImageBitmap on globalThis lets
 * the shipped code path run unmodified in vitest, so embed -> channel -> detect
 * can be asserted in CI rather than checked by hand on a phone.
 */

import { createCanvas, loadImage, ImageData as NapiImageData } from "@napi-rs/canvas";

interface BlobLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

class OffscreenCanvasPolyfill {
  private canvas: ReturnType<typeof createCanvas>;
  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.canvas = createCanvas(width, height);
    this.width = width;
    this.height = height;
  }

  getContext(kind: string) {
    return this.canvas.getContext(kind as "2d");
  }

  async convertToBlob(opts: { type?: string; quality?: number } = {}): Promise<BlobLike> {
    const quality = opts.quality ?? 0.92;
    const buf = opts.type === "image/png"
      ? this.canvas.toBuffer("image/png")
      : this.canvas.toBuffer("image/jpeg", Math.round(quality * 100));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { arrayBuffer: async () => ab as ArrayBuffer };
  }
}

let installed = false;

export function installCanvasPolyfill(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as Record<string, unknown>;
  g.OffscreenCanvas = OffscreenCanvasPolyfill;
  g.ImageData = NapiImageData;
  g.createImageBitmap = async (src: BlobLike) => {
    const ab = await src.arrayBuffer();
    const img = await loadImage(Buffer.from(ab)) as unknown as Record<string, unknown>;
    // Browsers expose ImageBitmap.close(); the encoder calls it to free memory.
    if (typeof img.close !== "function") img.close = () => { /* no-op under Node */ };
    return img;
  };
}

/** Minimal File stand-in: stego-qim only ever reads bytes and name. */
export function makeFile(bytes: Uint8Array, name = "cover.jpg", type = "image/jpeg"): File {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    name,
    type,
    size: bytes.length,
    arrayBuffer: async () => ab as ArrayBuffer,
    slice: () => { throw new Error("not implemented"); },
    stream: () => { throw new Error("not implemented"); },
    text: async () => { throw new Error("not implemented"); },
    lastModified: Date.now(),
    webkitRelativePath: "",
  } as unknown as File;
}

/**
 * Synthesise a cover with both flat and textured regions.
 *
 * Real photographs contain both, and the two behave completely differently:
 * embedding hides in texture and shows on flat walls or sky. A uniformly noisy
 * test image would make the encoder look better than it is.
 */
export function makeCoverJpeg(width: number, height: number, seed = 7): Uint8Array {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Top-left quadrant flat (worst case for visibility), rest textured.
      const flat = x < width / 2 && y < height / 2;
      const base = flat ? 200 : 110 + 60 * Math.sin(x / 40) + 40 * Math.cos(y / 30);
      const noise = flat ? 0 : (rand() - 0.5) * 70;
      const v = Math.max(0, Math.min(255, base + noise));
      img.data[i] = v;
      img.data[i + 1] = Math.max(0, Math.min(255, v * 0.95));
      img.data[i + 2] = Math.max(0, Math.min(255, v * 0.9));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const buf = canvas.toBuffer("image/jpeg", 96);
  return new Uint8Array(buf);
}

/**
 * Simulate a platform: optional resize, then JPEG re-encode.
 *
 * Deliberately approximate. Real WhatsApp uses its own quantization table and
 * real Instagram sharpens; neither is reproducible here, and pretending
 * otherwise is how the upstream channel_simulator ended up passing schemes that
 * fail on a phone. What this DOES catch is the failure mode that matters most
 * in CI: an encoder that cannot survive any recompression at all, or a decoder
 * that has drifted out of step with the encoder.
 */
export async function simulateChannel(
  jpegBytes: Uint8Array,
  opts: { maxWidth?: number; square?: boolean; quality?: number } = {},
): Promise<Uint8Array> {
  const { maxWidth = 0, square = false, quality = 65 } = opts;
  const ab = jpegBytes.buffer.slice(
    jpegBytes.byteOffset, jpegBytes.byteOffset + jpegBytes.byteLength,
  );
  const bitmap = await loadImage(Buffer.from(ab as ArrayBuffer));

  let w = bitmap.width;
  let h = bitmap.height;
  if (square) { w = h = maxWidth || Math.min(w, h); }
  else if (maxWidth > 0 && w > maxWidth) {
    h = Math.round((h * maxWidth) / w);
    w = maxWidth;
  }

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Uint8Array(canvas.toBuffer("image/jpeg", quality));
}
