import { describe, it, expect } from "vitest";
import {
  rgbToYCbCr, ycbcrToRgb, downsampleChromaSuperblock, upsampleChromaSuperblock,
  CHROMA_SUPERBLOCK_PX,
} from "../stego-color";

describe("rgbToYCbCr / ycbcrToRgb", () => {
  it("round-trips arbitrary RGB values", () => {
    const samples: Array<[number, number, number]> = [
      [0, 0, 0], [255, 255, 255], [128, 128, 128],
      [255, 0, 0], [0, 255, 0], [0, 0, 255],
      [37, 200, 91], [12, 12, 250],
    ];
    for (const [r, g, b] of samples) {
      const [y, cb, cr] = rgbToYCbCr(r, g, b);
      const [r2, g2, b2] = ycbcrToRgb(y, cb, cr);
      expect(r2).toBeCloseTo(r, 3);
      expect(g2).toBeCloseTo(g, 3);
      expect(b2).toBeCloseTo(b, 3);
    }
  });

  it("neutral grey has no chroma", () => {
    const [, cb, cr] = rgbToYCbCr(128, 128, 128);
    expect(cb).toBeCloseTo(128, 6);
    expect(cr).toBeCloseTo(128, 6);
  });
});

describe("chroma super-block downsample / upsample", () => {
  const width = 32;
  const height = 32;

  it("downsamples a uniform 16x16 region to a uniform block", () => {
    const plane = new Float64Array(width * height).fill(77);
    const block = downsampleChromaSuperblock(plane, width, 0, 0);
    for (const v of block) expect(v).toBeCloseTo(77, 6);
  });

  it("box-averages a per-pixel-alternating pattern to the midpoint", () => {
    // Alternates every single pixel column, so every 2x2 downsample group
    // (columns [2c, 2c+1]) spans both values -- unlike a period-4 pattern,
    // which would align with group boundaries and stay uniform per group.
    const plane = new Float64Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        plane[y * width + x] = x % 2 === 0 ? 200 : 56;
      }
    }
    const block = downsampleChromaSuperblock(plane, width, 0, 0);
    for (const v of block) expect(v).toBeCloseTo(128, 6);
  });

  it("upsample writes a flat 2x2 tile per downsampled value, round-tripping through downsample", () => {
    const plane = new Float64Array(width * height).fill(128);
    const target = new Float64Array(64);
    for (let i = 0; i < 64; i++) target[i] = 50 + i;
    upsampleChromaSuperblock(plane, width, 0, 0, target);

    // Each written pixel should equal its source value.
    for (let r = 0; r < CHROMA_SUPERBLOCK_PX; r++) {
      for (let c = 0; c < CHROMA_SUPERBLOCK_PX; c++) {
        const expected = target[Math.floor(r / 2) * 8 + Math.floor(c / 2)];
        expect(plane[r * width + c]).toBe(expected);
      }
    }

    // Downsampling the written region recovers exactly what was written --
    // this is the whole point: a flat 2x2 tile survives any local-averaging
    // filter, so we don't need to know the real encoder's exact filter.
    const recovered = downsampleChromaSuperblock(plane, width, 0, 0);
    for (let i = 0; i < 64; i++) expect(recovered[i]).toBeCloseTo(target[i], 6);
  });

  it("does not touch pixels outside the addressed super-block", () => {
    const plane = new Float64Array(width * height).fill(10);
    const target = new Float64Array(64).fill(200);
    upsampleChromaSuperblock(plane, width, 0, 1, target); // second super-block, columns 16-31
    // First super-block (columns 0-15) must be untouched.
    for (let r = 0; r < 16; r++) {
      for (let c = 0; c < 16; c++) {
        expect(plane[r * width + c]).toBe(10);
      }
    }
  });
});
