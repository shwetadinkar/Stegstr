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
  /**
   * QIM step size for chroma-channel embedding (§10.4). Undefined means
   * chroma embedding is off for this profile -- luma-only, unchanged
   * behaviour. Chroma bits are invisible at a much smaller step than luma
   * needs to survive Instagram's sharpening, so payloads that fit in chroma
   * capacity need zero luma modifications.
   */
  chromaDelta?: number;
  /** Which chroma channels to embed in, when chromaDelta is set. */
  chromaChannels?: Array<"cb" | "cr">;
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
    width: 1440, square: true, delta: 56,
    chromaDelta: 28, chromaChannels: ["cb", "cr"],
    note: "1440x1440 square, larger step. Instagram sharpens; 28 and 40 did not survive, 56 did. "
      + "Chroma channel carries payload first (invisible), luma only for overflow -- §10.4, unbracketed on a real device yet.",
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
  // Experiment profiles: identical to `instagram` except for step size, so a
  // real-platform bracket can be run from the UI without code changes.
  instagram_d44: {
    width: 1440, square: true, delta: 44,
    note: "Bracketing: threshold lies in (40, 56].",
  },
  instagram_d48: {
    width: 1440, square: true, delta: 48,
    note: "Bracketing: threshold lies in (40, 56].",
  },
  instagram_d52: {
    width: 1440, square: true, delta: 52,
    note: "Bracketing: threshold lies in (40, 56].",
  },
  instagram_d40: {
    width: 1440, square: true, delta: 40,
    note: "Instagram geometry, larger step. For bracketing survival.",
  },
  instagram_d56: {
    width: 1440, square: true, delta: 56,
    note: "Instagram geometry, larger step still.",
  },
  instagram_d72: {
    width: 1440, square: true, delta: 72,
    note: "Instagram geometry, largest step. Expect visible artifacts.",
  },
  // Chroma bracket ladder (§10.4): luma delta fixed at the already-validated
  // 56, only chromaDelta varies, exactly mirroring how the instagram_d*
  // luma bracket isolated one unknown at a time. Real-device bracketing not
  // yet done -- these exist so it can be run from the UI without code changes.
  instagram_chroma_d28: {
    width: 1440, square: true, delta: 56,
    chromaDelta: 28, chromaChannels: ["cb", "cr"],
    note: "Chroma bracketing: step 28. Luma fixed at 56.",
  },
  instagram_chroma_d40: {
    width: 1440, square: true, delta: 56,
    chromaDelta: 40, chromaChannels: ["cb", "cr"],
    note: "Chroma bracketing: step 40. Luma fixed at 56.",
  },
  instagram_chroma_d56: {
    width: 1440, square: true, delta: 56,
    chromaDelta: 56, chromaChannels: ["cb", "cr"],
    note: "Chroma bracketing: step 56. Luma fixed at 56.",
  },
  /**
   * Safe everywhere: 1440 square clears WhatsApp's 1600 cap and Telegram's
   * 1920, and matches Instagram's canvas exactly. Step size is Instagram's,
   * because Instagram is the harshest of the three -- a step that survives it
   * survives the others with room to spare.
   */
  universal: {
    width: 1440, square: true, delta: 56,
    chromaDelta: 28, chromaChannels: ["cb", "cr"],
    note: "Square 1440 at Instagram's step size. Survives WhatsApp, Telegram and Instagram.",
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
// Ordered by how likely each is in the wild: 56 is now the Instagram and
// universal default, 28 the WhatsApp/Telegram default, 14 upstream's original.
export const DETECT_DELTAS: readonly number[] = [56, 28, 52, 48, 44, 40, 72, 24, 20, 14, 36];

/**
 * Instagram-only step-size candidates, for bracketing by experiment.
 *
 * Geometry is solved: uploading an already-square 1440x1440 image means
 * Instagram does not resample and the 8x8 grid survives intact (verified on a
 * real account -- 1440 in, 1440 out). What remains is amplitude. Instagram
 * sharpens after processing, which perturbs exactly the mid-frequency
 * coefficients QIM writes to, and delta=28 was not enough to ride over it.
 *
 * Sharpening cannot be reproduced in CI -- the simulator only resizes and
 * re-encodes -- so the value has to come from real posts, the same way the
 * WhatsApp threshold did.
 */
export const INSTAGRAM_DELTA_CANDIDATES: readonly number[] = [28, 40, 56, 72];

/**
 * Measured on real Instagram, August 2026, 1440x1440 square uploads:
 *
 *   delta 28  FAIL      delta 40  FAIL      delta 56  PASS      delta 72  PASS
 *
 * The threshold sits between 40 and 56, so Instagram needs roughly TWICE
 * WhatsApp's step (26) despite having far gentler quantization (steps 5-25 vs
 * 6-167). Quantization was never the damage: Instagram sharpens after
 * processing, which perturbs exactly the mid-frequency coefficients QIM writes
 * to, and sharpening does not care how coarse the quantizer is.
 *
 * At 56 the embedding is visible on close inspection as a uniform grain rather
 * than localised dotting -- adaptive placement spreads energy into texture
 * instead of concentrating it in flat regions, so what remains reads as sensor
 * noise or JPEG artefacting. That clears "undetectable through normal viewing
 * or casual inspection"; it would not clear statistical steganalysis. Anyone
 * needing that should use a smaller payload rather than a smaller step.
 */

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
