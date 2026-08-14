import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import { installCanvasPolyfill, makeCoverJpeg } from "./canvas-polyfill";
installCanvasPolyfill();

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

/**
 * §17.4: spread slot ordering, on telegram_photo only.
 *
 * The defect it fixes is not a failure -- ac-major works -- it is waste. A
 * pointer-sized payload used 12.1% of capacity but put 100% of its
 * perturbation on zigzag 1 across 72.7% of blocks, which §15.2 measured as the
 * coherent grating human vision picks out best.
 */
describe("slot ordering", () => {
  it("telegram_photo carries a pointer-sized payload and reads it back", async () => {
    const { encodeQimImageFile, decodeQimImageFile, qimSelfTest } = await import("../stego-qim");
    const cover = new File([makeCoverJpeg(2400, 1800, 11)], "c.jpg", { type: "image/jpeg" });
    const payload = new Uint8Array(264).map((_, i) => (i * 37 + 11) & 0xff);

    const blob = await encodeQimImageFile(cover, payload, { platform: "telegram_photo" });
    expect((await qimSelfTest(blob, payload)).ok).toBe(true);

    const out = await decodeQimImageFile(
      new File([new Uint8Array(await blob.arrayBuffer())], "s.jpg", { type: "image/jpeg" }),
    );
    expect(out.ok).toBe(true);
  }, 600000);

  /**
   * The compatibility guarantee. Ordering is not recoverable from the file --
   * a wrong order reads the right coefficients in the wrong sequence and fails
   * exactly like a wrong delta -- so an image made under ac-major must still
   * be decodable now that the profile declares spread.
   */
  it("still decodes an image embedded with the old ac-major ordering", async () => {
    const { encodeQimImageFile, decodeQimImageFile } = await import("../stego-qim");
    const cover = new File([makeCoverJpeg(2400, 1800, 11)], "c.jpg", { type: "image/jpeg" });
    const payload = new Uint8Array(200).map((_, i) => (i * 13 + 5) & 0xff);

    // Exactly what the previous build produced for this profile.
    const legacy = await encodeQimImageFile(cover, payload, {
      platform: "telegram_photo", slotOrder: "ac-major", repeat: 5,
    });
    const out = await decodeQimImageFile(
      new File([new Uint8Array(await legacy.arrayBuffer())], "legacy.jpg", { type: "image/jpeg" }),
    );
    expect(out.ok).toBe(true);
  }, 600000);

  describe("the spread mapping itself", () => {
    it("uses every slot exactly once, so nothing is lost or written twice", async () => {
      const { buildCoeffStreamForTest } = await import("../stego-qim");
      const [by, bx, ac] = [12, 16, 6];
      const stream = buildCoeffStreamForTest(by, bx, ac, "spread");
      expect(stream.length).toBe(by * bx * ac);
      const seen = new Set(stream.map((p) => `${p.blockRow},${p.blockCol},${p.zigzagIdx}`));
      expect(seen.size).toBe(by * bx * ac);
    });

    it("scatters a partial payload across all AC positions and the whole frame", async () => {
      const { buildCoeffStreamForTest } = await import("../stego-qim");
      const [by, bx, ac] = [120, 160, 6];
      const used = 13960; // the measured slot count for a 264 B pointer

      const acMajor = buildCoeffStreamForTest(by, bx, ac, "ac-major").slice(0, used);
      const spread = buildCoeffStreamForTest(by, bx, ac, "spread").slice(0, used);

      const freqs = (s: typeof acMajor) => new Set(s.map((p) => p.zigzagIdx)).size;
      const rows = (s: typeof acMajor) => new Set(s.map((p) => p.blockRow)).size;

      // Before: one frequency, top rows only. After: every frequency, every row.
      expect(freqs(acMajor)).toBe(1);
      expect(freqs(spread)).toBe(ac);
      expect(rows(acMajor)).toBeLessThan(by * 0.8);
      expect(rows(spread)).toBe(by);

      // Both touch one coefficient per block -- the win is not fewer blocks,
      // it is WHICH coefficient and WHERE. ac-major puts every one of them on
      // zigzag 1 inside the top 73% of rows; spread puts them on all six
      // positions across every row. Same count, incoherent instead of a
      // grating.
      const blocks = (s: typeof acMajor) => new Set(s.map((p) => `${p.blockRow},${p.blockCol}`)).size;
      expect(blocks(spread)).toBe(used);
      expect(blocks(acMajor)).toBe(used);
    });
  });
});
