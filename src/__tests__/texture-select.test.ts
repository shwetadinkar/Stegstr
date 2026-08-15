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
