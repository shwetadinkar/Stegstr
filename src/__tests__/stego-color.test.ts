import { describe, it, expect } from "vitest";
import {
  rgbToYCbCr, ycbcrToRgb, readChromaSuperblockScalar, shiftChromaSuperblock,
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

describe("chroma super-block scalar read / write", () => {
  const width = 32;
  const height = 32;

  it("reads a uniform 16x16 region as its own value", () => {
    const plane = new Float64Array(width * height).fill(77);
    expect(readChromaSuperblockScalar(plane, width, 0, 0)).toBeCloseTo(77, 6);
  });

  it("shift is additive and uniform across the whole 16x16 block, preserving relative structure", () => {
    const plane = new Float64Array(width * height);
    for (let r = 0; r < CHROMA_SUPERBLOCK_PX; r++) {
      for (let c = 0; c < CHROMA_SUPERBLOCK_PX; c++) plane[r * width + c] = 50 + (r + c);
    }
    const before = plane.slice();
    shiftChromaSuperblock(plane, width, 0, 0, 25);
    for (let r = 0; r < CHROMA_SUPERBLOCK_PX; r++) {
      for (let c = 0; c < CHROMA_SUPERBLOCK_PX; c++) {
        expect(plane[r * width + c]).toBe(before[r * width + c] + 25);
      }
    }
  });

  it("read/write round-trips exactly for a flat block", () => {
    const plane = new Float64Array(width * height).fill(0);
    shiftChromaSuperblock(plane, width, 0, 0, 173);
    expect(readChromaSuperblockScalar(plane, width, 0, 0)).toBeCloseTo(173, 6);
  });

  it("shift clamps to [0,255]", () => {
    const plane = new Float64Array(width * height).fill(240);
    shiftChromaSuperblock(plane, width, 0, 0, 50);
    expect(readChromaSuperblockScalar(plane, width, 0, 0)).toBeCloseTo(255, 6);
  });

  it("read averages only the safe interior, ignoring edge contamination", () => {
    // Simulates the real failure mode this design works around: the outer
    // ring of a super-block can be smeared toward a neighbour's value by
    // the JPEG decoder's chroma upsampling. The interior-only read should
    // still recover the true value even if the edges are corrupted.
    const plane = new Float64Array(width * height).fill(200);
    // Corrupt a 2px ring around the edge of super-block (0,0), as observed
    // empirically from real decoder output.
    for (let r = 0; r < CHROMA_SUPERBLOCK_PX; r++) {
      for (let c = 0; c < CHROMA_SUPERBLOCK_PX; c++) {
        const onEdge = r < 2 || r >= 14 || c < 2 || c >= 14;
        if (onEdge) plane[r * width + c] = 0; // wildly different neighbour value
      }
    }
    expect(readChromaSuperblockScalar(plane, width, 0, 0)).toBeCloseTo(200, 6);
  });

  it("shift does not touch pixels outside the addressed super-block", () => {
    const plane = new Float64Array(width * height).fill(10);
    shiftChromaSuperblock(plane, width, 0, 1, 190); // second super-block, columns 16-31
    // First super-block (columns 0-15) must be untouched.
    for (let r = 0; r < 16; r++) {
      for (let c = 0; c < 16; c++) {
        expect(plane[r * width + c]).toBe(10);
      }
    }
  });
});
