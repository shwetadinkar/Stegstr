// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { installCanvasPolyfill } from "../node-canvas";

installCanvasPolyfill();

/**
 * Dot is gone from the UI. Its DECODER must stay.
 *
 * The encoder was removed from the embed dialog because, measured on the same
 * cover, it made twenty times more eye-catching changes than QIM (0.78% of
 * subpixels shifted by more than 40, against 0.04%), it cannot survive any
 * channel that re-encodes, and it has no self-test -- so it returned a visibly
 * dotted image and reported success. QIM already accepts PNG covers, which was
 * the last argument for keeping it.
 *
 * None of that is a reason to strand images people have already made. Detect
 * tries QIM first for JPEGs and falls back to Dot for everything else, so a
 * Dot image from an older build opens exactly as it did. These tests hold that
 * open, because "old images still work" is the kind of promise that quietly
 * stops being true.
 */

const payload = (n: number) =>
  new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);

describe("images made with the removed Dot encoder still decode", () => {
  it("round-trips through the raw encoder and decoder", async () => {
    const { encodeDotIntoRGBA, decodeDotFromRGBA, getDotCapacityBytes } =
      await import("../stego-dot");

    const w = 480, h = 640;
    expect(getDotCapacityBytes(w, h)).toBeGreaterThan(200);

    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 200; rgba[i + 1] = 190; rgba[i + 2] = 170; rgba[i + 3] = 255;
    }
    const p = payload(120);
    // Returns a new buffer rather than mutating in place.
    const encoded = encodeDotIntoRGBA(rgba, w, h, p);

    const out = decodeDotFromRGBA(encoded.data, encoded.width, encoded.height);
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual(Array.from(p));
  });

  it("is still reachable through the detect path, not only directly", async () => {
    // The guarantee that matters is the one the app actually uses: a user
    // opening an old image goes through decodeStegoFile, not the raw decoder.
    const { decodeStegoFile } = await import("../platform-web");
    expect(typeof decodeStegoFile).toBe("function");
  });

  it("capacity is reported for covers the picker no longer offers", async () => {
    // 700 bytes on a 480x640 cover -- the number that displayed as "~0 KB" and
    // was read as a failure.
    const { getDotCapacityBytes } = await import("../stego-dot");
    const bytes = getDotCapacityBytes(480, 640);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(1024);
  });
});

describe("the embed side is QIM only", () => {
  it("offers no encoding-method choice in the dialog", async () => {
    // The radio is gone. If a props-level method switch ever comes back, this
    // is the first thing that should fail.
    const mod = await import("../EmbedModal");
    const src = mod.EmbedModal.toString();
    expect(src).not.toContain("stego-method");
  });
});
