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
  /**
   * Reed-Solomon parity symbols. Undefined means the QIM default (128).
   * RS parity is a PER-CHUNK cost (each 255-byte codeword chunk pays nsym
   * bytes of parity), so a large nsym on a small payload can consume most
   * of a small capacity budget on redundancy rather than message -- exactly
   * the failure mode chroma's own tiny capacity (~250-400B) hits: at the
   * default 128, RS parity alone for even a ~60B message needed ~99% of the
   * whole cb channel, touching far more super-blocks than the payload
   * itself required. Profiles built around chroma's small capacity set a
   * smaller nsym so most of that budget goes to payload, not overhead.
   */
  rsNsym?: number;
  /**
   * Number of luma AC positions to use, starting from the lowest frequency
   * (zigzag 1). Undefined means all 24 (unchanged behaviour). HANDOFF.md
   * §10.4 option 2: Instagram's sharpening hits high frequencies hardest,
   * so restricting to a low-frequency subset means every surviving bit
   * sits somewhere sharpening disturbs less -- fewer slots per block, but
   * each more robust, which may permit a smaller delta for the same
   * survival. Untested against real Instagram sharpening as of writing.
   */
  lumaAcCount?: number;
  /**
   * Slot ordering (§17.4). "spread" scatters a partial payload across every AC
   * position and the whole frame instead of saturating zigzag 1 from the top
   * down; only worth it when the payload is small, which the pointer tier made
   * the normal case. Omitted = "ac-major", the original behaviour.
   */
  slotOrder?: "ac-major" | "spread";
  /**
   * Bit repetition. Raising it is the one lever that buys robustness without
   * costing visibility -- it spends capacity, which a small payload has in
   * abundance. Omitted = the QIM default of 5.
   */
  repeat?: number;
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
    note: "Caps at 1600px, HD sends included. Measured 0.15-0.38% BER, up to 32KB payload.",
  },
  // Kept as an alias so any stored reference still resolves, but not offered
  // separately: HD sends were measured to cap at the same 1600px and take the
  // same step, so two identical entries in the picker only invited the
  // question of which one to pick.
  whatsapp_hd: {
    width: 1600, square: false, delta: 28,
    note: "Alias of whatsapp_standard -- HD uploads cap at the same 1600px.",
  },
  // 1280, which is what Telegram actually returns (§15.9).
  //
  // Both earlier values were wrong and for the same reason: nobody had checked
  // the DOWNLOADED image. Telegram re-encodes every photo to 1280x960, so 1600
  // and 1920 are both resampled, and resampling shifts the 8x8 grid -- the one
  // failure mode that destroys a payload outright (~50% BER, total loss)
  // rather than degrading it.
  //
  // The old "caps around 1920, 1600x1200 returned unchanged" note in §1 does
  // not survive this. It was almost certainly recorded by inspecting the file
  // that was sent rather than the file that came back, which is the same
  // mistake that produced a false PASS on 2026-08-13.
  //
  // UNVERIFIED at 1280: the observation that Telegram outputs 1280x960 is
  // solid, but no payload has yet been round-tripped at this geometry.
  // rsNsym 32 and lumaAcCount 6, matching `universal` (§15.12). The default
  // rsNsym of 128 spent half of every 255-byte codeword on parity, which at
  // 1280x960 meant 2.51 AC positions modified per block against universal's
  // 0.92 -- the reason Telegram photos looked visibly worse. At 32 it is 1.43,
  // and usable capacity roughly doubles (~1.4 KB -> ~2.4 KB).
  //
  // lumaAcCount is NOT optional here even though the capacity cap already
  // limits it to 6: decodeQimImageFile's blind sweep only passes rsNsym for
  // profiles that set lumaAcCount, so a profile with a non-default rsNsym and
  // no lumaAcCount embeds at 32 and is then blind-decoded at 128 -- i.e.
  // never decodes. The sweep filter now also catches rsNsym on its own, but
  // keeping both set here matches universal and costs nothing.
  telegram_photo: {
    // §17.4: at a 264 B pointer this profile used 12.1% of capacity but put
    // 100% of the perturbation on zigzag 1 across 72.7% of blocks -- a
    // coherent grating in the most visible frequency there is. "spread"
    // scatters the same energy over all six positions and the whole frame;
    // repeat 15 (up from 5) buys back the robustness that costs, and still
    // uses only ~36% of capacity.
    width: 1280, square: false, delta: 28, lumaAcCount: 6, rsNsym: 32,
    slotOrder: "spread", repeat: 15,
    note: "1280px -- Telegram re-encodes every photo to 1280x960, so anything larger is resampled "
      + "and lost. Send as FILE instead if you need capacity; that path does not recompress.",
  },
  // Kept only so images made by earlier versions still have their geometry
  // recorded. Not a fallback -- Telegram resamples it.
  telegram_photo_1600: {
    width: 1600, square: false, delta: 28,
    note: "Historical: the old Telegram geometry, before it was found that Telegram outputs 1280x960.",
  },
  // Zigzag-restricted by default (§13.5). Chroma was removed here: measured on
  // real photos it tints flat regions visibly (§12.4) and is worse than luma
  // alone at any payload big enough to matter. The lowest 6 AC positions
  // measured strictly better than the full 24 at the same delta -- 4000 B
  // survives here and does not at 24 positions -- so the restriction is now
  // the default rather than an experiment. Images made by earlier versions
  // still decode: decodeQimImageFile sweeps chroma and full-band candidates.
  instagram: {
    width: 1440, square: true, delta: 56, lumaAcCount: 6, rsNsym: 32,
    note: "1440x1440 square, step 56, lowest 6 AC positions. Instagram sharpens; 28 and 40 did not survive, 56 did. "
      + "Restricting to low frequencies survives re-encode measurably better and makes the capacity estimate honest.",
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
    chromaDelta: 28, chromaChannels: ["cb", "cr"], rsNsym: 32,
    note: "Chroma bracketing: step 28. Luma fixed at 56.",
  },
  instagram_chroma_d40: {
    width: 1440, square: true, delta: 56,
    chromaDelta: 40, chromaChannels: ["cb", "cr"], rsNsym: 32,
    note: "Chroma bracketing: step 40. Luma fixed at 56.",
  },
  instagram_chroma_d56: {
    width: 1440, square: true, delta: 56,
    chromaDelta: 56, chromaChannels: ["cb", "cr"], rsNsym: 32,
    note: "Chroma bracketing: step 56. Luma fixed at 56.",
  },
  // Zigzag-restricted luma bracket (§10.4 option 2): instead of routing
  // around luma visibility with chroma, restrict luma itself to the lowest
  // 6 AC positions -- Instagram's sharpening hits high frequencies hardest,
  // so every surviving bit sits somewhere sharpening disturbs less. d56 is
  // the control (same delta as the validated full-band profile, isolates
  // whether restriction alone helps); d20/d28/d40 test whether restriction
  // permits a smaller step too. No chroma, so this is a clean before/after
  // against the existing instagram_d56 baseline. Real-device bracketing not
  // yet done -- untested against real sharpening.
  //
  // rsNsym: 32, not the QIM default 128 -- restricting to 6 of 24 AC
  // positions cuts raw capacity to a quarter of the full-band profile
  // (measured: ~9.6KB usable there vs ~2.4KB here at the default nsym).
  // RS parity is a per-chunk cost (§12.4), so at the default it was eating
  // more than half of an already-small budget; the greedy event packer
  // (packForCapacity, scores by usefulness-per-byte) then fills that whole
  // budget with small, high-density profile events before any actual note
  // text fits -- exactly what "5 items, all profiles, no text" was. 32
  // roughly doubles the usable payload for the same image.
  instagram_zz6_d20: {
    width: 1440, square: true, delta: 20, lumaAcCount: 6, rsNsym: 32,
    note: "Zigzag 1-6 only, step 20. Bracketing whether restriction permits a smaller step.",
  },
  instagram_zz6_d28: {
    width: 1440, square: true, delta: 28, lumaAcCount: 6, rsNsym: 32,
    note: "Zigzag 1-6 only, step 28. Bracketing whether restriction permits a smaller step.",
  },
  instagram_zz6_d40: {
    width: 1440, square: true, delta: 40, lumaAcCount: 6, rsNsym: 32,
    note: "Zigzag 1-6 only, step 40. Bracketing whether restriction permits a smaller step.",
  },
  instagram_zz6_d56: {
    width: 1440, square: true, delta: 56, lumaAcCount: 6, rsNsym: 32,
    note: "Zigzag 1-6 only, step 56 (control -- same step as the validated full-band profile).",
  },
  /**
   * Safe everywhere: 1440 square clears WhatsApp's 1600 cap and Telegram's
   * 1920, and matches Instagram's canvas exactly. Step size is Instagram's,
   * because Instagram is the harshest of the three -- a step that survives it
   * survives the others with room to spare.
   */
  /**
   * Deliberately ignores Instagram.
   *
   * Instagram is the only platform that forces a 1440 square canvas and the
   * only one that sharpens, which is why it needs step 56 where every other
   * measured platform survives at 28. Carrying Instagram's requirements here
   * made every WhatsApp and Telegram user pay twice the perturbation -- the
   * exact cost this project is judged on -- to satisfy a platform they were
   * not sending to, and which offers no native way to download the image
   * back anyway. Instagram is now a deliberate side target: pick its own
   * profile when you actually want it.
   */
  universal: {
    width: 1600, square: false, delta: 28, lumaAcCount: 6, rsNsym: 32,
    note: "1600px, step 28. Verified through WhatsApp. Also sized for Twitter and Facebook. "
      + "NOT for Telegram as photo -- Telegram re-encodes to 1280x960 and would resample this; "
      + "use the Telegram profiles for that. Not for Instagram, which needs 1440 square, step 56.",
  },
  /**
   * The maximum-capacity channel. Telegram's "send as file" does not
   * recompress at all, so the only damage a payload takes is this app's own
   * JPEG encode -- no platform resize, no second quantisation. That means the
   * cover keeps its full resolution, and capacity scales with it: tens of KB
   * on a phone photo, against ~2-4 KB for every resized channel.
   *
   * Must be sent as a FILE, not as a photo. Sending it as a photo puts it
   * through Telegram's normal 1600px path and the payload is destroyed;
   * telegram_photo is the profile for that.
   */
  telegram_file: {
    width: 0, square: false, delta: 20, lumaAcCount: 6, rsNsym: 32,
    note: "No resize, step 20. Telegram 'send as file' is lossless, so this carries far more than any "
      + "other channel -- tens of KB on a full-size photo. Large covers take noticeably longer to embed.",
  },
  none: {
    width: 0, square: false, delta: 20,
    note: "No resize. Only safe for lossless channels (Telegram 'send as file').",
  },
};

export const DEFAULT_PLATFORM = "whatsapp_standard";

/**
 * Platforms worth putting in front of a user, in the order they should appear.
 *
 * Everything else in PLATFORM_PROFILES is a bracket/experiment profile from
 * the delta, chroma and zigzag ladders. Those cannot simply be deleted --
 * decodeQimImageFile sweeps every profile to auto-detect an image's settings,
 * so removing one makes every image ever made with it undecodable. They stay
 * in the record and drop out of the picker instead, behind a toggle so real
 * device bracketing is still possible without editing code.
 */
export const USER_PLATFORMS: readonly string[] = [
  "universal",
  "whatsapp_standard",
  "telegram_photo",
  "telegram_file",
  "instagram",
  "facebook",
  "twitter",
  "imessage",
  "none",
];

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
