import { describe, it, expect, beforeAll } from "vitest";
import { installCanvasPolyfill, makeCoverJpeg, simulateChannel, makeFile } from "../node-canvas";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { ycbcrToRgb } from "../stego-color";

installCanvasPolyfill();

let embedQim: typeof import("../stego-qim").embedQim;
let detectQim: typeof import("../stego-qim").detectQim;
let encodeQimImageFile: typeof import("../stego-qim").encodeQimImageFile;
let decodeQimImageFile: typeof import("../stego-qim").decodeQimImageFile;
let PROFILES: typeof import("../stego-adaptive").PLATFORM_PROFILES;

beforeAll(async () => {
  const mod = await import("../stego-qim");
  embedQim = mod.embedQim;
  detectQim = mod.detectQim;
  encodeQimImageFile = mod.encodeQimImageFile;
  decodeQimImageFile = mod.decodeQimImageFile;
  PROFILES = (await import("../stego-adaptive")).PLATFORM_PROFILES;
});

const payload = (n: number, seed = 1) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 37 + seed) & 0xff;
  return b;
};

/**
 * High-entropy payload (mulberry32 PRNG) for tests that need embedded bit
 * count to scale predictably with byte count. The `payload()` helper above
 * has period 256 (i*37+seed mod 256 cycles), which deflate compresses away
 * for larger sizes -- fine for plain round-trip tests, misleading for
 * anything measuring capacity thresholds.
 */
const randomPayload = (n: number, seed = 1) => {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(next() * 256);
  return b;
};

const same = (a: Uint8Array | null, b: Uint8Array) =>
  a !== null && a.length === b.length && a.every((v, i) => v === b[i]);

async function decodeRgba(bytes: Uint8Array): Promise<{ data: Buffer; width: number; height: number }> {
  const img = await loadImage(Buffer.from(bytes));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const out = ctx.getImageData(0, 0, img.width, img.height);
  return { data: Buffer.from(out.data.buffer, out.data.byteOffset, out.data.byteLength), width: img.width, height: img.height };
}

/** Mean absolute difference of the Y (luma) channel between two same-size RGBA buffers. */
function meanYDiff(a: Buffer, b: Buffer, width: number, height: number): number {
  let sum = 0;
  for (let i = 0; i < width * height; i++) {
    const ya = 0.299 * a[i * 4] + 0.587 * a[i * 4 + 1] + 0.114 * a[i * 4 + 2];
    const yb = 0.299 * b[i * 4] + 0.587 * b[i * 4 + 1] + 0.114 * b[i * 4 + 2];
    sum += Math.abs(ya - yb);
  }
  return sum / (width * height);
}

describe("chroma subsampling guard (real encoder)", () => {
  it("a flat-2x2-tile chroma value survives real JPEG encoding at 16x16 super-block granularity", async () => {
    // Guards against @napi-rs/canvas silently changing its chroma
    // subsampling filter/ratio -- the whole chroma embedding design (§10.4)
    // depends on 2x2 box-style subsampling, verified empirically when this
    // feature was built.
    const width = 64;
    const height = 64;
    const superBlocksPerRow = width / 16;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(width, height);
    const cbFor = (sbRow: number, sbCol: number) => 60 + ((sbRow * superBlocksPerRow + sbCol) * 23) % 150;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sbRow = Math.floor(y / 16);
        const sbCol = Math.floor(x / 16);
        const cb = cbFor(sbRow, sbCol);
        const [r, g, b] = ycbcrToRgb(128, cb, 128);
        const i = (y * width + x) * 4;
        img.data[i] = Math.max(0, Math.min(255, Math.round(r)));
        img.data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
        img.data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const jpeg = canvas.toBuffer("image/jpeg", 90);

    const { data } = await decodeRgba(new Uint8Array(jpeg));

    // Sample the centre pixel of each super-block; it should be close to the
    // super-block's intended Cb value (blue-channel proxy, since Y=Cr=128
    // constant), not smeared toward a neighbour's value.
    for (let sbRow = 0; sbRow < height / 16; sbRow++) {
      for (let sbCol = 0; sbCol < superBlocksPerRow; sbCol++) {
        const [, , expectedB] = ycbcrToRgb(128, cbFor(sbRow, sbCol), 128);
        const py = sbRow * 16 + 8;
        const px = sbCol * 16 + 8;
        const actualB = data[(py * width + px) * 4 + 2];
        expect(Math.abs(actualB - expectedB)).toBeLessThan(20);
      }
    }
  });
});

describe("chroma-channel embedding, scalar-per-block (§11 second addendum)", () => {
  it("round-trips a payload through a chroma-enabled profile via the real encoder", async () => {
    const cover = makeCoverJpeg(1440, 1440, 5);
    const p = payload(150);
    const prof = PROFILES.instagram_chroma_d28;
    const stego = await embedQim(cover, p, {
      delta: prof.delta, chromaDelta: prof.chromaDelta, chromaChannels: prof.chromaChannels,
    });
    const received = await simulateChannel(stego, { quality: 80 });
    const out = await detectQim(received, {
      delta: prof.delta, chromaDelta: prof.chromaDelta, chromaChannels: prof.chromaChannels,
    });
    expect(same(out, p)).toBe(true);
  }, 120000);

  it("round-trips a payload using real (non-periodic) entropy, not just the simple test pattern", async () => {
    // The bug this redesign fixes was invisible to a small periodic payload
    // and only showed up with a payload big enough to actually populate
    // every AC position in a block. The scalar scheme has no AC positions
    // left to hide a similar blind spot in, but keep a high-entropy payload
    // here anyway so this test doesn't quietly regress to the same mistake.
    const cover = makeCoverJpeg(1440, 1440, 21);
    const p = randomPayload(150, 21);
    const prof = PROFILES.instagram_chroma_d28;
    const stego = await embedQim(cover, p, {
      delta: prof.delta, chromaDelta: prof.chromaDelta, chromaChannels: prof.chromaChannels,
    });
    const out = await detectQim(stego, {
      delta: prof.delta, chromaDelta: prof.chromaDelta, chromaChannels: prof.chromaChannels,
    });
    expect(same(out, p)).toBe(true);
  }, 120000);

  it("file-level API resolves chroma settings from the platform profile", async () => {
    const cover = makeFile(makeCoverJpeg(1440, 1440, 6));
    const text = new TextEncoder().encode(JSON.stringify({ hello: "chroma" }));
    const blob = await encodeQimImageFile(cover, text, { platform: "instagram_chroma_d28" });
    const stego = new Uint8Array(await blob.arrayBuffer());
    const out = await decodeQimImageFile(makeFile(stego));
    expect(out.ok).toBe(true);
  }, 120000);

  it("chroma-first allocation: a small payload leaves luma far quieter than a luma-only embed", async () => {
    // The actual invisibility win this feature exists to deliver: a payload
    // that fits in chroma capacity should barely touch the luma channel,
    // unlike an equivalent luma-only embed at the same step size. Sized
    // close to chroma's actual ceiling (~16200 raw bits, 1 bit/block/channel
    // at 1440x1440) rather than tiny, so the luma-only baseline touches
    // enough blocks to produce a signal above JPEG generation-loss noise.
    //
    // A plain re-encode (zero embedding, same cover, same quality) already
    // has non-zero mean Y diff -- JPEG generation loss alone. That baseline
    // dominates both raw measurements (~5.6 out of ~6.7 and ~7.8 here), so
    // the comparison has to subtract it out to see the embedding-specific
    // signal cleanly, rather than comparing raw totals.
    const cover = makeCoverJpeg(1440, 1440, 9);
    const p = randomPayload(250, 9);
    const prof = PROFILES.instagram_chroma_d28;

    const chromaStego = await embedQim(cover, p, {
      delta: prof.delta, chromaDelta: prof.chromaDelta, chromaChannels: prof.chromaChannels,
    });
    const lumaOnlyStego = await embedQim(cover, p, { delta: prof.delta });
    const zeroEmbedBaseline = await embedQim(cover, new Uint8Array(0), { delta: prof.delta, compress: false });

    const { data: coverPixels, width, height } = await decodeRgba(cover);
    const { data: chromaPixels } = await decodeRgba(chromaStego);
    const { data: lumaPixels } = await decodeRgba(lumaOnlyStego);
    const { data: baselinePixels } = await decodeRgba(zeroEmbedBaseline);

    const baselineYDiff = meanYDiff(coverPixels, baselinePixels, width, height);
    const chromaSignal = meanYDiff(coverPixels, chromaPixels, width, height) - baselineYDiff;
    const lumaSignal = meanYDiff(coverPixels, lumaPixels, width, height) - baselineYDiff;

    expect(chromaSignal).toBeLessThan(lumaSignal * 0.75);
  }, 120000);

  it("round-trips a payload large enough to overflow chroma capacity into luma", async () => {
    // This is the exact scenario that broke the previous DCT-AC design: a
    // payload big enough to span both channels and spill into luma. Chroma
    // capacity here is ~16200 raw bits (~330 bytes after repeat+RS
    // overhead), so 1000 bytes guarantees overflow.
    const cover = makeCoverJpeg(1440, 1440, 13);
    const p = randomPayload(1000, 13);
    const prof = PROFILES.instagram_chroma_d28;
    const stego = await embedQim(cover, p, {
      delta: prof.delta, chromaDelta: prof.chromaDelta, chromaChannels: prof.chromaChannels,
    });
    const out = await detectQim(stego, {
      delta: prof.delta, chromaDelta: prof.chromaDelta, chromaChannels: prof.chromaChannels,
    });
    expect(same(out, p)).toBe(true);
  }, 120000);

  it("chroma-disabled profiles are unaffected: omitting chromaDelta behaves exactly like before", async () => {
    const cover = makeCoverJpeg(800, 600, 3);
    const p = payload(96, 2);
    const delta = PROFILES.whatsapp_standard.delta;
    const withoutChroma = await embedQim(cover, p, { delta });
    const explicitEmptyChroma = await embedQim(cover, p, { delta, chromaChannels: [] });
    expect(withoutChroma).toEqual(explicitEmptyChroma);
    expect(same(await detectQim(withoutChroma, { delta }), p)).toBe(true);
  }, 60000);
});
