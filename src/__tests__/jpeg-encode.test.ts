// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { installCanvasPolyfill, makeCoverJpeg } from "../node-canvas";
import {
  encodeJpegWithTable,
  zigzagToRaster,
  INSTAGRAM_LUMA_ZIGZAG,
  INSTAGRAM_CHROMA_ZIGZAG,
} from "../jpeg-encode";

installCanvasPolyfill();

/**
 * A JPEG encoder whose quantization table we choose.
 *
 * Everything else here encodes through canvas.convertToBlob({quality}), which
 * picks its own table. That is the only thing standing between this project and
 * §17.12 — matching a platform's table so its re-encode is a no-op, the same
 * argument as matching its geometry.
 *
 * The measurement that justifies the file, on a real photo at 1440 square,
 * tracking the embedding band through an Instagram-style re-encode:
 *
 *   we quantize at Q75          unchanged  85.9%
 *   we quantize at IG's table   unchanged 100.0%
 */

async function decodeToRGBA(bytes: Uint8Array) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

async function coverPixels(w = 256, h = 192) {
  const bmp = await createImageBitmap(new Blob([makeCoverJpeg(w, h, 7)], { type: "image/jpeg" }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

describe("the encoder produces a real JPEG", () => {
  it("writes SOI and EOI markers", async () => {
    const px = await coverPixels();
    const out = encodeJpegWithTable(px.data, px.width, px.height, {
      lumaQT: zigzagToRaster(INSTAGRAM_LUMA_ZIGZAG),
    });
    expect([out[0], out[1]]).toEqual([0xff, 0xd8]);
    expect([out[out.length - 2], out[out.length - 1]]).toEqual([0xff, 0xd9]);
  });

  it("is decodable by the platform's own JPEG decoder", async () => {
    // The real test of correctness: something that did not write it must be
    // able to read it. A hand-rolled entropy coder that only our code can
    // parse would be useless.
    const px = await coverPixels();
    const out = encodeJpegWithTable(px.data, px.width, px.height, {
      lumaQT: zigzagToRaster(INSTAGRAM_LUMA_ZIGZAG),
      chromaQT: zigzagToRaster(INSTAGRAM_CHROMA_ZIGZAG),
    });
    const back = await decodeToRGBA(out);
    expect(back.width).toBe(px.width);
    expect(back.height).toBe(px.height);
  });

  it("reproduces the image, not noise", async () => {
    const px = await coverPixels();
    const out = encodeJpegWithTable(px.data, px.width, px.height, {
      lumaQT: zigzagToRaster(INSTAGRAM_LUMA_ZIGZAG),
      chromaQT: zigzagToRaster(INSTAGRAM_CHROMA_ZIGZAG),
    });
    const back = await decodeToRGBA(out);

    let sum = 0;
    const n = Math.min(px.data.length, back.data.length);
    for (let i = 0; i < n; i += 4) {
      for (let k = 0; k < 3; k++) sum += Math.abs(px.data[i + k] - back.data[i + k]);
    }
    const mean = sum / ((n / 4) * 3);
    // Instagram's table is a high-quality one, so a faithful encoder should
    // land within a couple of levels per channel. Noise would be ~80.
    expect(mean).toBeLessThan(6);
  });

  it("carries the table it was given, byte for byte", async () => {
    // Read the DQT back out of our own output. If this drifts, the whole
    // premise -- that we control the lattice -- is gone.
    const px = await coverPixels(64, 64);
    const out = encodeJpegWithTable(px.data, px.width, px.height, {
      lumaQT: zigzagToRaster(INSTAGRAM_LUMA_ZIGZAG),
    });
    let i = 2, found: number[] | null = null;
    while (i < out.length - 1) {
      if (out[i] !== 0xff) { i++; continue; }
      const marker = out[i + 1];
      if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
      const len = (out[i + 2] << 8) | out[i + 3];
      if (marker === 0xdb && out[i + 4] === 0x00) {
        found = Array.from(out.slice(i + 5, i + 5 + 64));
        break;
      }
      if (marker === 0xda) break;
      i += 2 + len;
    }
    expect(found).toEqual([...INSTAGRAM_LUMA_ZIGZAG]);
  });

  it("handles dimensions that are not multiples of 8", async () => {
    // Edge blocks replicate the last row and column; the decoder crops by the
    // SOF dimensions.
    const px = await coverPixels(100, 70);
    const out = encodeJpegWithTable(px.data, px.width, px.height, {
      lumaQT: zigzagToRaster(INSTAGRAM_LUMA_ZIGZAG),
    });
    const back = await decodeToRGBA(out);
    expect([back.width, back.height]).toEqual([100, 70]);
  });
});

describe("chroma subsampling", () => {
  /** Read the SOF sampling factors back out of our own output. */
  function sampling(out: Uint8Array): string {
    let i = 2;
    while (i < out.length - 1) {
      if (out[i] !== 0xff) { i++; continue; }
      const m = out[i + 1];
      if (m === 0xd8 || m === 0xd9) { i += 2; continue; }
      const len = (out[i + 2] << 8) | out[i + 3];
      if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
        const n = out[i + 9];
        const f: string[] = [];
        for (let k = 0; k < n; k++) { const v = out[i + 11 + k * 3]; f.push(`${v >> 4}x${v & 15}`); }
        return f.join("/");
      }
      if (m === 0xda) break;
      i += 2 + len;
    }
    return "?";
  }

  it("defaults to 4:2:0, matching Canvas and every platform's output", async () => {
    // §30: our 4:4:4 output was the only remaining difference between a
    // Facebook upload that survived and one that came back empty.
    const px = await coverPixels();
    const out = encodeJpegWithTable(px.data, px.width, px.height, {
      lumaQT: zigzagToRaster(INSTAGRAM_LUMA_ZIGZAG),
    });
    expect(sampling(out)).toBe("2x2/1x1/1x1");
  });

  it("still writes 4:4:4 when asked", async () => {
    const px = await coverPixels();
    const out = encodeJpegWithTable(px.data, px.width, px.height, {
      lumaQT: zigzagToRaster(INSTAGRAM_LUMA_ZIGZAG),
      subsampling: "4:4:4",
    });
    expect(sampling(out)).toBe("1x1/1x1/1x1");
  });

  it("4:2:0 is still decodable and still looks like the image", async () => {
    // The interleave order is fixed by the specification -- four luma blocks,
    // then one Cb, then one Cr. Get it wrong and a decoder reads the blocks in
    // the wrong sequence and produces colour garbage, which this catches.
    const px = await coverPixels();
    const out = encodeJpegWithTable(px.data, px.width, px.height, {
      lumaQT: zigzagToRaster(INSTAGRAM_LUMA_ZIGZAG),
      chromaQT: zigzagToRaster(INSTAGRAM_CHROMA_ZIGZAG),
    });
    const back = await decodeToRGBA(out);
    expect([back.width, back.height]).toEqual([px.width, px.height]);
    let sum = 0;
    const n = Math.min(px.data.length, back.data.length);
    for (let i = 0; i < n; i += 4) {
      for (let k = 0; k < 3; k++) sum += Math.abs(px.data[i + k] - back.data[i + k]);
    }
    expect(sum / ((n / 4) * 3)).toBeLessThan(8);
  });

  it("is smaller than 4:4:4, which is the point of it", async () => {
    const px = await coverPixels(320, 240);
    const qt = zigzagToRaster(INSTAGRAM_LUMA_ZIGZAG);
    const a = encodeJpegWithTable(px.data, px.width, px.height, { lumaQT: qt, subsampling: "4:4:4" });
    const b = encodeJpegWithTable(px.data, px.width, px.height, { lumaQT: qt, subsampling: "4:2:0" });
    expect(b.length).toBeLessThan(a.length);
  });

  it("handles dimensions that are not multiples of 16", async () => {
    // A 4:2:0 MCU is 16x16, so edge MCUs run past the image.
    const px = await coverPixels(100, 70);
    const out = encodeJpegWithTable(px.data, px.width, px.height, {
      lumaQT: zigzagToRaster(INSTAGRAM_LUMA_ZIGZAG),
    });
    const back = await decodeToRGBA(out);
    expect([back.width, back.height]).toEqual([100, 70]);
  });
});

describe("the table it exists for", () => {
  it("holds Instagram's real table, as extracted from its own output", () => {
    // Provenance matters: this came out of images Instagram returned, and was
    // byte-identical across all of them. A table that varied per upload could
    // not be matched and the idea would be dead.
    expect(INSTAGRAM_LUMA_ZIGZAG).toHaveLength(64);
    expect(INSTAGRAM_CHROMA_ZIGZAG).toHaveLength(64);
    expect(INSTAGRAM_LUMA_ZIGZAG[0]).toBe(5);
    expect(Math.max(...INSTAGRAM_LUMA_ZIGZAG)).toBe(25);
  });

  it("converts zigzag to raster correctly", () => {
    const r = zigzagToRaster(INSTAGRAM_LUMA_ZIGZAG);
    expect(r[0]).toBe(INSTAGRAM_LUMA_ZIGZAG[0]); // DC is first in both orders
    expect(r[1]).toBe(INSTAGRAM_LUMA_ZIGZAG[1]); // (0,1) is zigzag index 1
    expect(r[8]).toBe(INSTAGRAM_LUMA_ZIGZAG[2]); // (1,0) is zigzag index 2
    expect(r).toHaveLength(64);
  });
});
