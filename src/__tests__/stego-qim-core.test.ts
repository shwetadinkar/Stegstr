import { describe, it, expect } from "vitest";
import {
  forwardDCT8x8,
  inverseDCT8x8,
  quantizationTable,
  quantize,
  dequantize,
  AC_INDICES,
} from "../dct";
import { RSCodec } from "../reed-solomon";
import { getQimCapacityBytes, PLATFORM_WIDTHS, DEFAULT_PLATFORM } from "../stego-qim";
import { PLATFORM_PROFILES, USER_PLATFORMS } from "../stego-adaptive";
import { coverGeometry } from "../stego-qim";

// ---------------------------------------------------------------------------
// DCT round-trip tests
// ---------------------------------------------------------------------------

describe("DCT forward/inverse round-trip", () => {
  it("recovers a flat block", () => {
    const block = new Float64Array(64).fill(0);
    const dct = forwardDCT8x8(block);
    const recovered = inverseDCT8x8(dct);
    for (let i = 0; i < 64; i++) {
      expect(recovered[i]).toBeCloseTo(0, 8);
    }
  });

  it("recovers a constant block (DC only)", () => {
    const block = new Float64Array(64).fill(100);
    const dct = forwardDCT8x8(block);
    const recovered = inverseDCT8x8(dct);
    for (let i = 0; i < 64; i++) {
      expect(recovered[i]).toBeCloseTo(100, 6);
    }
  });

  it("recovers a gradient block", () => {
    const block = new Float64Array(64);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        block[r * 8 + c] = r * 8 + c; // 0 to 63
      }
    }
    const dct = forwardDCT8x8(block);
    const recovered = inverseDCT8x8(dct);
    for (let i = 0; i < 64; i++) {
      expect(recovered[i]).toBeCloseTo(block[i], 6);
    }
  });

  it("recovers a random block", () => {
    const block = new Float64Array(64);
    // Deterministic pseudo-random values in pixel range [-128, 127]
    for (let i = 0; i < 64; i++) {
      block[i] = ((i * 37 + 13) % 256) - 128;
    }
    const dct = forwardDCT8x8(block);
    const recovered = inverseDCT8x8(dct);
    for (let i = 0; i < 64; i++) {
      expect(recovered[i]).toBeCloseTo(block[i], 6);
    }
  });
});

// ---------------------------------------------------------------------------
// Quantization table tests
// ---------------------------------------------------------------------------

describe("quantizationTable", () => {
  it("produces valid tables for standard quality levels", () => {
    for (const q of [1, 25, 50, 75, 100]) {
      const qt = quantizationTable(q);
      expect(qt.length).toBe(64);
      for (let i = 0; i < 64; i++) {
        expect(qt[i]).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("quality 50 matches standard JPEG luminance table", () => {
    const qt = quantizationTable(50);
    // First row of standard table
    expect(qt[0]).toBe(16);
    expect(qt[1]).toBe(11);
    expect(qt[2]).toBe(10);
    expect(qt[3]).toBe(16);
  });

  it("lower quality produces larger quantization values", () => {
    const qt25 = quantizationTable(25);
    const qt75 = quantizationTable(75);
    // Lower quality = coarser quantization = larger table values
    let q25Sum = 0, q75Sum = 0;
    for (let i = 0; i < 64; i++) {
      q25Sum += qt25[i];
      q75Sum += qt75[i];
    }
    expect(q25Sum).toBeGreaterThan(q75Sum);
  });
});

// ---------------------------------------------------------------------------
// Quantize / dequantize round-trip
// ---------------------------------------------------------------------------

describe("quantize/dequantize", () => {
  it("quantize then dequantize approximates original", () => {
    const coeffs = new Float64Array(64);
    for (let i = 0; i < 64; i++) {
      coeffs[i] = ((i * 23 + 7) % 200) - 100;
    }
    const qt = quantizationTable(75);
    const qCoeffs = quantize(coeffs, qt);
    const restored = dequantize(qCoeffs, qt);
    // Each value should be within qt[i]/2 of the original (quantization error)
    for (let i = 0; i < 64; i++) {
      expect(Math.abs(restored[i] - coeffs[i])).toBeLessThanOrEqual(qt[i] / 2 + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Reed-Solomon round-trip tests
// ---------------------------------------------------------------------------

describe("Reed-Solomon codec", () => {
  it("encodes and decodes a short message", () => {
    const rs = new RSCodec(128);
    const message = new Uint8Array([0x53, 0x54, 0x45, 0x47, 0x53, 0x54, 0x52]); // "STEGSTR"
    const encoded = rs.encode(message);
    expect(encoded.length).toBe(message.length + 128);
    const decoded = rs.decode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(message));
  });

  it("encodes and decodes various message lengths", () => {
    for (const nsym of [10, 64, 128]) {
      const rs = new RSCodec(nsym);
      for (const len of [1, 5, 20, 50]) {
        const message = new Uint8Array(len);
        for (let i = 0; i < len; i++) message[i] = (i * 37 + 13) & 0xff;
        const encoded = rs.encode(message);
        expect(encoded.length).toBe(len + nsym);
        const decoded = rs.decode(encoded);
        expect(Array.from(decoded)).toEqual(Array.from(message));
      }
    }
  });

  it("clean codeword decodes correctly with high parity", () => {
    const rs = new RSCodec(128);
    const message = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const encoded = rs.encode(message);
    // No corruption - just verify round-trip with nsym=128 (what QIM uses)
    const decoded = rs.decode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(message));
  });

  it("fails gracefully on too many errors", () => {
    const rs = new RSCodec(10); // only 10 parity symbols
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = rs.encode(message);
    const corrupted = new Uint8Array(encoded);
    // Corrupt more than nsym/2 = 5 positions
    for (let i = 0; i < 8; i++) {
      corrupted[i] ^= 0xff;
    }
    expect(() => rs.decode(corrupted)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// QIM capacity tests
// ---------------------------------------------------------------------------

describe("getQimCapacityBytes", () => {
  it("returns positive capacity for 1080x720", () => {
    const cap = getQimCapacityBytes(1080, 720);
    expect(cap).toBeGreaterThan(0);
  });

  it("returns 0 for tiny images", () => {
    const cap = getQimCapacityBytes(8, 8);
    // 1 block × 24 AC / 5 repeat / 8 bits = 0 bytes after overhead
    expect(cap).toBe(0);
  });

  it("larger images have more capacity", () => {
    const small = getQimCapacityBytes(256, 256);
    const large = getQimCapacityBytes(1080, 720);
    expect(large).toBeGreaterThan(small);
  });

  it("capacity scales with image area", () => {
    const c1 = getQimCapacityBytes(1080, 720);
    const c2 = getQimCapacityBytes(2160, 1440); // 4x area
    // Should be roughly 4x capacity (minus fixed overhead)
    expect(c2).toBeGreaterThan(c1 * 3);
  });

  it("typical 1080px image has enough capacity for small payloads", () => {
    const cap = getQimCapacityBytes(1080, 720);
    // Two corrections live in this number, both of which used to make it
    // bigger than the encoder could deliver.
    //
    // 1. Reed-Solomon parity is a per-chunk cost, not a flat nsym once: a
    //    message spanning many 255-byte chunks pays nsym bytes of parity per
    //    chunk (~half the codeword at nsym=128). The old flat-overhead
    //    formula overstated anything past one chunk.
    // 2. Only the lowest AC positions survive a re-encode, so capacity is
    //    estimated over the reliable band rather than all 24 written
    //    positions (§13.5 -- measured: 24 positions promised 9641 B on a real
    //    photo and failed self-test at 4000 B; 6 positions promised 4226 B
    //    and passed).
    //
    // 878 B is what this geometry holds at the default nsym=128. Every
    // shipped lossy profile sets rsNsym: 32, which takes the same geometry to
    // 1553 B. Small, but deliverable -- the point of the change.
    expect(cap).toBeGreaterThan(800);
    expect(getQimCapacityBytes(1080, 720, { rsNsym: 32 })).toBeGreaterThan(1500);
  });
});

// ---------------------------------------------------------------------------
// Platform widths constants
// ---------------------------------------------------------------------------

describe("PLATFORM_WIDTHS", () => {
  it("has all expected platforms", () => {
    expect(PLATFORM_WIDTHS).toHaveProperty("instagram");
    expect(PLATFORM_WIDTHS).toHaveProperty("facebook");
    expect(PLATFORM_WIDTHS).toHaveProperty("twitter");
    expect(PLATFORM_WIDTHS).toHaveProperty("whatsapp_standard");
    expect(PLATFORM_WIDTHS).toHaveProperty("whatsapp_hd");
    expect(PLATFORM_WIDTHS).toHaveProperty("telegram_photo");
    expect(PLATFORM_WIDTHS).toHaveProperty("imessage");
    expect(PLATFORM_WIDTHS).toHaveProperty("none");
  });

  /**
   * Updated from measurement. These two tests previously asserted
   * instagram = 1080 and instagram as the default, on the assumption that
   * Instagram caps width like WhatsApp does.
   *
   * It does not. Instagram normalises every upload onto a 1440x1440 square
   * canvas: a 1080 upload is UPSCALED to 1440, which changes the spacing of
   * the 8x8 DCT grid and destroys the payload. Round-tripped through real
   * Instagram, 1080 measured 42-50% BER -- indistinguishable from chance.
   * At 1440 square the grid survives and payloads recover.
   *
   * The default likewise moves to whatsapp_standard, which is both the most
   * common share target and a geometry that was verified end to end.
   */
  it("instagram targets 1440, its native canvas size", () => {
    expect(PLATFORM_WIDTHS.instagram).toBe(1440);
  });

  it("no platform targets a width the platform will resize away", () => {
    // Every entry must be at or below what that platform actually emits.
    expect(PLATFORM_WIDTHS.whatsapp_standard).toBeLessThanOrEqual(1600);
    expect(PLATFORM_WIDTHS.telegram_photo).toBeLessThanOrEqual(1920);
    // HD is a different channel, not a bigger number on the same one: an HD
    // send carries 4096x3072 through, confirmed on a phone. Sending this over
    // a STANDARD send caps at 1600 and destroys the payload, which is why the
    // two are separate entries rather than one.
    expect(PLATFORM_WIDTHS.whatsapp_hd).toBeLessThanOrEqual(4096);
  });

  it("default platform is a verified geometry AND the tuned encoder", () => {
    // The fallback for callers that name no platform -- the MCP server, the
    // CLI, any API user. It was "whatsapp_standard", which carried no
    // lumaAcCount or rsNsym and so fell back to the encoder defaults: all 24
    // AC positions and rsNsym 128, roughly 2.5 AC positions modified per block
    // instead of one. An agent that omitted the argument silently got three
    // times the perturbation at the same geometry.
    expect(DEFAULT_PLATFORM).toBe("universal");
    expect(PLATFORM_WIDTHS[DEFAULT_PLATFORM]).toBe(1600);
  });

  it("every user-facing platform ships the tuned encoder, not the defaults", () => {
    // The duplicates in the picker were not merely clutter: "Twitter/X",
    // "WhatsApp" and "iMessage" declared no tuning, so choosing the entry with
    // your platform's name on it gave a WORSE encoder than the generic
    // "Universal" whose label claimed to cover them.
    for (const name of USER_PLATFORMS) {
      const prof = PLATFORM_PROFILES[name];
      if (prof.width === 0) continue; // "none" does not resize or restrict
      expect(`${name}:zigzag=${prof.lumaAcCount}`).toBe(`${name}:zigzag=6`);
      expect(`${name}:rsNsym=${prof.rsNsym}`).toBe(`${name}:rsNsym=32`);
    }
  });

  it("carries WhatsApp HD at 4096, its own geometry and not an alias", () => {
    // The record was wrong about this twice, in opposite directions. It first
    // shipped at 4096 and destroyed payloads, so it was clamped to 1600 and
    // annotated "HD uploads cap at the same 1600px". A phone test then
    // confirmed an HD send carries 4096x3072 through intact -- the earlier
    // failure is consistent with HD-sized images sent over a STANDARD send,
    // which does cap at 1600 and downscales.
    const hd = PLATFORM_PROFILES.whatsapp_hd;
    expect(hd.width).toBe(4096);
    expect(hd.square).toBe(false);
    // Same tuned encoder as everything else user-facing.
    expect(hd.lumaAcCount).toBe(6);
    expect(hd.rsNsym).toBe(32);
    // It must remain a distinct choice from the standard send: picking the
    // wrong one is a total loss, not a degradation.
    expect(hd.width).not.toBe(PLATFORM_PROFILES.universal.width);
  });

  it("gains roughly 6x the capacity over a standard send", () => {
    // The reason it is worth a separate entry at all. If this ever collapses
    // toward the 1600 figure, the profile has stopped doing its job.
    const opts = { lumaAcCount: 6, rsNsym: 32 };
    const hd = getQimCapacityBytes(4096, 3072, opts);
    const std = getQimCapacityBytes(1600, 1200, opts);
    expect(hd).toBeGreaterThan(20000);
    expect(hd / std).toBeGreaterThan(5);
  });

  it("caps the LONG edge, so a portrait cover is not left oversized", () => {
    /*
     * A portrait cover used to come out taller than the platform allows,
     * because only width was capped: 1600x2133 against a 1600 cap became
     * 1600x2128. The platform then downscaled it to fit, resampling the 8x8
     * grid -- the total loss §15 records at ~50% BER.
     *
     * Invisible until now because every phone test used a landscape photo,
     * where width IS the long edge. In portrait it failed on every platform,
     * and the symptom was "the recipient's app finds nothing", which points
     * nowhere near orientation.
     */
    const portrait = coverGeometry(1600, 2133, 1600, false);
    expect(Math.max(portrait.w, portrait.h)).toBeLessThanOrEqual(1600);

    const bigPortrait = coverGeometry(5000, 6667, 4096, false);
    expect(Math.max(bigPortrait.w, bigPortrait.h)).toBeLessThanOrEqual(4096);
  });

  it("keeps a portrait cover within the cap on every channel", () => {
    /*
     * Which channels the width-only bug actually bit, and which it could not.
     *
     * A 3024x4032 portrait phone photo against each target, under the old rule
     * that capped width alone:
     *
     *   Twitter / WhatsApp HD (4096)   3024x4032   fine -- long edge already
     *                                              under the cap, so no resize
     *                                              happened either way
     *   WhatsApp standard (1600)       1600x2128   DESTROYED
     *   Telegram as photo (1280)       1280x1704   DESTROYED
     *   Facebook (2048)                2048x2728   DESTROYED
     *
     * This matters for reading device reports: a portrait cover surviving
     * X/Twitter says nothing about the fix, because that path was identical
     * before and after. Only the smaller-cap channels exercise it.
     */
    for (const cap of [1280, 1600, 2048, 4096]) {
      const g = coverGeometry(3024, 4032, cap, false);
      expect(`${cap}:${Math.max(g.w, g.h) <= cap}`).toBe(`${cap}:true`);
    }
  });

  it("leaves the 4096 channels untouched, where portrait was never broken", () => {
    // Old and new agree exactly here, which is why a portrait image survives
    // X/Twitter regardless of this fix.
    expect(coverGeometry(3024, 4032, 4096, false)).toMatchObject({ w: 3024, h: 4032 });
  });

  it("does not sweep the same decode configuration twice", () => {
    /*
     * The blind sweep tries profiles, but decoding never resizes -- it reads
     * the image it was given -- so two profiles differing only in WIDTH are
     * the same attempt run twice.
     *
     * Measured before the fix: 24 profiles, 42 worst-case attempts, and nine
     * profiles sharing one single configuration (whatsapp_standard,
     * whatsapp_hd, telegram_photo, telegram_photo_1600, facebook, twitter,
     * imessage, instagram_zz6_d28, universal) -- 18 attempts doing the work of
     * two. After: 22 attempts.
     *
     * The profiles themselves stay: they carry the geometry each platform
     * needs for EMBEDDING, which is real and distinct. Only the decode sweep
     * has no use for the distinction.
     */
    const decodeKey = (p: typeof PLATFORM_PROFILES[string]) => [
      p.delta, p.lumaAcCount ?? "-", p.rsNsym ?? "-", p.repeat ?? "-",
      p.activityBand ?? "high", p.chromaDelta ?? "-", p.chromaChannels ?? "-",
      p.slotOrder ?? "-",
    ].join("|");

    const all = Object.values(PLATFORM_PROFILES);
    const distinct = new Set(all.map(decodeKey));
    // If these are ever equal, the dedupe has become pointless and something
    // has changed about how profiles are defined.
    expect(distinct.size).toBeLessThan(all.length);
  });

  it("keeps the aspect ratio when capping either orientation", () => {
    const p = coverGeometry(3000, 4000, 2000, false);
    expect(p.w / p.h).toBeCloseTo(3000 / 4000, 2);
    const l = coverGeometry(4000, 3000, 2000, false);
    expect(l.w / l.h).toBeCloseTo(4000 / 3000, 2);
  });

  it("leaves a landscape cover exactly as it was before the long-edge fix", () => {
    // The fix must not move the geometry that WAS verified on a phone.
    expect(coverGeometry(2133, 1600, 1600, false)).toMatchObject({ w: 1600, h: 1200 });
    expect(coverGeometry(4032, 3024, 4096, false)).toMatchObject({ w: 4032, h: 3024 });
  });

  it("X/Twitter keeps the grid up to a 4096 long edge", () => {
    // Measured on a real account: file size drops, dimensions do not. That is
    // recompression without resampling, which is exactly what delta 28 exists
    // to survive -- so the capacity can be taken.
    expect(PLATFORM_PROFILES.twitter.width).toBe(4096);
    expect(PLATFORM_PROFILES.twitter.square).toBe(false);
    const g = coverGeometry(3072, 4096, 4096, false);
    expect(g.w).toBe(3072);
    expect(g.h).toBe(4096);
  });

  it("does not upscale a 12MP phone photo to reach 4096", () => {
    // 4032x3024 is the common 12MP output, just under the cap. Upscaling would
    // invent detail that is not there, and smooth invented pixels are exactly
    // where QIM fails. For non-square profiles the width is a cap, not a
    // target.
    const g = coverGeometry(4032, 3024, 4096, false);
    expect(g.w).toBe(4032);
    expect(g.h).toBe(3024);
  });

  it("still caps an oversized cover down to 4096", () => {
    const g = coverGeometry(6000, 4500, 4096, false);
    expect(g.w).toBe(4096);
  });

  it("offers one entry per distinct encoding, with no duplicates", () => {
    const seen = new Map<string, string>();
    for (const name of USER_PLATFORMS) {
      const p = PLATFORM_PROFILES[name];
      const key = `${p.width}|${p.square}|${p.delta}|${p.lumaAcCount}|${p.rsNsym}|${p.chromaDelta}`;
      const already = seen.get(key);
      // A second name for the same output is a choice the user cannot make
      // correctly, because both options do exactly the same thing.
      expect(already ? `${name} duplicates ${already}` : name).toBe(name);
      seen.set(key, name);
    }
  });

  it("none has width 0 (no resize)", () => {
    expect(PLATFORM_WIDTHS.none).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC_INDICES constant
// ---------------------------------------------------------------------------

describe("AC_INDICES", () => {
  it("has 24 positions (zigzag positions 1-24)", () => {
    expect(AC_INDICES.length).toBe(24);
    expect(AC_INDICES[0]).toBe(1); // skip DC at position 0
    expect(AC_INDICES[23]).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// QIM embed/detect primitive math tests
// ---------------------------------------------------------------------------

describe("QIM primitives (math verification)", () => {
  // We can't import private functions, but we can verify the math independently
  const DELTA = 14;

  function qimEmbed(x: number, bit: number, delta: number): number {
    const cell = Math.round(x / delta) * delta;
    const offset = Math.pow(-1, bit + 1) * (delta / 4.0);
    return Math.round(cell + offset);
  }

  function qimDetect(z: number, delta: number): number {
    const cell = Math.round(z / delta) * delta;
    const r0 = cell - delta / 4.0;
    const r1 = cell + delta / 4.0;
    const d0 = Math.abs(z - r0);
    const d1 = Math.abs(z - r1);
    return d0 <= d1 ? 0 : 1;
  }

  it("embed then detect recovers bit 0", () => {
    for (const x of [-50, -14, -7, 0, 7, 14, 28, 50, 100]) {
      const embedded = qimEmbed(x, 0, DELTA);
      const detected = qimDetect(embedded, DELTA);
      expect(detected).toBe(0);
    }
  });

  it("embed then detect recovers bit 1", () => {
    for (const x of [-50, -14, -7, 0, 7, 14, 28, 50, 100]) {
      const embedded = qimEmbed(x, 1, DELTA);
      const detected = qimDetect(embedded, DELTA);
      expect(detected).toBe(1);
    }
  });

  it("survives small perturbation (simulating JPEG noise)", () => {
    let correct = 0;
    let total = 0;
    for (const x of [-50, -28, -14, 0, 14, 28, 50]) {
      for (const bit of [0, 1]) {
        const embedded = qimEmbed(x, bit, DELTA);
        // Add noise up to delta/4 - 1 (should survive)
        for (const noise of [-2, -1, 0, 1, 2]) {
          const noisy = embedded + noise;
          const detected = qimDetect(noisy, DELTA);
          if (detected === bit) correct++;
          total++;
        }
      }
    }
    // Should be 100% correct with noise < delta/4 = 3.5
    expect(correct).toBe(total);
  });

  it("reconstruction levels are separated by delta/2", () => {
    // For any coefficient, the two QIM levels (for bit 0 and bit 1) should be delta/2 apart
    for (const x of [0, 14, 28, -14]) {
      const level0 = qimEmbed(x, 0, DELTA);
      const level1 = qimEmbed(x, 1, DELTA);
      expect(Math.abs(level1 - level0)).toBe(Math.round(DELTA / 2));
    }
  });
});
