import { describe, it, expect } from "vitest";
import {
  PLATFORM_PROFILES, profileFor, DEFAULT_PLATFORM, USER_PLATFORMS,
  blockActivity, activityRung, deltaForBlock, DELTA_LADDER, LADDER_MEAN,
} from "../stego-adaptive";
import { coverGeometry } from "../stego-qim";

describe("measured platform profiles", () => {
  it("instagram is square at its native 1440 canvas", () => {
    const p = PLATFORM_PROFILES.instagram;
    // 1080 measured 42-50% BER through real Instagram: the upscale to 1440
    // desynchronises the 8x8 grid. Only an already-square 1440 survives.
    expect(p.width).toBe(1440);
    expect(p.square).toBe(true);
  });

  it("square profiles are exactly those targeting Instagram's canvas", () => {
    // Instagram normalises every upload to 1440x1440. Any profile that wants
    // to survive it must supply an already-square image at that size; nothing
    // else should force a crop.
    for (const [name, p] of Object.entries(PLATFORM_PROFILES)) {
      if (p.square) {
        expect(p.width).toBe(1440);
        expect(name === "universal" || name.startsWith("instagram")).toBe(true);
      } else {
        expect(name.startsWith("instagram")).toBe(false);
      }
    }
  });

  it("every lossy profile clears the measured survival threshold", () => {
    // Probing this encoder against a WhatsApp-like recompression put the
    // threshold at 26; the shipped default of 14 failed outright.
    //
    // Instagram is deliberately set no lower even though CI makes it look
    // easier. The CI channel resizes and re-encodes but does NOT model
    // Instagram's sharpening, and sharpening is exactly what damaged real
    // uploads on a phone. Trusting the optimistic simulator here would repeat
    // the mistake that produced upstream's sim-to-real gap.
    //
    // Exception: the zigzag-restricted bracket profiles (§10.4 option 2)
    // exist specifically to test whether restricting to the lowest 6 AC
    // positions changes this threshold -- that's an open, real-device
    // question, not something this test can assert an answer to yet.
    for (const [name, p] of Object.entries(PLATFORM_PROFILES)) {
      if (name === "none") continue;   // lossless channel, no recompression
      // Only the hidden bracket profiles are exempt. instagram and universal
      // now carry lumaAcCount too (§13.5 made the restriction the default),
      // and they must still clear the threshold like any other real target.
      if (!USER_PLATFORMS.includes(name) && p.lumaAcCount !== undefined) continue;
      expect(p.delta).toBeGreaterThanOrEqual(26);
    }
  });

  it("every user-facing platform exists, and no bracket profile is one", () => {
    // The picker shows USER_PLATFORMS; the decoder sweeps all of
    // PLATFORM_PROFILES. A name in the first list that is missing from the
    // second is a blank dropdown entry, and a bracket profile that leaks into
    // the first is 13 test settings back in front of the user.
    for (const name of USER_PLATFORMS) {
      expect(PLATFORM_PROFILES[name], `${name} is offered but does not exist`).toBeDefined();
    }
    for (const name of USER_PLATFORMS) {
      expect(/_d\d+$/.test(name), `${name} looks like a bracket profile`).toBe(false);
    }
  });

  it("bracket profiles stay decodable even though they are hidden", () => {
    // Hiding them from the picker must not remove them: decodeQimImageFile
    // guesses an image's settings by sweeping these, so dropping one makes
    // every image already made with it undecodable.
    for (const name of ["instagram_d56", "instagram_chroma_d28", "instagram_zz6_d56"]) {
      expect(PLATFORM_PROFILES[name]).toBeDefined();
      expect(USER_PLATFORMS.includes(name)).toBe(false);
    }
  });

  it("falls back to a known-good profile for unknown platforms", () => {
    expect(profileFor("myspace")).toEqual(PLATFORM_PROFILES[DEFAULT_PLATFORM]);
  });

  it("universal profile survives every measured platform", () => {
    const u = PLATFORM_PROFILES.universal;
    expect(u.width).toBe(1440);
    expect(u.width).toBeLessThanOrEqual(PLATFORM_PROFILES.whatsapp_standard.width);
    expect(u.square).toBe(true);
  });
});

describe("chroma-channel bracket profiles (§10.4)", () => {
  it("chroma-enabled profiles keep luma fixed at the already-validated 56", () => {
    // Only chromaDelta should vary across the bracket ladder -- isolating
    // the one open question, same discipline as the instagram_d* luma
    // bracket that settled on 56.
    for (const [name, p] of Object.entries(PLATFORM_PROFILES)) {
      if (p.chromaDelta !== undefined) {
        expect(p.delta).toBe(56);
        expect(name === "universal" || name.startsWith("instagram")).toBe(true);
      }
    }
  });

  it("bracket ladder isolates chromaDelta and nothing else", () => {
    const d28 = PLATFORM_PROFILES.instagram_chroma_d28;
    const d40 = PLATFORM_PROFILES.instagram_chroma_d40;
    const d56 = PLATFORM_PROFILES.instagram_chroma_d56;
    expect([d28.width, d40.width, d56.width]).toEqual([1440, 1440, 1440]);
    expect([d28.square, d40.square, d56.square]).toEqual([true, true, true]);
    expect([d28.chromaDelta, d40.chromaDelta, d56.chromaDelta]).toEqual([28, 40, 56]);
  });

  it("chromaChannels is only set alongside chromaDelta", () => {
    for (const p of Object.values(PLATFORM_PROFILES)) {
      if (p.chromaDelta === undefined) {
        expect(p.chromaChannels).toBeUndefined();
      } else {
        expect(p.chromaChannels?.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("texture-adaptive step size", () => {
  const flat = new Float64Array(64);
  const busy = new Float64Array(64).fill(9);
  const idx = [20, 21, 22, 23, 24, 25];

  it("measures more activity in a textured block", () => {
    expect(blockActivity(busy, idx)).toBeGreaterThan(blockActivity(flat, idx));
  });

  it("maps activity onto discrete rungs", () => {
    expect(activityRung(0)).toBe(0);
    expect(activityRung(5)).toBe(1);
    expect(activityRung(15)).toBe(2);
    expect(activityRung(40)).toBe(3);
    expect(activityRung(1000)).toBe(4);
  });

  it("uses a smaller step on flat blocks, where artifacts show", () => {
    const flatDelta = deltaForBlock(16, 0, LADDER_MEAN);
    const busyDelta = deltaForBlock(16, 500, LADDER_MEAN);
    expect(flatDelta).toBeLessThan(16);
    expect(busyDelta).toBeGreaterThan(16);
  });

  it("preserves mean step: redistributes energy rather than adding it", () => {
    // Without normalisation this would silently just be "use a bigger delta",
    // which trades invisibility for robustness instead of improving both.
    const mean = DELTA_LADDER
      .map((_, r) => deltaForBlock(16, [0, 5, 15, 40, 1000][r], LADDER_MEAN))
      .reduce((a, b) => a + b, 0) / DELTA_LADDER.length;
    expect(mean).toBeCloseTo(16, 6);
  });

  it("is deterministic, so encoder and decoder agree", () => {
    for (const a of [0, 3, 4, 11, 12, 29, 30, 69, 70, 5000]) {
      expect(deltaForBlock(16, a, LADDER_MEAN)).toBe(deltaForBlock(16, a, LADDER_MEAN));
    }
  });

  it("keeps blocks near a rung boundary on the same rung after small drift", () => {
    // Channel damage nudges activity; coarse rungs mean a nudge rarely flips
    // the step size, and when it does it costs one bit, not the payload.
    expect(activityRung(11.6)).toBe(activityRung(11.9));
    expect(activityRung(31)).toBe(activityRung(35));
  });
});

describe("cover geometry", () => {
  it("centre-crops to square for Instagram, losing the same amount each side", () => {
    const g = coverGeometry(3000, 2250, 1440, true);
    expect(g.w).toBe(1440);
    expect(g.h).toBe(1440);
    expect(g.sw).toBe(2250);
    expect(g.sh).toBe(2250);
    expect(g.sx).toBe(375);   // (3000 - 2250) / 2
    expect(g.sy).toBe(0);
  });

  it("upsizes a small cover to the square target rather than leaving it short", () => {
    // Instagram will scale a small image UP to 1440 itself, which desyncs the
    // grid. Doing it ourselves first is the whole point.
    const g = coverGeometry(800, 800, 1440, true);
    expect(g.w).toBe(1440);
    expect(g.h).toBe(1440);
  });

  it("preserves aspect ratio when not square", () => {
    const g = coverGeometry(3200, 2400, 1600, false);
    expect(g.w).toBe(1600);
    expect(g.h).toBe(1200);
    expect(g.sx).toBe(0);
    expect(g.sy).toBe(0);
  });

  it("leaves an already-small cover alone when not square", () => {
    const g = coverGeometry(1024, 768, 1600, false);
    expect(g.w).toBe(1024);
    expect(g.h).toBe(768);
  });

  it("always snaps to whole 8px DCT blocks", () => {
    for (const [w, h, t, sq] of [
      [1234, 987, 1000, false], [999, 999, 1440, true], [4096, 3072, 1600, false],
    ] as Array<[number, number, number, boolean]>) {
      const g = coverGeometry(w, h, t, sq);
      expect(g.w % 8).toBe(0);
      expect(g.h % 8).toBe(0);
    }
  });

  it("targetWidth 0 means leave dimensions alone", () => {
    const g = coverGeometry(1234, 987, 0, false);
    expect(g.w).toBe(1232);   // snapped only
    expect(g.h).toBe(984);
  });
});
