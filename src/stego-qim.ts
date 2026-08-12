/**
 * QIM (Quantization Index Modulation) steganographic embedder/detector
 * for browser-side use. Port of the Python `encode_dct_qim` / `decode_dct_qim`
 * from channel_simulator/dct_variants.py.
 *
 * Pipeline:
 *   embed: JPEG bytes -> decode to pixels -> 8x8 DCT blocks -> QIM on AC coefficients
 *          -> IDCT -> re-encode to JPEG
 *   detect: JPEG bytes -> decode to pixels -> 8x8 DCT blocks -> extract QIM bits
 *           -> majority vote -> RS decode -> payload
 *
 * Uses pako for deflate compression (already a project dependency).
 */

import pako from "pako";
import {
  AC_INDICES,
  ZIGZAG_2D,
  forwardDCT8x8,
  inverseDCT8x8,
  quantizationTable,
  quantize,
  dequantize,
} from "./dct";
import { RSCodec } from "./reed-solomon";

// ---------------------------------------------------------------------------
// Constants (matching Python dct_variants.py)
// ---------------------------------------------------------------------------

import {
  PLATFORM_PROFILES, DETECT_DELTAS, profileFor,
  blockActivity, deltaForBlock, LADDER_MEAN,
} from "./stego-adaptive";
import {
  ycbcrToRgb, extractChromaPlanes,
  readChromaSuperblockScalar, writeChromaSuperblockScalar, CHROMA_SUPERBLOCK_PX,
} from "./stego-color";

/**
 * Coefficients used to gauge local texture: zigzag 25-40, i.e. ABOVE the
 * embedding band (1-24). Measuring on positions we never write to means the
 * act of embedding cannot move the measurement the decoder has to reproduce.
 */
const ACTIVITY_COEFF_INDICES: number[] = (() => {
  const out: number[] = [];
  for (let z = 25; z <= 40; z++) {
    const [dy, dx] = ZIGZAG_2D[z];
    out.push(dy * 8 + dx);
  }
  return out;
})();

const MAGIC = new Uint8Array([0x53, 0x54, 0x45, 0x47, 0x53, 0x54, 0x52]); // "STEGSTR"
const MAGIC_LEN = 7;
const LENGTH_BYTES = 4;

const QIM_DELTA = 14;
const QIM_RS_NSYM = 128;
const QIM_REPEAT = 5;
const QIM_EMBED_QUALITY = 75;
const QIM_ERASURE_MARGIN = QIM_DELTA / 6.0;

// ---------------------------------------------------------------------------
// Platform pre-resize widths (matching Python channel_simulator)
// ---------------------------------------------------------------------------

/** Platform target widths for pre-resize. */
/**
 * Target widths, now derived from measured platform behaviour rather than
 * assumption. See stego-adaptive.ts for how each number was obtained.
 *
 * The two that changed matter: instagram was 1080, which is upscaled to 1440
 * and measured 42-50% BER (no recovery at all); whatsapp_hd was 4096, which is
 * downscaled to 1600 with the same result.
 */
export const PLATFORM_WIDTHS: Record<string, number> = Object.fromEntries(
  Object.entries(PLATFORM_PROFILES).map(([k, v]) => [k, v.width]),
);

export const DEFAULT_PLATFORM = "whatsapp_standard";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface QimOptions {
  /** JPEG quality for output encoding (1-100). Default 75. */
  quality?: number;
  /** QIM quantization step. Default 14. */
  delta?: number;
  /** Bit repetition factor for majority voting. Default 5. */
  repeat?: number;
  /** Reed-Solomon parity symbol count. Default 128. */
  rsNsym?: number;
  /** Whether to compress payload with deflate before embedding. Default true. */
  compress?: boolean;
  /**
   * Scale the QIM step by local texture. Same mean step, but concentrated
   * where the image can hide it: measured 2.0x less visible perturbation at
   * identical payload. Default true.
   */
  adaptive?: boolean;
  /**
   * QIM step for chroma-channel embedding (§10.4 in HANDOFF.md). Undefined
   * (default) means chroma embedding is off -- luma-only, identical to
   * pre-chroma behaviour. Chroma bits are filled before any luma slot, so a
   * payload that fits in chroma capacity needs zero luma modifications.
   */
  chromaDelta?: number;
  /** Which chroma channels to embed in. Only meaningful with chromaDelta set. */
  chromaChannels?: Array<"cb" | "cr">;
}

// ---------------------------------------------------------------------------
// Bit / byte helpers (matching Python _to_bits / _from_bits)
// ---------------------------------------------------------------------------

function toBits(data: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    for (let bit = 7; bit >= 0; bit--) {
      out.push((data[i] >> bit) & 1);
    }
  }
  return out;
}

function fromBits(bits: number[]): Uint8Array {
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | (bits[i * 8 + j] & 1);
    }
    out[i] = byte;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Repeat / majority vote (matching Python)
// ---------------------------------------------------------------------------

function repeatBits(bits: number[], repeat: number): number[] {
  if (repeat <= 1) return bits;
  const out: number[] = [];
  for (const bit of bits) {
    for (let r = 0; r < repeat; r++) {
      out.push(bit);
    }
  }
  return out;
}

function majorityBits(bits: number[], repeat: number): number[] {
  if (repeat <= 1) return bits;
  const usable = Math.floor(bits.length / repeat) * repeat;
  const out: number[] = [];
  for (let i = 0; i < usable; i += repeat) {
    let sum = 0;
    for (let j = 0; j < repeat; j++) {
      sum += bits[i + j];
    }
    out.push(sum > Math.floor(repeat / 2) ? 1 : 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// QIM embed / detect primitives (matching Python _qim_embed / _qim_detect)
// ---------------------------------------------------------------------------

/**
 * QIM embed: quantize coefficient x to one of two reconstruction levels for bit.
 * Matches Python:
 *   cell = round(x / delta) * delta
 *   offset = (-1)^(bit+1) * delta/4
 *   return round(cell + offset)
 */
function qimEmbed(x: number, bit: number, delta: number): number {
  const cell = Math.round(x / delta) * delta;
  const offset = Math.pow(-1, bit + 1) * (delta / 4.0);
  return Math.round(cell + offset);
}

/**
 * QIM detect with confidence margin.
 * Matches Python _qim_detect_with_margin.
 */
function qimDetectWithMargin(z: number, delta: number): [number, number] {
  const cell = Math.round(z / delta) * delta;
  const r0 = cell - delta / 4.0;
  const r1 = cell + delta / 4.0;
  const d0 = Math.abs(z - r0);
  const d1 = Math.abs(z - r1);
  const bit = d0 <= d1 ? 0 : 1;
  const margin = Math.abs(d0 - d1);
  return [bit, margin];
}

// ---------------------------------------------------------------------------
// Coefficient stream: iterate over all 8x8 blocks, AC positions 1-24
// Returns array of [blockRow, blockCol, zigzagIndex] tuples.
// ---------------------------------------------------------------------------

interface CoeffPosition {
  blockRow: number;
  blockCol: number;
  zigzagIdx: number;
}

function buildCoeffStream(blocksY: number, blocksX: number): CoeffPosition[] {
  const stream: CoeffPosition[] = [];
  // AC-major order: iterate by AC position first, then across all blocks.
  // This spreads embedding evenly across the entire image instead of
  // concentrating modifications in the top rows of blocks.
  for (let zi = 0; zi < AC_INDICES.length; zi++) {
    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        stream.push({ blockRow: by, blockCol: bx, zigzagIdx: zi });
      }
    }
  }
  return stream;
}

/**
 * Convert a zigzag index (into AC_INDICES) to a (row, col) in the 8x8 block.
 * Matches Python _block_zigzag_index_to_2d.
 */
function zigzagIndexTo2d(zi: number): [number, number] {
  return ZIGZAG_2D[AC_INDICES[zi]];
}

// ---------------------------------------------------------------------------
// Chroma block stream: one scalar QIM slot per 16x16 super-block per channel
// (the real encoder subsamples chroma 2x2 before its own DCT -- see
// stego-color.ts module doc; a scalar-per-block scheme is what survives a
// real encode/decode round trip -- see stego-color.ts module doc for why the
// earlier DCT-AC-coefficient design did not). Channel-major order, so a
// small payload lands entirely in the first channel.
// ---------------------------------------------------------------------------

interface ChromaBlockPosition {
  channel: "cb" | "cr";
  sbRow: number;
  sbCol: number;
}

function buildChromaBlockStream(
  superBlocksY: number,
  superBlocksX: number,
  channels: Array<"cb" | "cr">,
): ChromaBlockPosition[] {
  const stream: ChromaBlockPosition[] = [];
  for (const channel of channels) {
    for (let sbRow = 0; sbRow < superBlocksY; sbRow++) {
      for (let sbCol = 0; sbCol < superBlocksX; sbCol++) {
        stream.push({ channel, sbRow, sbCol });
      }
    }
  }
  return stream;
}

// ---------------------------------------------------------------------------
// Browser JPEG decode / encode helpers
// ---------------------------------------------------------------------------

/**
 * Decode JPEG bytes to RGBA pixel data using OffscreenCanvas (or fallback to regular canvas).
 */
async function decodeJpegToPixels(
  jpegBytes: Uint8Array,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const blob = new Blob([jpegBytes], { type: "image/jpeg" });
  const bitmap = await createImageBitmap(blob);
  const w = bitmap.width;
  const h = bitmap.height;

  let data: Uint8ClampedArray;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get OffscreenCanvas 2d context");
    ctx.drawImage(bitmap, 0, 0);
    data = ctx.getImageData(0, 0, w, h).data;
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get canvas 2d context");
    ctx.drawImage(bitmap, 0, 0);
    data = ctx.getImageData(0, 0, w, h).data;
  }

  bitmap.close();
  return { data, width: w, height: h };
}

/**
 * Encode RGBA pixel data back to JPEG bytes.
 */
async function encodePixelsToJpeg(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  quality: number,
): Promise<Uint8Array> {
  const qualityFraction = quality / 100;

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get OffscreenCanvas 2d context");
    const imageData = new ImageData(pixels, width, height);
    ctx.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: qualityFraction });
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get canvas 2d context");
    const imageData = new ImageData(pixels, width, height);
    ctx.putImageData(imageData, 0, 0);
    return new Promise<Uint8Array>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("Canvas toBlob returned null"));
          blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
        },
        "image/jpeg",
        qualityFraction,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Luminance conversion: extract Y channel from RGBA for DCT processing
// ---------------------------------------------------------------------------

/**
 * Convert RGB pixel to Y (luminance) using JPEG/JFIF formula:
 *   Y = 0.299*R + 0.587*G + 0.114*B
 */
function rgbToY(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Build a grayscale (Y-channel) image from RGBA pixel data.
 * Returns a Uint8ClampedArray of single-channel luminance values.
 */
function extractYChannel(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const y = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    y[i] = Math.round(rgbToY(r, g, b));
  }
  return y;
}

// ---------------------------------------------------------------------------
// DCT block helpers for single-channel (Y) data
// ---------------------------------------------------------------------------

function extractBlockY(
  yChannel: Uint8ClampedArray,
  imgWidth: number,
  blockRow: number,
  blockCol: number,
): Float64Array {
  const block = new Float64Array(64);
  const startY = blockRow * 8;
  const startX = blockCol * 8;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      block[r * 8 + c] = (yChannel[(startY + r) * imgWidth + (startX + c)] ?? 0) - 128;
    }
  }
  return block;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed a payload into a JPEG image using QIM steganography.
 *
 * Pipeline:
 *   1. Decode JPEG to pixels
 *   2. Optionally compress payload with deflate
 *   3. Wrap with MAGIC + length header, RS encode, add codeword length prefix
 *   4. Convert to bits, repeat each bit QIM_REPEAT times
 *   5. For each 8x8 block of the luminance channel, compute forward DCT
 *   6. Apply QIM to selected AC coefficients to embed bits
 *   7. Inverse DCT, clamp pixels
 *   8. Re-encode as JPEG
 *
 * @param imageData - Input JPEG file bytes
 * @param payload - Raw payload bytes to embed
 * @param options - Optional configuration
 * @returns JPEG bytes with embedded payload
 */
export async function embedQim(
  imageData: Uint8Array,
  payload: Uint8Array,
  options?: QimOptions,
): Promise<Uint8Array> {
  const quality = options?.quality ?? QIM_EMBED_QUALITY;
  const delta = options?.delta ?? QIM_DELTA;
  const repeat = options?.repeat ?? QIM_REPEAT;
  const rsNsym = options?.rsNsym ?? QIM_RS_NSYM;
  const compress = options?.compress ?? true;
  const adaptive = options?.adaptive ?? true;
  const chromaDelta = options?.chromaDelta;
  const chromaChannels = options?.chromaChannels ?? [];
  const chromaEnabled = chromaDelta !== undefined && chromaChannels.length > 0;

  // Step 1: Decode JPEG to pixel data
  const { data: pixels, width, height } = await decodeJpegToPixels(imageData);

  // Step 2: Compress payload if requested
  const payloadToEmbed = compress ? pako.deflate(payload) : payload;

  // Step 3: Wrap payload — MAGIC + length + payload, then RS encode, then length prefix
  // Build raw: MAGIC + 4-byte big-endian length + payload
  const raw = new Uint8Array(MAGIC_LEN + LENGTH_BYTES + payloadToEmbed.length);
  raw.set(MAGIC, 0);
  const pLen = payloadToEmbed.length;
  raw[MAGIC_LEN] = (pLen >>> 24) & 0xff;
  raw[MAGIC_LEN + 1] = (pLen >>> 16) & 0xff;
  raw[MAGIC_LEN + 2] = (pLen >>> 8) & 0xff;
  raw[MAGIC_LEN + 3] = pLen & 0xff;
  raw.set(payloadToEmbed, MAGIC_LEN + LENGTH_BYTES);

  // RS encode
  const rs = new RSCodec(rsNsym);
  const codeword = rs.encode(raw);

  // Prefix with 2-byte codeword length (big-endian)
  const toEmbed = new Uint8Array(2 + codeword.length);
  toEmbed[0] = (codeword.length >>> 8) & 0xff;
  toEmbed[1] = codeword.length & 0xff;
  toEmbed.set(codeword, 2);

  // Step 4: Convert to bits and repeat
  const bits = repeatBits(toBits(toEmbed), repeat);

  // Step 5+6: Process 8x8 blocks, compute DCT, embed via QIM
  // Work on luminance only (Y channel), applied back to all RGB channels proportionally
  const blocksY = Math.floor(height / 8);
  const blocksX = Math.floor(width / 8);
  const stream = buildCoeffStream(blocksY, blocksX);

  // Chroma slots are filled before any luma slot (see stego-color.ts and
  // §10.4 in HANDOFF.md): chroma perturbation is far less visible than luma,
  // so a payload that fits entirely in chroma capacity needs zero luma
  // modifications instead of just fewer.
  const superBlocksY = Math.floor(height / CHROMA_SUPERBLOCK_PX);
  const superBlocksX = Math.floor(width / CHROMA_SUPERBLOCK_PX);
  const chromaStream = chromaEnabled
    ? buildChromaBlockStream(superBlocksY, superBlocksX, chromaChannels)
    : [];

  const totalCapacity = chromaStream.length + stream.length;
  if (bits.length > totalCapacity) {
    throw new Error(
      `Payload too large: need ${bits.length} bits, have ${totalCapacity} AC coefficients available`,
    );
  }

  const chromaBitCount = Math.min(bits.length, chromaStream.length);
  const chromaBits = bits.slice(0, chromaBitCount);
  const lumaBits = bits.slice(chromaBitCount);


  // Get quantization table for the target quality
  const qt = quantizationTable(quality);

  // Build a working copy of the pixel data
  const outPixels = new Uint8ClampedArray(pixels);
  const stride = width * 4;

  // Process each 8x8 block that has bits to embed
  // Track which blocks need modification
  const modifiedBlocks = new Set<string>();
  for (let i = 0; i < lumaBits.length; i++) {
    const key = `${stream[i].blockRow},${stream[i].blockCol}`;
    modifiedBlocks.add(key);
  }

  // Extract Y channel once from the original decoded pixels
  const yChannel = extractYChannel(pixels, width, height);

  for (const blockKey of modifiedBlocks) {
    const [brStr, bcStr] = blockKey.split(",");
    const br = parseInt(brStr, 10);
    const bc = parseInt(bcStr, 10);

    // Forward DCT on luminance channel
    const pixelBlock = extractBlockY(yChannel, width, br, bc);
    const dctCoeffs = forwardDCT8x8(pixelBlock);

    // Quantize (simulate JPEG quantization)
    const qCoeffs = quantize(dctCoeffs, qt);

    // Per-block step size. Computed from coefficients outside the embedding
    // band so this same number is recoverable at detect time.
    const blockDelta = adaptive
      ? deltaForBlock(delta, blockActivity(qCoeffs, ACTIVITY_COEFF_INDICES), LADDER_MEAN)
      : delta;

    // Apply QIM to the AC positions that need embedding for this block
    let modified = false;
    const blocksPerPlane = blocksY * blocksX;
    for (let zi = 0; zi < AC_INDICES.length; zi++) {
      // AC-major ordering: stream index = zi * (blocksY * blocksX) + br * blocksX + bc
      const streamIdx = zi * blocksPerPlane + br * blocksX + bc;
      if (streamIdx >= lumaBits.length) continue;

      const [dy, dx] = zigzagIndexTo2d(zi);
      const coeffIdx = dy * 8 + dx;
      const c = qCoeffs[coeffIdx];
      const newC = qimEmbed(c, lumaBits[streamIdx], blockDelta);
      if (newC !== c) {
        qCoeffs[coeffIdx] = newC;
        modified = true;
      }
    }

    if (modified) {
      // Dequantize and inverse DCT
      const dequantCoeffs = dequantize(qCoeffs, qt);
      const spatialBlock = inverseDCT8x8(dequantCoeffs);

      // Write back: apply the Y-channel change proportionally to RGB
      const startRow = br * 8;
      const startCol = bc * 8;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const px = (startRow + r) * stride + (startCol + c) * 4;
          const newY = Math.max(0, Math.min(255, Math.round(spatialBlock[r * 8 + c] + 128)));
          const origR = outPixels[px];
          const origG = outPixels[px + 1];
          const origB = outPixels[px + 2];
          const origY = rgbToY(origR, origG, origB);
          const yDiff = newY - origY;

          // Distribute the luminance change across RGB channels
          // proportional to their contribution to Y
          outPixels[px] = Math.max(0, Math.min(255, Math.round(origR + yDiff)));
          outPixels[px + 1] = Math.max(0, Math.min(255, Math.round(origG + yDiff)));
          outPixels[px + 2] = Math.max(0, Math.min(255, Math.round(origB + yDiff)));
        }
      }
    }
  }

  // Step 7 (chroma): embed chromaBits into Cb/Cr, one scalar QIM value per
  // super-block per channel (see stego-color.ts module doc for why -- a
  // DCT-AC scheme mirroring luma does not survive a real photo). Independent
  // of the luma pass above -- adding an equal delta to R,G,B (how the luma
  // pass writes pixels) cancels out in Cb=B-Y, Cr=R-Y, so Cb/Cr are still
  // exactly the original values at this point. No texture-adaptive step size
  // here: that machinery reads DCT coefficients above the embedding band,
  // which doesn't exist in a scalar-domain scheme.
  if (chromaEnabled && chromaBits.length > 0) {
    const { cb: cbPlane, cr: crPlane } = extractChromaPlanes(pixels, width, height);
    const planes: Record<"cb" | "cr", Float64Array> = { cb: cbPlane, cr: crPlane };
    const touchedSuperblocks = new Set<string>();

    for (let i = 0; i < chromaBits.length; i++) {
      const { channel, sbRow, sbCol } = chromaStream[i];
      const plane = planes[channel];
      const current = readChromaSuperblockScalar(plane, width, sbRow, sbCol);
      const target = qimEmbed(current, chromaBits[i], chromaDelta!);
      writeChromaSuperblockScalar(plane, width, sbRow, sbCol, target);
      touchedSuperblocks.add(`${sbRow},${sbCol}`);
    }

    // Recompose RGB for pixels in every touched super-block, preserving
    // whatever Y the luma pass already wrote and combining it with the
    // QIM-modified Cb/Cr.
    for (const key of touchedSuperblocks) {
      const [sbRow, sbCol] = key.split(",").map(Number);
      const startY = sbRow * CHROMA_SUPERBLOCK_PX;
      const startX = sbCol * CHROMA_SUPERBLOCK_PX;
      for (let r = 0; r < CHROMA_SUPERBLOCK_PX; r++) {
        for (let c = 0; c < CHROMA_SUPERBLOCK_PX; c++) {
          const py = startY + r;
          const pxCol = startX + c;
          const pIdx = py * width + pxCol;
          const px = py * stride + pxCol * 4;
          const origR = outPixels[px];
          const origG = outPixels[px + 1];
          const origB = outPixels[px + 2];
          const currentY = rgbToY(origR, origG, origB);
          const [newR, newG, newB] = ycbcrToRgb(currentY, cbPlane[pIdx], crPlane[pIdx]);
          outPixels[px] = Math.max(0, Math.min(255, Math.round(newR)));
          outPixels[px + 1] = Math.max(0, Math.min(255, Math.round(newG)));
          outPixels[px + 2] = Math.max(0, Math.min(255, Math.round(newB)));
        }
      }
    }
  }

  // Step 8: Re-encode as JPEG
  return encodePixelsToJpeg(outPixels, width, height, quality);
}

/**
 * Detect and extract a QIM-embedded payload from a JPEG image.
 *
 * Pipeline:
 *   1. Decode JPEG to pixels
 *   2. For each 8x8 block, compute forward DCT on luminance
 *   3. Detect QIM bits from AC coefficients with confidence margins
 *   4. Apply majority voting to de-repeat
 *   5. Parse codeword length, extract RS codeword
 *   6. Mark low-confidence bytes as erasures
 *   7. RS decode
 *   8. Verify magic, extract and decompress payload
 *
 * @param imageData - JPEG file bytes to analyze
 * @param options - Optional configuration (must match embed parameters)
 * @returns Extracted payload bytes, or null if no valid payload found
 */
export async function detectQim(
  imageData: Uint8Array,
  options?: QimOptions,
): Promise<Uint8Array | null> {
  const delta = options?.delta ?? QIM_DELTA;
  const repeat = options?.repeat ?? QIM_REPEAT;
  const rsNsym = options?.rsNsym ?? QIM_RS_NSYM;
  const compress = options?.compress ?? true;
  const quality = options?.quality ?? QIM_EMBED_QUALITY;
  const adaptive = options?.adaptive ?? true;
  const chromaDelta = options?.chromaDelta;
  const chromaChannels = options?.chromaChannels ?? [];
  const chromaEnabled = chromaDelta !== undefined && chromaChannels.length > 0;

  try {
    // Step 1: Decode JPEG to pixel data
    const { data: pixels, width, height } = await decodeJpegToPixels(imageData);

    // Step 2+3: Extract QIM bits from all 8x8 blocks
    const blocksY = Math.floor(height / 8);
    const blocksX = Math.floor(width / 8);
    const stream = buildCoeffStream(blocksY, blocksX);

    const qt = quantizationTable(quality);
    const yChannel = extractYChannel(pixels, width, height);

    const rawBits: number[] = [];
    const margins: number[] = [];

    // Chroma bits come first in the combined stream (matching embedQim), so
    // extract them before luma. Scalar-per-block scheme (§11 second
    // addendum) -- no DCT, no texture-adaptive step, just a direct read of
    // each block's safe-interior chroma average.
    if (chromaEnabled) {
      const superBlocksY = Math.floor(height / CHROMA_SUPERBLOCK_PX);
      const superBlocksX = Math.floor(width / CHROMA_SUPERBLOCK_PX);
      const chromaStream = buildChromaBlockStream(superBlocksY, superBlocksX, chromaChannels);
      const { cb: cbPlane, cr: crPlane } = extractChromaPlanes(pixels, width, height);
      const planes: Record<"cb" | "cr", Float64Array> = { cb: cbPlane, cr: crPlane };

      for (const { channel, sbRow, sbCol } of chromaStream) {
        const value = readChromaSuperblockScalar(planes[channel], width, sbRow, sbCol);
        const [bit, margin] = qimDetectWithMargin(value, chromaDelta!);
        rawBits.push(bit);
        margins.push(margin);
      }
    }

    // Cache DCT coefficients per block
    const blockDctCache = new Map<string, Float64Array>();
    const blockDeltaCache = new Map<string, number>();

    for (const { blockRow, blockCol, zigzagIdx } of stream) {
      const key = `${blockRow},${blockCol}`;
      let qCoeffs = blockDctCache.get(key);
      if (!qCoeffs) {
        const pixelBlock = extractBlockY(yChannel, width, blockRow, blockCol);
        const dctCoeffs = forwardDCT8x8(pixelBlock);
        qCoeffs = quantize(dctCoeffs, qt);
        blockDctCache.set(key, qCoeffs);
        blockDeltaCache.set(key, adaptive
          ? deltaForBlock(delta, blockActivity(qCoeffs, ACTIVITY_COEFF_INDICES), LADDER_MEAN)
          : delta);
      }
      const blockDelta = blockDeltaCache.get(key) ?? delta;

      const [dy, dx] = zigzagIndexTo2d(zigzagIdx);
      const coeffIdx = dy * 8 + dx;
      const c = qCoeffs[coeffIdx];
      const [bit, margin] = qimDetectWithMargin(c, blockDelta);
      rawBits.push(bit);
      margins.push(margin);
    }

    // Step 4: Majority voting
    const bits = majorityBits(rawBits, repeat);

    // Compute grouped margins for erasure detection
    let groupedMargins: number[];
    if (repeat > 1) {
      groupedMargins = [];
      for (let i = 0; i < margins.length; i += repeat) {
        const chunk = margins.slice(i, i + repeat);
        if (chunk.length === repeat) {
          groupedMargins.push(chunk.reduce((a, b) => a + b, 0) / repeat);
        }
      }
    } else {
      groupedMargins = margins;
    }

    // Step 5: Parse codeword length header (first 16 bits)
    if (bits.length < 16) return null;
    const headerBytes = fromBits(bits.slice(0, 16));
    const codewordLen = (headerBytes[0] << 8) | headerBytes[1];
    const totalBits = (2 + codewordLen) * 8;
    if (bits.length < totalBits) return null;

    // Extract full payload bits
    const allBytes = fromBits(bits.slice(0, totalBits));
    const codeword = allBytes.slice(2, 2 + codewordLen);

    // Step 6: Mark low-confidence bytes as erasures
    const erasures: number[] = [];
    const byteMargins: number[] = [];
    const bitsUsed = bits.slice(0, totalBits);
    for (let i = 0; i < Math.floor(bitsUsed.length / 8); i++) {
      const start = i * 8;
      const end = start + 8;
      if (end > groupedMargins.length) break;
      byteMargins.push(Math.min(...groupedMargins.slice(start, end)));
    }
    // Erasure positions relative to the codeword (skip the 2-byte length prefix)
    for (let idx = 0; idx < Math.min(byteMargins.length - 2, codewordLen); idx++) {
      if (byteMargins[idx + 2] < QIM_ERASURE_MARGIN) {
        erasures.push(idx);
      }
    }

    // Step 7: RS decode
    const rs = new RSCodec(rsNsym);
    let decoded: Uint8Array;
    try {
      decoded = rs.decode(codeword, erasures.length > 0 ? erasures : undefined);
    } catch {
      // Try without erasures as fallback
      try {
        decoded = rs.decode(codeword);
      } catch {
        return null;
      }
    }

    // Step 8: Verify magic and extract payload
    if (decoded.length < MAGIC_LEN + LENGTH_BYTES) return null;
    for (let i = 0; i < MAGIC_LEN; i++) {
      if (decoded[i] !== MAGIC[i]) return null;
    }
    const payloadLen =
      (decoded[MAGIC_LEN] << 24) |
      (decoded[MAGIC_LEN + 1] << 16) |
      (decoded[MAGIC_LEN + 2] << 8) |
      decoded[MAGIC_LEN + 3];
    if (decoded.length < MAGIC_LEN + LENGTH_BYTES + payloadLen) return null;

    const extractedPayload = decoded.slice(
      MAGIC_LEN + LENGTH_BYTES,
      MAGIC_LEN + LENGTH_BYTES + payloadLen,
    );

    // Decompress if compressed
    if (compress) {
      try {
        return pako.inflate(extractedPayload);
      } catch {
        // If decompression fails, try returning raw (maybe it wasn't compressed)
        return extractedPayload;
      }
    }
    return extractedPayload;
  } catch (e) {
    console.error("[stego-qim] detectQim error:", e);
    return null;
  }
}

/**
 * Compute the maximum payload size (in bytes) that can be embedded
 * in an image of the given dimensions.
 */
export function getQimCapacityBytes(
  width: number,
  height: number,
  options?: QimOptions,
): number {
  const repeat = options?.repeat ?? QIM_REPEAT;
  const rsNsym = options?.rsNsym ?? QIM_RS_NSYM;

  const blocksY = Math.floor(height / 8);
  const blocksX = Math.floor(width / 8);
  let totalCoeffs = blocksY * blocksX * AC_INDICES.length;

  // Mirrors embedQim exactly: chroma slots (§10.4, scalar-per-block scheme
  // per §11 second addendum) add one bit per super-block per channel.
  const chromaChannels = options?.chromaChannels ?? [];
  if (options?.chromaDelta !== undefined && chromaChannels.length > 0) {
    const superBlocksY = Math.floor(height / CHROMA_SUPERBLOCK_PX);
    const superBlocksX = Math.floor(width / CHROMA_SUPERBLOCK_PX);
    totalCoeffs += superBlocksY * superBlocksX * chromaChannels.length;
  }

  const totalBitsAvailable = Math.floor(totalCoeffs / repeat);
  const totalBytesAvailable = Math.floor(totalBitsAvailable / 8);

  // Subtract overhead: 2-byte codeword length + RS parity + MAGIC + LENGTH_BYTES
  const overhead = 2 + rsNsym + MAGIC_LEN + LENGTH_BYTES;
  return Math.max(0, totalBytesAvailable - overhead);
}

/**
 * Convenience: embed a QIM payload into a JPEG File, returning a Blob.
 */
export async function encodeQimImageFile(
  coverFile: File,
  payload: Uint8Array,
  options?: QimOptions & { platform?: string },
): Promise<Blob> {
  const jpegBytes = new Uint8Array(await coverFile.arrayBuffer());
  // Step size comes from the target platform unless the caller overrides it.
  // Without this the profiles are decorative: embedQim would silently keep
  // using QIM_DELTA, which probing shows does not survive recompression.
  // chromaDelta/chromaChannels come from the same profile -- most profiles
  // leave them undefined, which keeps chroma embedding off (§10.4).
  const prof = options?.platform ? profileFor(options.platform) : undefined;
  const delta = options?.delta ?? prof?.delta;
  const chromaDelta = options?.chromaDelta ?? prof?.chromaDelta;
  const chromaChannels = options?.chromaChannels ?? prof?.chromaChannels;
  const result = await embedQim(jpegBytes, payload, { ...options, delta, chromaDelta, chromaChannels });
  return new Blob([result], { type: "image/jpeg" });
}

/**
 * Convenience: detect a QIM payload from a JPEG File.
 */
export async function decodeQimImageFile(
  file: File,
  options?: QimOptions,
): Promise<{ ok: boolean; payload?: string; error?: string }> {
  try {
    const jpegBytes = new Uint8Array(await file.arrayBuffer());

    // The decoder cannot know which platform an image was made for, and
    // therefore cannot know its step size. The payload validates itself (magic
    // bytes plus Reed-Solomon), so a wrong step fails cleanly instead of
    // returning plausible garbage -- which makes trying a short list safe, and
    // far better than guessing one value. The caller can still pin a delta.
    let result: Uint8Array | null = null;
    if (options?.delta !== undefined) {
      result = await detectQim(jpegBytes, options);
    } else {
      // Phase 1: chroma-capable profiles. A chroma-embedded image is NOT
      // decodable by a luma-only guess -- the chroma bits carry the
      // magic/length header (§10.4), so a luma-only read starts mid-stream
      // and fails. Try whole {delta, chromaDelta, chromaChannels} bundles
      // from the small set of profiles that actually enable chroma.
      const chromaCandidates = Object.values(PLATFORM_PROFILES).filter((p) => p.chromaDelta !== undefined);
      for (const prof of chromaCandidates) {
        result = await detectQim(jpegBytes, {
          ...options, delta: prof.delta, chromaDelta: prof.chromaDelta, chromaChannels: prof.chromaChannels,
        });
        if (result && result.length > 0) break;
      }
      // Phase 2: plain luma-only sweep, chroma disabled -- backward
      // compatible with images made before this change and other platforms.
      if (!result || result.length === 0) {
        for (const delta of DETECT_DELTAS) {
          result = await detectQim(jpegBytes, { ...options, delta });
          if (result && result.length > 0) break;
        }
      }
    }
    if (!result || result.length === 0) {
      return { ok: false, error: "No QIM payload found" };
    }
    const asUtf8 = new TextDecoder("utf-8", { fatal: false }).decode(result);
    const trimmed = asUtf8.replace(/^\s+/, "");
    if (trimmed.startsWith("{")) {
      return { ok: true, payload: asUtf8 };
    }
    // Return as base64
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < result.length; i += chunkSize) {
      const chunk = result.subarray(i, Math.min(i + chunkSize, result.length));
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return { ok: true, payload: "base64:" + btoa(binary) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Platform pre-resize
// ---------------------------------------------------------------------------

/**
 * Geometry a cover should be given before embedding, for a target platform.
 *
 * Exported separately so it can be unit-tested without a canvas: the whole
 * point is that these numbers decide whether a payload survives, and they
 * should not only be verifiable by eye in a browser.
 *
 * Square handling exists because Instagram normalises every upload onto a
 * 1440x1440 canvas. A 4:3 image comes back padded to square, which shifts the
 * 8x8 grid origin; a 1080 square comes back upscaled, which changes the grid
 * spacing. Both destroy the payload (measured 42-50% BER). Supplying an
 * already-square 1440 image leaves Instagram nothing to change.
 */
export function coverGeometry(
  srcW: number,
  srcH: number,
  targetWidth: number,
  square: boolean,
): { w: number; h: number; sx: number; sy: number; sw: number; sh: number } {
  let sx = 0, sy = 0, sw = srcW, sh = srcH;

  if (square) {
    // Centre-crop to 1:1 rather than pad: padding would add flat bars that
    // carry no texture, wasting capacity and looking obviously processed.
    const side = Math.min(srcW, srcH);
    sx = Math.floor((srcW - side) / 2);
    sy = Math.floor((srcH - side) / 2);
    sw = side;
    sh = side;
  }

  let w = sw, h = sh;
  if (targetWidth > 0 && (square ? true : w > targetWidth)) {
    const scale = targetWidth / w;
    w = targetWidth;
    h = square ? targetWidth : Math.round(h * scale);
  }

  // Snap to whole DCT blocks.
  w = Math.floor(w / 8) * 8;
  h = Math.floor(h / 8) * 8;
  return { w, h, sx, sy, sw, sh };
}

/**
 * Resize a cover image for a target platform.
 * Converts any image format to JPEG. targetWidth 0 means no resize.
 * Dimensions are snapped to multiples of 8 for DCT block alignment.
 */
export async function resizeCoverForPlatform(
  coverFile: File,
  targetWidth: number,
  square = false,
): Promise<File> {
  const bitmap = await createImageBitmap(coverFile);
  const g = coverGeometry(bitmap.width, bitmap.height, targetWidth, square);
  const { w, h, sx, sy, sw, sh } = g;
  if (w < 8 || h < 8) throw new Error("Image too small after resize");

  let blob: Blob;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get OffscreenCanvas 2d context");
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get canvas 2d context");
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
    blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        "image/jpeg",
        0.95,
      );
    });
  }
  bitmap.close();

  const name = coverFile.name.replace(/\.[^.]+$/, "") + ".jpg";
  return new File([blob], name, { type: "image/jpeg" });
}

/**
 * Get QIM capacity for a File after optional platform pre-resize.
 * Returns capacityBytes, width, and height so UI can display dimensions.
 */
export async function getQimCapacityForFile(
  coverFile: File,
  platform?: string,
): Promise<{ capacityBytes: number; width: number; height: number }> {
  // Must mirror the embed path exactly, square flag included: a capacity
  // computed on a non-square cover is wrong for Instagram, whose profile
  // centre-crops to 1:1 before embedding.
  const prof = profileFor(platform ?? DEFAULT_PLATFORM);
  const resized = await resizeCoverForPlatform(coverFile, prof.width, prof.square);
  const bitmap = await createImageBitmap(resized);
  const w = bitmap.width;
  const h = bitmap.height;
  bitmap.close();
  const capacityBytes = getQimCapacityBytes(w, h, {
    chromaDelta: prof.chromaDelta,
    chromaChannels: prof.chromaChannels,
  });
  return { capacityBytes, width: w, height: h };
}

/**
 * Embed payload then immediately detect to verify round-trip integrity.
 * Returns { ok: true } or { ok: false, error: string }.
 */
export async function qimSelfTest(
  jpegBlob: Blob,
  originalPayload: Uint8Array,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const file = new File([jpegBlob], "selftest.jpg", { type: "image/jpeg" });
    const result = await decodeQimImageFile(file);
    if (!result.ok) {
      return { ok: false, error: `Self-test detect failed: ${result.error}` };
    }
    const detectedPayload = result.payload ?? "";
    // decodeQimImageFile returns binary payloads as "base64:..." strings
    if (detectedPayload.startsWith("base64:")) {
      const detectedBytes = Uint8Array.from(
        atob(detectedPayload.slice(7)),
        (c) => c.charCodeAt(0),
      );
      if (detectedBytes.length !== originalPayload.length) {
        return {
          ok: false,
          error: `Self-test length mismatch: expected ${originalPayload.length}, got ${detectedBytes.length}`,
        };
      }
      for (let i = 0; i < originalPayload.length; i++) {
        if (detectedBytes[i] !== originalPayload[i]) {
          return { ok: false, error: `Self-test byte mismatch at position ${i}` };
        }
      }
      return { ok: true };
    }
    // If returned as plain text, compare as string
    const originalStr = new TextDecoder().decode(originalPayload);
    if (detectedPayload === originalStr) return { ok: true };
    return { ok: false, error: "Self-test payload mismatch (text mode)" };
  } catch (e) {
    return {
      ok: false,
      error: `Self-test exception: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
