import { describe, it, expect, beforeAll } from "vitest";
import { installCanvasPolyfill, makeCoverJpeg, makeFile } from "../node-canvas";

installCanvasPolyfill();

let encodeQimImageFile: typeof import("../stego-qim").encodeQimImageFile;
let decodeQimImageFile: typeof import("../stego-qim").decodeQimImageFile;

beforeAll(async () => {
  const mod = await import("../stego-qim");
  encodeQimImageFile = mod.encodeQimImageFile;
  decodeQimImageFile = mod.decodeQimImageFile;
});

/**
 * Splice a minimal EXIF APP1 segment carrying only Orientation into a JPEG.
 *
 * Written by hand rather than pulled from a library because the assertion is
 * about a byte in the file, and a dependency that "helpfully" normalises
 * orientation would be testing itself.
 *
 * Layout after the FFE1 marker and its 2-byte length: "Exif\0\0", a
 * big-endian TIFF header, one IFD entry (tag 0x0112, type SHORT, count 1),
 * and a zero next-IFD offset.
 */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const app1 = [
    0xff, 0xe1, 0x00, 0x22,                          // APP1, length 34
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,              // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,  // TIFF header, big-endian
    0x00, 0x01,                                      // one IFD entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,  // tag 0x0112, SHORT, count 1
    (orientation >> 8) & 0xff, orientation & 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,                          // no next IFD
  ];
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2), 0);                   // SOI
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}

const hasExif = (b: Uint8Array) => {
  for (let i = 0; i + 5 < b.length; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x78 && b[i + 2] === 0x69
        && b[i + 3] === 0x66 && b[i + 4] === 0x00 && b[i + 5] === 0x00) return true;
  }
  return false;
};

async function sizeOf(bytes: Uint8Array): Promise<{ w: number; h: number }> {
  const { loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(Buffer.from(bytes));
  return { w: img.width, h: img.height };
}

/**
 * WhatsApp applies EXIF orientation PHYSICALLY and drops the flag: measured,
 * a 3840x2160 upload with orientation=6 came back 2160x3840 with no
 * orientation tag at all (calibration/whatsapp_hd_returns).
 *
 * That matters because a 90 degree rotation is not a degradation, it is a
 * total loss -- the 8x8 grid the decoder walks is transposed, so it reads
 * noise. Measured on this encoder: an upright stego image decodes, the same
 * image rotated 90 degrees recovers nothing.
 *
 * We are not exposed to it, and these tests hold that open. The encoder
 * rasterises through the same orientation-applying path and writes its output
 * through canvas, which emits no EXIF -- so what leaves here is already
 * upright with no flag, and there is nothing left for a platform to act on.
 * If either half of that ever changes, every payload sent to WhatsApp from a
 * portrait phone photo dies silently.
 */
describe("EXIF orientation is applied before embedding, not carried", () => {
  it("a cover marked orientation=6 embeds upright, with no flag left", async () => {
    const landscape = makeCoverJpeg(640, 480);
    expect((await sizeOf(landscape)).w).toBe(640);

    // orientation=6 means "rotate 90 CW to display", i.e. 640x480 stored is
    // meant to be seen as 480x640.
    const cover = withOrientation(landscape, 6);
    expect(hasExif(cover)).toBe(true);

    const blob = await encodeQimImageFile(
      makeFile(cover), new TextEncoder().encode("upright"), { platform: "robust" },
    );
    const out = new Uint8Array(await blob.arrayBuffer());

    // Applied: the stored raster is now the orientation the viewer would see.
    const { w, h } = await sizeOf(out);
    expect(`${w}x${h}`).toBe("480x640");
    // And stripped: no EXIF survives, so no downstream service can rotate it
    // a second time.
    expect(hasExif(out)).toBe(false);
    // The payload is readable in that orientation, which is the whole point.
    expect((await decodeQimImageFile(makeFile(out))).ok).toBe(true);
  }, 180000);

  it("a 90 degree rotation destroys a payload, which is why the above matters", async () => {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const blob = await encodeQimImageFile(
      makeFile(makeCoverJpeg(640, 480)), new TextEncoder().encode("upright"),
      { platform: "robust" },
    );
    const stego = new Uint8Array(await blob.arrayBuffer());
    expect((await decodeQimImageFile(makeFile(stego))).ok).toBe(true);

    const img = await loadImage(Buffer.from(stego));
    const c = createCanvas(img.height, img.width);
    const ctx = c.getContext("2d");
    ctx.translate(img.height / 2, img.width / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    const rotated = new Uint8Array(c.toBuffer("image/jpeg", 95));

    // Not degraded -- gone. The grid is transposed, so the decoder is reading
    // coefficients that were never written.
    expect((await decodeQimImageFile(makeFile(rotated))).ok).toBe(false);
  }, 180000);
});
