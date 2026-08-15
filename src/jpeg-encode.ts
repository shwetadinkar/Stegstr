/**
 * jpeg-encode.ts — a baseline JPEG encoder we control the quantization table of.
 *
 * WHY THIS EXISTS. Everything else in this project encodes JPEG through
 * `canvas.convertToBlob({ quality })`, which takes a quality *number* and
 * chooses its own quantization table. That is the one thing standing between
 * this app and its largest remaining idea (§17.12).
 *
 * THE IDEA, and the measurement behind it. Matching a platform's output
 * geometry makes its resize a no-op — that is the finding the whole encoder
 * rests on. The same argument applies one level down: if the coefficients are
 * already quantized on the platform's own lattice, its re-quantization has
 * nothing to change either.
 *
 * Measured on a real photo at 1440 square, tracking the embedding band
 * (zigzag 1-6) through an Instagram-style re-encode:
 *
 *   we quantize at Q75          unchanged 85.9%   off-by-one 14.1%
 *   we quantize at IG's table   unchanged 100.0%  off-by-one  0.0%
 *
 * Instagram's table was extracted from its own returned files
 * (`calibration/ig_back/*.jpg`) and is byte-identical across all of them.
 *
 * SCOPE. Baseline sequential, 4:4:4, standard Annex K Huffman tables. No
 * progressive mode and no subsampling: both would complicate the decoder for
 * no benefit here, and 4:4:4 leaves chroma untouched for the profiles that use
 * it. This is deliberately the smallest encoder that can carry a chosen
 * quantization table, not a general-purpose one.
 */

import { ZIGZAG_2D, forwardDCT8x8, quantize } from "./dct";

/** Standard Annex K Huffman tables. Universally supported; no reason to tune. */
const STD_DC_LUMA_BITS = [0,0,1,5,1,1,1,1,1,1,0,0,0,0,0,0,0];
const STD_DC_LUMA_VALS = [0,1,2,3,4,5,6,7,8,9,10,11];
const STD_AC_LUMA_BITS = [0,0,2,1,3,3,2,4,3,5,5,4,4,0,0,1,0x7d];
const STD_AC_LUMA_VALS = [
  0x01,0x02,0x03,0x00,0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,
  0x22,0x71,0x14,0x32,0x81,0x91,0xa1,0x08,0x23,0x42,0xb1,0xc1,0x15,0x52,0xd1,0xf0,
  0x24,0x33,0x62,0x72,0x82,0x09,0x0a,0x16,0x17,0x18,0x19,0x1a,0x25,0x26,0x27,0x28,
  0x29,0x2a,0x34,0x35,0x36,0x37,0x38,0x39,0x3a,0x43,0x44,0x45,0x46,0x47,0x48,0x49,
  0x4a,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5a,0x63,0x64,0x65,0x66,0x67,0x68,0x69,
  0x6a,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7a,0x83,0x84,0x85,0x86,0x87,0x88,0x89,
  0x8a,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,
  0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xc2,0xc3,0xc4,0xc5,
  0xc6,0xc7,0xc8,0xc9,0xca,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0xda,0xe1,0xe2,
  0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,
  0xf9,0xfa,
];
const STD_DC_CHROMA_BITS = [0,0,3,1,1,1,1,1,1,1,1,1,0,0,0,0,0];
const STD_DC_CHROMA_VALS = [0,1,2,3,4,5,6,7,8,9,10,11];
const STD_AC_CHROMA_BITS = [0,0,2,1,2,4,4,3,4,7,5,4,4,0,1,2,0x77];
const STD_AC_CHROMA_VALS = [
  0x00,0x01,0x02,0x03,0x11,0x04,0x05,0x21,0x31,0x06,0x12,0x41,0x51,0x07,0x61,0x71,
  0x13,0x22,0x32,0x81,0x08,0x14,0x42,0x91,0xa1,0xb1,0xc1,0x09,0x23,0x33,0x52,0xf0,
  0x15,0x62,0x72,0xd1,0x0a,0x16,0x24,0x34,0xe1,0x25,0xf1,0x17,0x18,0x19,0x1a,0x26,
  0x27,0x28,0x29,0x2a,0x35,0x36,0x37,0x38,0x39,0x3a,0x43,0x44,0x45,0x46,0x47,0x48,
  0x49,0x4a,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5a,0x63,0x64,0x65,0x66,0x67,0x68,
  0x69,0x6a,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7a,0x82,0x83,0x84,0x85,0x86,0x87,
  0x88,0x89,0x8a,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,
  0xa6,0xa7,0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xc2,0xc3,
  0xc4,0xc5,0xc6,0xc7,0xc8,0xc9,0xca,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0xda,
  0xe2,0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,
  0xf9,0xfa,
];

interface HuffTable {
  /** code[value] and size[value], indexed by the symbol byte. */
  code: Uint16Array;
  size: Uint8Array;
}

function buildHuff(bits: number[], vals: number[]): HuffTable {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let k = 0, c = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len]; i++) {
      code[vals[k]] = c;
      size[vals[k]] = len;
      c++; k++;
    }
    c <<= 1;
  }
  return { code, size };
}

const DC_LUMA = buildHuff(STD_DC_LUMA_BITS, STD_DC_LUMA_VALS);
const AC_LUMA = buildHuff(STD_AC_LUMA_BITS, STD_AC_LUMA_VALS);
const DC_CHROMA = buildHuff(STD_DC_CHROMA_BITS, STD_DC_CHROMA_VALS);
const AC_CHROMA = buildHuff(STD_AC_CHROMA_BITS, STD_AC_CHROMA_VALS);

/** Byte sink with JPEG's 0xFF stuffing rule applied to entropy-coded data. */
class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private nbits = 0;

  byte(b: number) { this.bytes.push(b & 0xff); }
  word(w: number) { this.byte(w >> 8); this.byte(w); }
  raw(arr: number[]) { for (const b of arr) this.byte(b); }

  bits(value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      this.nbits++;
      if (this.nbits === 8) {
        const b = this.acc & 0xff;
        this.bytes.push(b);
        // A 0xFF in entropy-coded data must be followed by 0x00, or a decoder
        // reads it as a marker.
        if (b === 0xff) this.bytes.push(0x00);
        this.acc = 0; this.nbits = 0;
      }
    }
  }

  /** Pad the final partial byte with 1s, as the specification requires. */
  flushBits() {
    while (this.nbits !== 0) this.bits(1, 1);
  }

  result(): Uint8Array { return Uint8Array.from(this.bytes); }
}

/** Number of bits needed to represent v, and its JPEG-coded value. */
function magnitude(v: number): { size: number; bits: number } {
  const a = Math.abs(v);
  let size = 0;
  while (size < 16 && a >= (1 << size)) size++;
  // Negative values are coded as the one's complement of their magnitude.
  return { size, bits: v < 0 ? v + (1 << size) - 1 : v };
}

function writeBlock(
  w: BitWriter,
  q: Float64Array,
  prevDC: number,
  dcT: HuffTable,
  acT: HuffTable,
): number {
  // Zigzag the block once.
  const zz = new Int32Array(64);
  for (let z = 0; z < 64; z++) {
    const [dy, dx] = ZIGZAG_2D[z];
    zz[z] = Math.round(q[dy * 8 + dx]);
  }

  // DC: differential against the previous block of the same component.
  const diff = zz[0] - prevDC;
  if (diff === 0) {
    w.bits(dcT.code[0], dcT.size[0]);
  } else {
    const { size, bits } = magnitude(diff);
    w.bits(dcT.code[size], dcT.size[size]);
    w.bits(bits, size);
  }

  // AC: run-length of zeros, then the magnitude category.
  let end = 63;
  while (end > 0 && zz[end] === 0) end--;
  let run = 0;
  for (let z = 1; z <= end; z++) {
    if (zz[z] === 0) { run++; continue; }
    while (run > 15) { w.bits(acT.code[0xf0], acT.size[0xf0]); run -= 16; }
    const { size, bits } = magnitude(zz[z]);
    const sym = (run << 4) | size;
    w.bits(acT.code[sym], acT.size[sym]);
    w.bits(bits, size);
    run = 0;
  }
  if (end < 63) w.bits(acT.code[0x00], acT.size[0x00]); // EOB

  return zz[0];
}

function writeDQT(w: BitWriter, id: number, table: Float64Array) {
  w.word(0xffdb);
  w.word(67);
  w.byte(id); // 8-bit precision, table id
  for (let z = 0; z < 64; z++) {
    const [dy, dx] = ZIGZAG_2D[z];
    const v = Math.max(1, Math.min(255, Math.round(table[dy * 8 + dx])));
    w.byte(v);
  }
}

function writeDHT(w: BitWriter, cls: number, id: number, bits: number[], vals: number[]) {
  w.word(0xffc4);
  w.word(2 + 1 + 16 + vals.length);
  w.byte((cls << 4) | id);
  for (let i = 1; i <= 16; i++) w.byte(bits[i]);
  w.raw(vals);
}

export interface JpegEncodeOptions {
  /**
   * Luma quantization table, raster order, 64 entries. Values are clamped to
   * 1..255 as the format requires.
   */
  lumaQT: Float64Array;
  /** Chroma table. Defaults to the luma table when omitted. */
  chromaQT?: Float64Array;
}

/**
 * Encode RGBA pixels to a baseline JPEG using the supplied quantization tables.
 *
 * 4:4:4, no subsampling. The point of this encoder is that what comes out is
 * quantized on exactly the lattice it was given, so an embedder can place
 * coefficients that a matching re-encode will not move.
 */
export function encodeJpegWithTable(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts: JpegEncodeOptions,
): Uint8Array {
  const lumaQT = opts.lumaQT;
  const chromaQT = opts.chromaQT ?? opts.lumaQT;

  const w = new BitWriter();
  w.word(0xffd8); // SOI

  // APP0/JFIF, so every decoder agrees on how to read what follows.
  w.word(0xffe0); w.word(16);
  w.raw([0x4a, 0x46, 0x49, 0x46, 0x00]); // "JFIF\0"
  w.raw([1, 1, 0]); // version 1.1, no density units
  w.word(1); w.word(1); // aspect 1:1
  w.raw([0, 0]); // no thumbnail

  writeDQT(w, 0, lumaQT);
  writeDQT(w, 1, chromaQT);

  // SOF0: baseline, three components, all 1x1 sampled (4:4:4).
  w.word(0xffc0); w.word(8 + 3 * 3);
  w.byte(8);
  w.word(height); w.word(width);
  w.byte(3);
  w.raw([1, 0x11, 0]); // Y  uses table 0
  w.raw([2, 0x11, 1]); // Cb uses table 1
  w.raw([3, 0x11, 1]); // Cr uses table 1

  writeDHT(w, 0, 0, STD_DC_LUMA_BITS, STD_DC_LUMA_VALS);
  writeDHT(w, 1, 0, STD_AC_LUMA_BITS, STD_AC_LUMA_VALS);
  writeDHT(w, 0, 1, STD_DC_CHROMA_BITS, STD_DC_CHROMA_VALS);
  writeDHT(w, 1, 1, STD_AC_CHROMA_BITS, STD_AC_CHROMA_VALS);

  // SOS
  w.word(0xffda); w.word(6 + 2 * 3);
  w.byte(3);
  w.raw([1, 0x00, 2, 0x11, 3, 0x11]);
  w.raw([0, 63, 0]);

  const bw = Math.ceil(width / 8), bh = Math.ceil(height / 8);
  const Y = new Float64Array(64), CB = new Float64Array(64), CR = new Float64Array(64);
  let dcY = 0, dcCb = 0, dcCr = 0;

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let y = 0; y < 8; y++) {
        // Edge blocks replicate the last row/column rather than reading past
        // the buffer; the decoder discards them via the SOF dimensions.
        const sy = Math.min(by * 8 + y, height - 1);
        for (let x = 0; x < 8; x++) {
          const sx = Math.min(bx * 8 + x, width - 1);
          const p = (sy * width + sx) * 4;
          const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
          const i = y * 8 + x;
          Y[i]  =  0.299 * r + 0.587 * g + 0.114 * b - 128;
          CB[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          CR[i] =  0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      dcY  = writeBlock(w, quantize(forwardDCT8x8(Y),  lumaQT),   dcY,  DC_LUMA,   AC_LUMA);
      dcCb = writeBlock(w, quantize(forwardDCT8x8(CB), chromaQT), dcCb, DC_CHROMA, AC_CHROMA);
      dcCr = writeBlock(w, quantize(forwardDCT8x8(CR), chromaQT), dcCr, DC_CHROMA, AC_CHROMA);
    }
  }

  w.flushBits();
  w.word(0xffd9); // EOI
  return w.result();
}

/**
 * Instagram's luma quantization table, in zigzag order.
 *
 * Extracted from images Instagram itself returned
 * (`calibration/ig_back/*.jpg`) and byte-identical across every one of them,
 * which is what makes mimicry worth attempting at all — a table that varied
 * per upload could not be matched.
 */
export const INSTAGRAM_LUMA_ZIGZAG: readonly number[] = [
  5,6,6,11,8,11,11,11,11,11,13,11,11,11,13,14,14,13,13,14,14,15,13,14,14,14,13,15,
  16,16,16,17,17,16,16,16,16,15,19,18,19,15,16,17,19,20,20,19,17,19,22,22,22,19,22,
  21,21,22,25,22,25,22,22,18,
];

/** Instagram's chroma table, same provenance. */
export const INSTAGRAM_CHROMA_ZIGZAG: readonly number[] = [
  5,5,5,10,7,10,8,9,9,8,11,8,10,8,11,10,10,9,9,10,10,12,9,10,9,10,9,12,13,11,10,11,
  11,10,11,13,12,11,11,8,11,11,12,12,12,13,13,12,12,13,10,11,10,13,12,13,13,12,19,
  20,19,19,19,156,
];

/** Turn a zigzag-ordered table into the raster order the DCT code expects. */
export function zigzagToRaster(zz: readonly number[]): Float64Array {
  const out = new Float64Array(64);
  for (let z = 0; z < 64; z++) {
    const [dy, dx] = ZIGZAG_2D[z];
    out[dy * 8 + dx] = zz[z];
  }
  return out;
}
