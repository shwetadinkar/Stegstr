import { it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import { installCanvasPolyfill, makeCoverJpeg } from "./canvas-polyfill";
installCanvasPolyfill();

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

/**
 * The pointer tier end to end through the SHIPPED encoder: build a pointer from
 * a real bundle, embed it, read it back out of the JPEG, and follow it to the
 * original bundle.
 *
 * What this proves: the plumbing holds. The bytes that go into the image are
 * the bytes that come out, the pointer survives being encoded and re-parsed,
 * and the resolve path reconstructs the feed exactly.
 *
 * What this does NOT prove, and must not be read as proving: that pointer mode
 * survives Telegram. This is a synthetic cover and a simulated channel, and
 * §15.5 records a synthetic cover certifying a profile that could not decode
 * itself on a real photo. The channel claim needs a phone.
 */
it("a pointer survives embed and read-back on telegram_photo", async () => {
  const { encodeQimImageFile, decodeQimImageFile, getQimCapacityForFile } = await import("../stego-qim");
  const { buildPointer, parsePointer, resolvePointer, MAX_POINTER_BYTES } = await import("../pointer");
  const { decryptApp } = await import("../stego-crypto");
  const Nostr = await import("../nostr-stub");

  const sk = Nostr.generateSecretKey();
  const priv = Nostr.bytesToHex(sk);
  const events = [];
  for (let i = 0; i < 40; i++) {
    events.push(
      await Nostr.finishEventAsync(
        { kind: 1, content: `pointer tier test note ${i}, long enough to matter`, tags: [], created_at: 1700000000 + i },
        sk,
      ),
    );
  }
  const bundleJson = JSON.stringify({ version: 1, events });

  const built = await buildPointer({
    bundleJson,
    privKeyHex: priv,
    relays: ["wss://relay.primal.net", "wss://relay.damus.io", "wss://nos.lol"],
  });
  expect(built.pointerBytes.length).toBeLessThanOrEqual(MAX_POINTER_BYTES);

  // The comparison that makes the point: a 40-note feed is kilobytes, and the
  // thing that has to survive the channel is a few hundred bytes.
  console.log(
    `bundle ${bundleJson.length}B -> pointer ${built.pointerBytes.length}B ` +
    `(${(bundleJson.length / built.pointerBytes.length).toFixed(1)}x smaller)`,
  );
  expect(built.pointerBytes.length).toBeLessThan(bundleJson.length / 10);

  const cover = new File([makeCoverJpeg(2400, 1800, 11)], "c.jpg", { type: "image/jpeg" });
  const cap = await getQimCapacityForFile(cover, "telegram_photo");
  console.log("telegram_photo capacity:", JSON.stringify(cap));

  const blob = await encodeQimImageFile(cover, built.pointerBytes, { platform: "telegram_photo" });
  const stego = new File([new Uint8Array(await blob.arrayBuffer())], "s.jpg", { type: "image/jpeg" });

  const out = await decodeQimImageFile(stego);
  console.log("decode:", out.ok, out.error ?? "");
  expect(out.ok).toBe(true);

  // decodeQimImageFile hands back the payload the way the detect path receives
  // it, so unwrap it the same way App.tsx does.
  const raw = out.payload!;
  const recovered = raw.startsWith("base64:")
    ? Uint8Array.from(atob(raw.slice(7)), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(raw);
  expect(Array.from(recovered)).toEqual(Array.from(built.pointerBytes));

  // And the recovered bytes really do lead back to the feed.
  const pointer = parsePointer(await decryptApp(recovered));
  expect(pointer).not.toBeNull();
  const resolved = await resolvePointer(
    pointer!,
    async (id) => (id === built.event.id ? (built.event as never) : null),
    priv,
  );
  expect(resolved).toBe(bundleJson);
}, 600000);
