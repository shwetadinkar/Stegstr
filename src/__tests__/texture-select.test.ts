import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import { installCanvasPolyfill, makeCoverJpeg, simulateChannel } from "../node-canvas";
installCanvasPolyfill();

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

const same = (a: Uint8Array | null, b: Uint8Array) =>
  a !== null && a.length === b.length && a.every((v, i) => v === b[i]);
const payload = (n: number) => new Uint8Array(n).map((_, i) => (i * 37 + 11) & 0xff);

/**
 * §17.14: skip the flattest blocks.
 *
 * Off by default, and NOT working end to end -- see the first test. The
 * mechanism is in place and the texture measure is sound, but a payload does
 * not survive the round trip for a reason unrelated to selection. These tests
 * pin exactly where it breaks so the next attempt starts from the diagnosis
 * rather than rediscovering it.
 */
describe("texture-selected block filling", () => {
  /**
   * KNOWN LIMITATION, pinned deliberately.
   *
   * The mechanism works -- the texture measure is stable and the encoder does
   * skip flat blocks -- but a payload does not round-trip, and the cause is not
   * the selection. The 2-byte codeword-length header is unprotected and sits in
   * the FIRST slots of the stream, which under AC-major ordering are the first
   * blocks in raster order: the top of the image. Measured on a synthetic
   * cover, 75 of the first 80 blocks score zero, so the header is written into
   * blocks the encoder skips and decode fails on a garbage length before
   * Reed-Solomon runs at all.
   *
   * That is why neither more parity (rsNsym 200) nor more repetition
   * (repeat 15) rescues it: the failure is upstream of error correction.
   *
   * Asserting the failure rather than deleting the test, so that whoever fixes
   * the header finds a test that flips to passing and knows immediately that
   * they fixed the right thing.
   */
  it("does NOT yet round-trip — the length header lands in skipped blocks", async () => {
    const { embedQim, detectQim } = await import("../stego-qim");
    const cover = makeCoverJpeg(1200, 900, 11);
    const p = payload(96);
    const opts = { delta: 28, lumaAcCount: 6, rsNsym: 32, textureFloor: 3 };
    const stego = await embedQim(cover, p, opts);
    expect(same(await detectQim(stego, opts), p)).toBe(false);
  }, 120000);

  it("actually writes to fewer blocks", async () => {
    // The point of the change. If the two images were identical the floor
    // would be doing nothing, and the test above would pass for the wrong
    // reason.
    const { embedQim } = await import("../stego-qim");
    const cover = makeCoverJpeg(1200, 900, 11);
    const p = payload(96);
    const base = { delta: 28, lumaAcCount: 6, rsNsym: 32 };
    const plain = await embedQim(cover, p, base);
    const floored = await embedQim(cover, p, { ...base, textureFloor: 6 });
    expect(Array.from(floored)).not.toEqual(Array.from(plain));
  }, 120000);

  it("a floor of zero changes nothing, so the default path is untouched", async () => {
    const { embedQim } = await import("../stego-qim");
    const cover = makeCoverJpeg(800, 600, 5);
    const p = payload(64);
    const base = { delta: 28, lumaAcCount: 6, rsNsym: 32 };
    const off = await embedQim(cover, p, base);
    const zero = await embedQim(cover, p, { ...base, textureFloor: 0 });
    expect(Array.from(zero)).toEqual(Array.from(off));
  }, 120000);

  it("no shipped profile enables it yet", async () => {
    // It has never been through a platform. Shipping it on would be exactly
    // the mistake §15.5 records: a change certified by CI and never seen by a
    // phone.
    const { PLATFORM_PROFILES } = await import("../stego-adaptive");
    for (const [name, prof] of Object.entries(PLATFORM_PROFILES)) {
      expect(`${name}:${prof.textureFloor ?? "unset"}`).toBe(`${name}:unset`);
    }
  });
});

/**
 * §19.6: the adaptive ladder measures texture on a band that cannot see it.
 *
 * Unlike the block-selection attempt above, this changes no addressing at all
 * — every block keeps its slot, so there is no header problem and no desync
 * risk. It only changes which coefficients decide a block's step size.
 */
describe("adaptive ladder band", () => {
  it("round-trips on the alternative band", async () => {
    const { embedQim, detectQim } = await import("../stego-qim");
    const cover = makeCoverJpeg(1200, 900, 11);
    const p = payload(96);
    const opts = { delta: 28, lumaAcCount: 6, rsNsym: 32, activityBand: "mid" as const };
    const stego = await embedQim(cover, p, opts);
    expect(same(await detectQim(stego, opts), p)).toBe(true);
  }, 120000);

  it("survives a recompression on the alternative band", async () => {
    const { embedQim, detectQim } = await import("../stego-qim");
    const cover = makeCoverJpeg(1200, 900, 11);
    const p = payload(96);
    const opts = { delta: 28, lumaAcCount: 6, rsNsym: 32, activityBand: "mid" as const };
    const stego = await embedQim(cover, p, opts);
    const through = await simulateChannel(stego, { quality: 70 });
    expect(same(await detectQim(through, opts), p)).toBe(true);
  }, 120000);

  it("produces a different image, so the band is doing something", async () => {
    const { embedQim } = await import("../stego-qim");
    const cover = makeCoverJpeg(1200, 900, 11);
    const p = payload(96);
    const base = { delta: 28, lumaAcCount: 6, rsNsym: 32 };
    const high = await embedQim(cover, p, base);
    const mid = await embedQim(cover, p, { ...base, activityBand: "mid" as const });
    expect(Array.from(mid)).not.toEqual(Array.from(high));
  }, 120000);

  it("decoding with the wrong band fails, so it must be declared", async () => {
    // Both sides must agree: the band decides each block's step size, and
    // reading with the wrong one reads at the wrong step.
    const { embedQim, detectQim } = await import("../stego-qim");
    const cover = makeCoverJpeg(1200, 900, 11);
    const p = payload(96);
    const base = { delta: 28, lumaAcCount: 6, rsNsym: 32 };
    const stego = await embedQim(cover, p, { ...base, activityBand: "mid" as const });
    expect(same(await detectQim(stego, base), p)).toBe(false);
  }, 120000);

  it("no shipped profile enables it, and none should", async () => {
    /*
     * §19.6 is CLOSED. The alternative band was built to fix a real defect --
     * the shipped band puts 91.9% of blocks on the lowest rung, so the ladder
     * barely discriminates and the app embeds at an effective step of 12.68
     * against a nominal 28. That measurement reproduces exactly on a real
     * 1600x1200 photo at the shipped embed quality.
     *
     * But the fix does not work. Measured on that photo, 1200-byte payload:
     *
     *   band        perturbation  masked visibility  flat blocks  survives to
     *   zz 25-40        2.52           0.487            1.64          Q65
     *   zz 7-24         3.00           0.512            1.67          Q65
     *
     * 19% more perturbation, WORSE masked visibility (§3.4's metric, the one
     * that tracks the eye), more perturbation in flat blocks rather than less,
     * and identical robustness. The whole idea rests on redistributing
     * perturbation toward blocks that can hide it, and that redistribution
     * does not happen.
     *
     * So this stays off, and the reason is a measurement rather than caution.
     */
    const { PLATFORM_PROFILES } = await import("../stego-adaptive");
    for (const [name, prof] of Object.entries(PLATFORM_PROFILES)) {
      expect(`${name}:${prof.activityBand ?? "high"}`).toBe(`${name}:high`);
    }
  });

  /**
   * The band was declarable on a profile and read from nowhere.
   *
   * encodeQimImageFile maps profile fields onto QimOptions one at a time --
   * delta, chromaDelta, rsNsym, lumaAcCount, slotOrder, repeat -- and
   * activityBand was simply missing from that list. So a profile setting
   * `activityBand: "mid"` embedded on the default band regardless, and the
   * switch did nothing whatsoever.
   *
   * That is worse than the field not existing. The point of §19.6 is to
   * evaluate the alternative band on a real photo, and the obvious way to run
   * that evaluation is to set it on a profile and look at the output -- which
   * would have compared an image against a byte-identical image and concluded
   * the band changes nothing.
   */
  it("a profile's band actually reaches the encoder", async () => {
    const { PLATFORM_PROFILES } = await import("../stego-adaptive");
    const { encodeQimImageFile } = await import("../stego-qim");

    const NAME = "__band_probe__";
    PLATFORM_PROFILES[NAME] = { ...PLATFORM_PROFILES.universal, activityBand: "mid" };
    try {
      const cover = new File([makeCoverJpeg(1200, 900, 11)], "c.jpg", { type: "image/jpeg" });
      const text = JSON.stringify({ version: 1, events: [], note: "band via profile" });
      const viaProfile = new Uint8Array(
        await (await encodeQimImageFile(cover, text, { platform: NAME })).arrayBuffer(),
      );
      const viaDefault = new Uint8Array(
        await (await encodeQimImageFile(cover, text, { platform: "universal" })).arrayBuffer(),
      );
      // Same cover, same payload, same profile in every respect but the band.
      expect(Array.from(viaProfile)).not.toEqual(Array.from(viaDefault));
    } finally {
      delete PLATFORM_PROFILES[NAME];
    }
  }, 300000);

  /**
   * End to end through the path a recipient actually takes, with no delta
   * pinned. Weaker than it looks, and worth saying so.
   *
   * The blind sweep now passes activityBand alongside the other profile
   * fields, which is the prerequisite §19.6 records. But this test does not
   * isolate that change: measured with the sweep edit reverted, a mid-band
   * image still decoded, because a *different* profile in the sweep (delta 56)
   * recovered it exactly. So this asserts the round trip works, not that the
   * sweep needs the band. The direct evidence that the band must be declared
   * is "decoding with the wrong band fails" above, where nothing comes back.
   *
   * The incidental finding is reassuring: that cross-profile recovery returned
   * the payload byte-exact rather than plausible garbage, which is precisely
   * what the magic bytes plus Reed-Solomon exist to guarantee.
   */
  it("round-trips through the blind decode path", async () => {
    const { PLATFORM_PROFILES } = await import("../stego-adaptive");
    const { encodeQimImageFile, decodeQimImageFile } = await import("../stego-qim");

    const NAME = "__band_probe__";
    PLATFORM_PROFILES[NAME] = { ...PLATFORM_PROFILES.universal, activityBand: "mid" };
    try {
      const cover = new File([makeCoverJpeg(1200, 900, 11)], "c.jpg", { type: "image/jpeg" });
      const text = JSON.stringify({ version: 1, events: [], note: "band round trip" });
      const blob = await encodeQimImageFile(cover, text, { platform: NAME });
      const stego = new File([await blob.arrayBuffer()], "s.jpg", { type: "image/jpeg" });

      const out = await decodeQimImageFile(stego);
      expect(out.ok).toBe(true);
      expect(out.payload).toBe(text);
    } finally {
      delete PLATFORM_PROFILES[NAME];
    }
  }, 300000);
});
