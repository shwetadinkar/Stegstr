import { describe, it, expect } from "vitest";

/**
 * Covers are never enlarged, and that is a silent failure mode.
 *
 * `coverGeometry` gates its resize on `w > targetWidth`, so a photo narrower
 * than the platform's target keeps its own size. For WhatsApp that is harmless
 * -- it passes anything at or below 1600 through untouched. For Telegram it is
 * not: Telegram re-encodes every photo to 1280x960, so an undersized cover is
 * resampled on arrival, and resampling moves the 8x8 grid the payload lives in
 * (§3.1).
 *
 * Nothing in the encode path can detect this. The self-test verifies the file
 * as written, not as the platform returns it, so it passes. These tests pin the
 * behaviour so the geometry warning in the UI and the MCP server keeps having
 * something real to warn about.
 */
describe("coverGeometry", () => {
  it("downscales a large cover to the platform width", async () => {
    const { coverGeometry } = await import("../stego-qim");
    const g = coverGeometry(4096, 3072, 1600, false);
    expect(g.w).toBe(1600);
    expect(g.h).toBe(1200);
  });

  it("leaves an undersized cover alone rather than enlarging it", async () => {
    const { coverGeometry } = await import("../stego-qim");
    const g = coverGeometry(1024, 768, 1600, false);
    // Not 1600: this is the case the warning exists for.
    expect(g.w).toBe(1024);
    expect(g.h).toBe(768);
  });

  it("always produces the target size for square platforms", async () => {
    const { coverGeometry } = await import("../stego-qim");
    // Instagram normalises to a square canvas, so the square branch resizes
    // unconditionally -- an undersized cover IS enlarged here.
    const g = coverGeometry(1024, 768, 1440, true);
    expect(g.w).toBe(1440);
    expect(g.h).toBe(1440);
  });

  it("snaps to whole 8x8 blocks so the DCT grid stays aligned", async () => {
    const { coverGeometry } = await import("../stego-qim");
    const g = coverGeometry(1001, 667, 0, false);
    expect(g.w % 8).toBe(0);
    expect(g.h % 8).toBe(0);
  });

  it("centre-crops rather than padding when squaring", async () => {
    const { coverGeometry } = await import("../stego-qim");
    const g = coverGeometry(2000, 1000, 1440, true);
    // Source rect is the centred 1000x1000 square, not the full frame with
    // bars: padding would add flat regions, which carry nothing and look
    // obviously processed.
    expect(g.sw).toBe(1000);
    expect(g.sh).toBe(1000);
    expect(g.sx).toBe(500);
    expect(g.sy).toBe(0);
  });
});
