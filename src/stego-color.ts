/**
 * RGB <-> YCbCr conversion and chroma super-block downsample/upsample for
 * chroma-channel QIM embedding (HANDOFF.md §10.4).
 *
 * The real JPEG encoder subsamples chroma 2x2 before its own DCT (verified
 * empirically against @napi-rs/canvas: a chroma pattern at the Nyquist
 * frequency is destroyed even at quality 95, at every quality tested). That
 * means one chroma DCT block covers a 16x16 region of the source image, not
 * 8x8 like luma.
 *
 * The trick that avoids needing to know the encoder's exact subsampling
 * filter: write the target chroma value as a flat, piecewise-constant 2x2
 * tile across the whole 16x16 super-block. Any reasonable local-averaging
 * filter applied to an already-constant region just reads the constant back
 * out, so the encoder's specific filter (box, triangle, whatever a given
 * browser uses) doesn't matter.
 */

const SUPERBLOCK = 16;
const SUBSAMPLE = 2;

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
 * Downsample a 16x16 super-block of a chroma plane to an 8x8 block by
 * averaging each 2x2 group -- the same operation the real encoder performs
 * before its own chroma DCT.
 */
export function downsampleChromaSuperblock(
  plane: Float64Array,
  planeWidth: number,
  sbRow: number,
  sbCol: number,
): Float64Array {
  const out = new Float64Array(64);
  const startY = sbRow * SUPERBLOCK;
  const startX = sbCol * SUPERBLOCK;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const py = startY + r * SUBSAMPLE;
      const px = startX + c * SUBSAMPLE;
      const v00 = plane[py * planeWidth + px] ?? 0;
      const v01 = plane[py * planeWidth + px + 1] ?? 0;
      const v10 = plane[(py + 1) * planeWidth + px] ?? 0;
      const v11 = plane[(py + 1) * planeWidth + px + 1] ?? 0;
      out[r * 8 + c] = (v00 + v01 + v10 + v11) / 4;
    }
  }
  return out;
}

/**
 * Write an 8x8 block back into a 16x16 super-block of a chroma plane, each
 * value replicated as a flat 2x2 tile. This is what makes the result
 * invariant to the encoder's actual subsampling filter -- see module doc.
 */
export function upsampleChromaSuperblock(
  plane: Float64Array,
  planeWidth: number,
  sbRow: number,
  sbCol: number,
  block8x8: Float64Array,
): void {
  const startY = sbRow * SUPERBLOCK;
  const startX = sbCol * SUPERBLOCK;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const v = block8x8[r * 8 + c];
      const py = startY + r * SUBSAMPLE;
      const px = startX + c * SUBSAMPLE;
      plane[py * planeWidth + px] = v;
      plane[py * planeWidth + px + 1] = v;
      plane[(py + 1) * planeWidth + px] = v;
      plane[(py + 1) * planeWidth + px + 1] = v;
    }
  }
}

export const CHROMA_SUPERBLOCK_PX = SUPERBLOCK;
