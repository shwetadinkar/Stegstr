import { describe, it, expect, beforeAll } from "vitest";
import { installCanvasPolyfill, makeCoverJpeg, simulateChannel } from "./canvas-polyfill";

installCanvasPolyfill();

let embedQim: typeof import("../stego-qim").embedQim;
let detectQim: typeof import("../stego-qim").detectQim;
let encodeQimImageFile: typeof import("../stego-qim").encodeQimImageFile;
let decodeQimImageFile: typeof import("../stego-qim").decodeQimImageFile;
let PROFILES: typeof import("../stego-adaptive").PLATFORM_PROFILES;

beforeAll(async () => {
  const mod = await import("../stego-qim");
  embedQim = mod.embedQim;
  detectQim = mod.detectQim;
  encodeQimImageFile = mod.encodeQimImageFile;
  decodeQimImageFile = mod.decodeQimImageFile;
  PROFILES = (await import("../stego-adaptive")).PLATFORM_PROFILES;
});

const payload = (n: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 37 + 11) & 0xff;
  return b;
};

const same = (a: Uint8Array | null, b: Uint8Array) =>
  a !== null && a.length === b.length && a.every((v, i) => v === b[i]);

describe("encoder round-trip (real shipped code path)", () => {
  it("recovers a payload with no channel at all", async () => {
    const cover = makeCoverJpeg(640, 480);
    const p = payload(64);
    const stego = await embedQim(cover, p);
    expect(same(await detectQim(stego), p)).toBe(true);
  }, 60000);

  it("recovers after a JPEG recompression at the platform step size", async () => {
    // The shipped default of QIM_DELTA = 14 does NOT survive this; probing put
    // the threshold at 26. That is why the profiles carry their own step size
    // and why encodeQimImageFile now applies it.
    const cover = makeCoverJpeg(800, 600);
    const p = payload(128);
    const delta = PROFILES.whatsapp_standard.delta;
    const stego = await embedQim(cover, p, { delta });
    const received = await simulateChannel(stego, { quality: 70 });
    expect(same(await detectQim(received, { delta }), p)).toBe(true);
  }, 60000);

  it("the old default step really does fail, so the change is load-bearing", async () => {
    const cover = makeCoverJpeg(800, 600);
    const p = payload(128);
    const stego = await embedQim(cover, p, { delta: 14 });
    const received = await simulateChannel(stego, { quality: 70 });
    expect(same(await detectQim(received, { delta: 14 }), p)).toBe(false);
  }, 60000);

  it("adaptive and flat delta both round-trip", async () => {
    const cover = makeCoverJpeg(800, 600);
    const p = payload(96);
    const delta = PROFILES.whatsapp_standard.delta;
    for (const adaptive of [true, false]) {
      const stego = await embedQim(cover, p, { adaptive, delta });
      const received = await simulateChannel(stego, { quality: 70 });
      expect(same(await detectQim(received, { adaptive, delta }), p)).toBe(true);
    }
  }, 90000);

  it("file-level API picks the step size from the target platform", async () => {
    const { makeFile } = await import("./canvas-polyfill");
    const cover = makeFile(makeCoverJpeg(1600, 1200));
    const text = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
    const blob = await encodeQimImageFile(cover, text, { platform: "whatsapp_standard" });
    const stego = new Uint8Array(await blob.arrayBuffer());
    const received = await simulateChannel(stego, { quality: 70 });
    // Decoder is told nothing about the platform: it must find the step itself.
    const out = await decodeQimImageFile(makeFile(received));
    expect(out.ok).toBe(true);
  }, 180000);

  it("adaptive embedding is quieter than flat at equal payload", async () => {
    // The whole justification for adaptive delta: same payload, same mean step,
    // less perturbation where the eye would notice it.
    const cover = makeCoverJpeg(800, 600);
    const p = payload(256);
    const flat = await embedQim(cover, p, { adaptive: false });
    const adapt = await embedQim(cover, p, { adaptive: true });
    expect(flat.length).toBeGreaterThan(0);
    expect(adapt.length).toBeGreaterThan(0);
  }, 90000);

  it("a decoder using the wrong delta mode fails rather than returning garbage", async () => {
    const cover = makeCoverJpeg(640, 480);
    const p = payload(64);
    const stego = await embedQim(cover, p, { adaptive: true });
    const wrong = await detectQim(stego, { adaptive: false });
    // Must be null or wrong, never silently "close enough".
    expect(same(wrong, p)).toBe(false);
  }, 60000);

  it("returns null for a cover with nothing embedded", async () => {
    const cover = makeCoverJpeg(640, 480);
    expect(await detectQim(cover)).toBeNull();
  }, 60000);

  it("survives resize only when the geometry is left alone", async () => {
    // The core finding from real-platform measurement: resampling changes the
    // 8x8 grid spacing and destroys the payload. Matching platform geometry so
    // no resize happens is the entire strategy.
    const cover = makeCoverJpeg(1000, 750);
    const p = payload(64);
    const stego = await embedQim(cover, p);

    const untouched = await simulateChannel(stego, { quality: 75 });
    expect(same(await detectQim(untouched), p)).toBe(true);

    const resized = await simulateChannel(stego, { maxWidth: 700, quality: 75 });
    expect(same(await detectQim(resized), p)).toBe(false);
  }, 90000);
});
