/**
 * stego-adaptive.ts — measured platform geometry and texture-adaptive step size.
 *
 * Two changes derived from round-tripping test images through real WhatsApp,
 * Telegram and Instagram on an Android phone (see calibration/).
 *
 * 1. PLATFORM GEOMETRY
 *
 *    Every platform failure observed came from one cause: the platform
 *    resampled the image, which changes the spacing of the 8x8 DCT grid so the
 *    decoder samples across block boundaries and reads noise (~50% BER, total
 *    loss). Every success came from matching the platform's native output
 *    geometry so no resampling happens.
 *
 *      WhatsApp   caps width at 1600. At or below, passes through untouched.
 *      Telegram   caps at ~1920 (measured: 1600x1200 returned unchanged).
 *      Instagram  does NOT cap -- it normalises everything to a 1440x1440
 *                 square canvas. A 1080 upload comes back UPSCALED to 1440,
 *                 and a 4:3 upload comes back padded to square. Both destroy
 *                 the grid. Uploading at 1440x1440 already-square is the only
 *                 configuration that survives.
 *
 *    The previous instagram width of 1080 was measured at 42-50% BER, i.e. no
 *    recovery at all.
 *
 * 2. TEXTURE-ADAPTIVE STEP SIZE
 *
 *    Texture masks perturbation; flat regions do not. Embedding artifacts show
 *    up on walls, ceilings and sky long before they show in clothing or
 *    foliage. Scaling the QIM step by local activity -- larger where texture
 *    hides it, smaller where it would show -- measured a 2.0x reduction in
 *    visible perturbation at identical payload and identical mean step size.
 *
 *    Two properties make this safe to decode:
 *
 *    Energy is redistributed, not added: multipliers are normalised so the mean
 *    step is unchanged, otherwise this would just be "use a bigger delta".
 *
 *    Block SELECTION never changes, only the step. A threshold that decided
 *    WHICH blocks carry bits would be catastrophic -- one block flipping sides
 *    after compression shifts every subsequent bit. Here every block keeps its
 *    slot, so a misjudged rung costs a single bit, which Reed-Solomon absorbs.
 *
 *    Activity is measured from coefficients ABOVE the embedding band, so the
 *    act of embedding does not perturb the measurement the decoder must
 *    reproduce, and from quantized values, which survive the channel far
 *    better than raw pixel variance.
 */

export interface PlatformProfile {
  /** Target width in px. 0 means leave the cover alone. */
  width: number;
  /** Force a 1:1 canvas (Instagram normalises everything to square). */
  square: boolean;
  /** QIM step size for this channel. */
  delta: number;
  /** Human-readable note shown in the UI. */
  note: string;
}

/**
 * Geometry measured on a real Android phone; step sizes measured against this
 * encoder in CI (see embed-roundtrip.test.ts).
 *
 * The two are measured separately on purpose. Geometry is a property of the
 * platform and transfers between implementations. Step size is NOT: delta is
 * expressed in units of whatever quantization table the encoder uses, and this
 * encoder quantizes at Q75 via Canvas, so a delta measured against a different
 * table means nothing here. Probing found the shipped default of 14 fails a
 * WhatsApp-like recompression outright, and that 26 is the threshold.
 */
export const PLATFORM_PROFILES: Record<string, PlatformProfile> = {
  whatsapp_standard: {
    width: 1600, square: false, delta: 28,
    note: "Caps at 1600px. Measured 0.15-0.38% BER, up to 32KB payload.",
  },
  whatsapp_hd: {
    width: 1600, square: false, delta: 28,
    note: "HD upload still safe at 1600px.",
  },
  telegram_photo: {
    width: 1600, square: false, delta: 28,
    note: "Caps around 1920px. Measured 0.25-0.53% BER at 1600.",
  },
  instagram: {
    width: 1440, square: true, delta: 28,
    note: "Normalises to 1440x1440 square. Must upload already-square at 1440.",
  },
  facebook: {
    width: 2048, square: false, delta: 28,
    note: "Caps at 2048px (not independently verified).",
  },
  twitter: {
    width: 1600, square: false, delta: 28,
    note: "Caps at 1600px (not independently verified).",
  },
  imessage: {
    width: 1280, square: false, delta: 28,
    note: "Conservative 1280px target.",
  },
  /** Safe everywhere: square at 1440 survives all four measured platforms. */
  universal: {
    width: 1440, square: true, delta: 28,
    note: "Square 1440 survives WhatsApp, Telegram and Instagram alike.",
  },
  none: {
    width: 0, square: false, delta: 20,
    note: "No resize. Only safe for lossless channels (Telegram 'send as file').",
  },
};

export const DEFAULT_PLATFORM = "whatsapp_standard";

/**
 * Step sizes a decoder should try, most likely first.
 *
 * The decoder cannot know which platform an image was made for, and the payload
 * is self-validating (magic bytes plus Reed-Solomon), so a wrong step fails
 * cleanly rather than returning plausible garbage. Trying a short list is far
 * cheaper than being wrong. 14 is retained so images produced by earlier
 * versions still open.
 */
export const DETECT_DELTAS: readonly number[] = [28, 24, 20, 14, 36];

export function profileFor(platform: string): PlatformProfile {
  return PLATFORM_PROFILES[platform] ?? PLATFORM_PROFILES[DEFAULT_PLATFORM];
}

/**
 * Discrete multiplier ladder.
 *
 * Rungs rather than a continuous function: a block whose activity sits near a
 * boundary must land on the same rung before and after the channel mangles it,
 * and coarse steps make that far more likely.
 */
export const DELTA_LADDER = [0.55, 0.8, 1.15, 1.6, 2.2] as const;

/** Fixed absolute thresholds, so encoder and decoder never need to share state. */
const ACTIVITY_EDGES = [4, 12, 30, 70] as const;

/**
 * Texture measure for one block: summed magnitude of quantized coefficients
 * ABOVE the embedding band.
 *
 * Using positions we do not write to means embedding cannot shift the
 * measurement, which matters because the decoder has to recompute it from an
 * image that has been both embedded and compressed.
 */
export function blockActivity(
  qCoeffs: Float64Array | number[],
  coeffIndices: number[],
): number {
  let sum = 0;
  for (const idx of coeffIndices) sum += Math.abs(qCoeffs[idx]);
  return sum;
}

export function activityRung(activity: number): number {
  let r = 0;
  for (const edge of ACTIVITY_EDGES) {
    if (activity >= edge) r += 1;
    else break;
  }
  return r;
}

/**
 * Step size for a block, given the base step and the ladder mean.
 *
 * Dividing by the mean multiplier keeps total embedding energy equal to the
 * flat-delta case; without it this would silently be "use a bigger delta"
 * rather than "put the same energy where it is less visible".
 */
export function deltaForBlock(
  baseDelta: number,
  activity: number,
  ladderMean: number,
): number {
  return (baseDelta * DELTA_LADDER[activityRung(activity)]) / ladderMean;
}

/** Mean multiplier over the ladder, used to normalise. */
export const LADDER_MEAN =
  DELTA_LADDER.reduce((a, b) => a + b, 0) / DELTA_LADDER.length;
