/**
 * RGB <-> YCbCr conversion and chroma super-block read/write for
 * chroma-channel QIM embedding (HANDOFF.md §10.4, §11 second addendum).
 *
 * The real JPEG encoder subsamples chroma 2x2 before its own DCT (verified
 * empirically against @napi-rs/canvas: a chroma pattern at the Nyquist
 * frequency is destroyed even at quality 95, at every quality tested). That
 * means one chroma DCT block covers a 16x16 region of the source image, not
 * 8x8 like luma.
 *
 * First design attempt embedded multiple DCT-AC coefficients per super-block
 * (mirroring the luma scheme) and failed on real photos: a block with real
 * AC content is not spatially flat, and JPEG decoders reconstruct chroma
 * with smooth ("fancy") upsampling that blends continuously across the whole
 * image, not respecting any 8x8-block distinction in the reduced-resolution
 * chroma plane. That blending corrupted the fine structure the DCT scheme
 * depended on (measured 4-8% raw bit-error rate on real photos, worsening
 * with delta, not improving -- the signature of a spatial-domain mismatch,
 * not a lattice-margin problem).
 *
 * This version embeds exactly ONE scalar value per super-block per channel,
 * written as a flat, uniform 16x16 patch (survives the encoder's
 * subsampling for the same reason a flat 2x2 tile does -- an
 * already-constant region reduces any reasonable local-averaging filter to
 * reading the constant back out), and READ from the block's safe interior
 * (avoiding roughly the outer 2px on each edge, where the decoder's smooth
 * upsampling blends toward neighbouring blocks -- verified empirically).
 * Costs capacity (1 bit/block/channel instead of 24) but this is the
 * scenario already verified to survive a real encode/decode round trip.
 */

const SUPERBLOCK = 16;
/** Pixels excluded from each edge when reading a block's scalar value, to
 *  stay clear of the decoder's cross-block chroma smoothing (observed to
 *  reach roughly 2px in from a block boundary; this leaves a 4px margin). */
const SAFE_MARGIN = 4;

/** Standard JFIF/BT.601 coefficients, matching rgbToY in stego-qim.ts. */
export function rgbToYCbCr(r: number, g: number, b: number): [number, number, number] {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return [y, cb, cr];
}

/** Inverse of rgbToYCbCr. Does not clamp -- caller clamps to [0,255]. */
export function ycbcrToRgb(y: number, cb: number, cr: number): [number, number, number] {
  const r = y + 1.402 * (cr - 128);
  const g = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
  const b = y + 1.772 * (cb - 128);
  return [r, g, b];
}

/**
 * Extract full-resolution Cb and Cr planes from RGBA pixel data.
 * Full resolution, not chroma-subsampled -- we do our own subsampling at
 * the super-block level so we control exactly what the encoder sees.
 */
export function extractChromaPlanes(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { cb: Float64Array; cr: Float64Array } {
  const cb = new Float64Array(width * height);
  const cr = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const [, cbv, crv] = rgbToYCbCr(r, g, b);
    cb[i] = cbv;
    cr[i] = crv;
  }
  return { cb, cr };
}

/**
 * Read a single representative chroma value for a 16x16 super-block,
 * averaged over its safe interior only (excludes SAFE_MARGIN px on each
 * edge). Used both to decide what to embed and, at decode time, to read
 * back what survived the channel.
 */
export function readChromaSuperblockScalar(
  plane: Float64Array,
  planeWidth: number,
  sbRow: number,
  sbCol: number,
): number {
  const startY = sbRow * SUPERBLOCK + SAFE_MARGIN;
  const startX = sbCol * SUPERBLOCK + SAFE_MARGIN;
  const span = SUPERBLOCK - 2 * SAFE_MARGIN;
  let sum = 0;
  for (let r = 0; r < span; r++) {
    for (let c = 0; c < span; c++) {
      sum += plane[(startY + r) * planeWidth + (startX + c)] ?? 0;
    }
  }
  return sum / (span * span);
}

/**
 * Shift every pixel in a 16x16 super-block by a constant amount, clamped to
 * [0,255], preserving whatever natural chroma texture the block already had.
 *
 * An earlier version of this replaced the whole block with one flat value
 * (writeChromaSuperblockScalar, since removed). That survives the encoder's
 * subsampling for the same reason a flat 2x2 tile does, but it also erases
 * every touched block's real local colour variation -- invisible on a
 * synthetic sine-wave test pattern with little fine chroma detail, glaringly
 * visible on a real photograph as a mosaic of flat-coloured patches
 * replacing natural texture. A uniform additive shift keeps the same
 * subsampling-invariance property (any 2x2 group's average shifts by
 * exactly `shift`, regardless of the encoder's filter) while leaving the
 * block's own texture intact, so what a viewer sees is a subtle colour cast
 * over real detail rather than a flat colour swatch.
 */
export function shiftChromaSuperblock(
  plane: Float64Array,
  planeWidth: number,
  sbRow: number,
  sbCol: number,
  shift: number,
): void {
  const startY = sbRow * SUPERBLOCK;
  const startX = sbCol * SUPERBLOCK;
  for (let r = 0; r < SUPERBLOCK; r++) {
    for (let c = 0; c < SUPERBLOCK; c++) {
      const idx = (startY + r) * planeWidth + (startX + c);
      plane[idx] = Math.max(0, Math.min(255, plane[idx] + shift));
    }
  }
}

export const CHROMA_SUPERBLOCK_PX = SUPERBLOCK;
