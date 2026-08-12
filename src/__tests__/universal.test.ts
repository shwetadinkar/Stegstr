import { it, expect } from "vitest";
import { installCanvasPolyfill, makeCoverJpeg } from "./canvas-polyfill";
installCanvasPolyfill();

it("universal profile: capacity, embed, self-test, decode", async () => {
  const { encodeQimImageFile, decodeQimImageFile, getQimCapacityForFile, qimSelfTest } =
    await import("../stego-qim");
  const { profileFor } = await import("../stego-adaptive");
  console.log("universal profile:", JSON.stringify(profileFor("universal")));

  // A 4:3 source, as most phone photos are -- universal must centre-crop it.
  const cover = new File([makeCoverJpeg(2400, 1800, 11)], "c.jpg", { type: "image/jpeg" });

  const cap = await getQimCapacityForFile(cover, "universal");
  console.log("capacity:", JSON.stringify(cap));
  expect(cap.width).toBe(1440);
  expect(cap.height).toBe(1440);

  const payload = new Uint8Array(1242).map((_, i) => (i * 31 + 7) & 0xff);
  const blob = await encodeQimImageFile(cover, payload, { platform: "universal" });
  const stego = new Uint8Array(await blob.arrayBuffer());
  console.log("stego bytes:", stego.length);

  const st = await qimSelfTest(blob, payload);
  console.log("self-test:", st.ok, st.error ?? "");
  expect(st.ok).toBe(true);

  const out = await decodeQimImageFile(new File([stego], "s.jpg", { type: "image/jpeg" }));
  console.log("decode:", out.ok, out.error ?? "");
  expect(out.ok).toBe(true);
}, 600000);
