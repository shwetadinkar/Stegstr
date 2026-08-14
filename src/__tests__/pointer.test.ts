import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";

// Same polyfill the other crypto tests use: Node has no crypto.subtle on the
// global by default.
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

const RELAYS = ["wss://relay.primal.net", "wss://relay.damus.io", "wss://nos.lol"];

async function makeKey(): Promise<string> {
  const Nostr = await import("../nostr-stub");
  return Nostr.bytesToHex(Nostr.generateSecretKey());
}

async function makeBundle(n: number): Promise<string> {
  const Nostr = await import("../nostr-stub");
  const sk = Nostr.generateSecretKey();
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push(
      await Nostr.finishEventAsync(
        { kind: 1, content: `note number ${i} with some text in it`, tags: [], created_at: 1700000000 + i },
        sk,
      ),
    );
  }
  return JSON.stringify({ version: 1, events });
}

/** Stands in for the relay: hands back exactly the event that was published. */
function fetcherFor(event: { id: string } & Record<string, unknown>) {
  return async (id: string) => (id === event.id ? (event as never) : null);
}

describe("pointer tier", () => {
  it("round-trips a bundle through a pointer in open mode", async () => {
    const { buildPointer, parsePointer, resolvePointer } = await import("../pointer");
    const { decryptApp } = await import("../stego-crypto");
    const priv = await makeKey();
    const bundleJson = await makeBundle(3);

    const built = await buildPointer({ bundleJson, privKeyHex: priv, relays: RELAYS });

    // What lands in the image is an encrypted pointer, not the bundle.
    const pointerJson = await decryptApp(built.pointerBytes);
    const parsed = parsePointer(pointerJson);
    expect(parsed).not.toBeNull();
    expect(parsed!.i).toBe(built.event.id);
    expect(parsed!.k).toMatch(/^[0-9a-f]{64}$/);

    const resolved = await resolvePointer(parsed!, fetcherFor(built.event), priv);
    expect(resolved).toBe(bundleJson);
  });

  /**
   * The entire justification for this tier. If the embedded payload grew with
   * the feed, pointer mode would just be a slower way to hit the same wall.
   */
  it("embeds the same number of bytes regardless of how large the feed is", async () => {
    const { buildPointer } = await import("../pointer");
    const priv = await makeKey();

    const small = await buildPointer({ bundleJson: await makeBundle(1), privKeyHex: priv, relays: RELAYS });
    const large = await buildPointer({ bundleJson: await makeBundle(200), privKeyHex: priv, relays: RELAYS });

    expect(large.pointerBytes.length).toBe(small.pointerBytes.length);
    // And the large bundle really was large -- otherwise this proves nothing.
    expect(large.event.content.length).toBeGreaterThan(20 * small.event.content.length);
  });

  it("stays under the byte ceiling, trimming relay hints when it must", async () => {
    const { buildPointer, MAX_POINTER_BYTES } = await import("../pointer");
    const priv = await makeKey();
    const bundleJson = await makeBundle(2);

    const normal = await buildPointer({ bundleJson, privKeyHex: priv, relays: RELAYS });
    expect(normal.pointerBytes.length).toBeLessThanOrEqual(MAX_POINTER_BYTES);
    expect(normal.droppedHints).toBe(0);

    // Absurdly long relay URLs: the hints have to give way, not the ceiling.
    const longRelays = [
      `wss://${"a".repeat(90)}.example.com`,
      `wss://${"b".repeat(90)}.example.com`,
      `wss://${"c".repeat(90)}.example.com`,
    ];
    const squeezed = await buildPointer({ bundleJson, privKeyHex: priv, relays: longRelays });
    expect(squeezed.pointerBytes.length).toBeLessThanOrEqual(MAX_POINTER_BYTES);
    expect(squeezed.droppedHints).toBeGreaterThan(0);
  });

  it("keeps the feed unreadable to the relay holding it", async () => {
    const { buildPointer } = await import("../pointer");
    const { decryptApp } = await import("../stego-crypto");
    const priv = await makeKey();
    const bundleJson = await makeBundle(3);

    const built = await buildPointer({ bundleJson, privKeyHex: priv, relays: RELAYS });

    // Everything a relay operator can see, without the image.
    expect(built.event.content).not.toContain("note number");
    const blob = Uint8Array.from(atob(built.event.content), (c) => c.charCodeAt(0));
    // The app key is derived from a constant salt, so it is public knowledge.
    // It must not be what protects a blob sitting on a public relay.
    await expect(decryptApp(blob)).rejects.toThrow();
  });

  it("restricts the blob to recipients and carries no key in the pointer", async () => {
    const { buildPointer, parsePointer, resolvePointer } = await import("../pointer");
    const { decryptApp } = await import("../stego-crypto");
    const Nostr = await import("../nostr-stub");
    const sender = await makeKey();
    const recipient = await makeKey();
    const stranger = await makeKey();
    const recipientPk = Nostr.getPublicKey(Nostr.hexToBytes(recipient));
    const bundleJson = await makeBundle(2);

    const built = await buildPointer({
      bundleJson, privKeyHex: sender, relays: RELAYS, recipients: [recipientPk],
    });

    const parsed = parsePointer(await decryptApp(built.pointerBytes))!;
    expect(parsed.k).toBeUndefined();

    const asRecipient = await resolvePointer(parsed, fetcherFor(built.event), recipient);
    expect(asRecipient).toBe(bundleJson);

    // Holding the image is not enough when the sender named recipients.
    await expect(resolvePointer(parsed, fetcherFor(built.event), stranger)).rejects.toThrow();
  });

  it("tells the user the content is missing rather than that the image is bad", async () => {
    const { buildPointer, parsePointer, resolvePointer, PointerUnresolved } = await import("../pointer");
    const { decryptApp } = await import("../stego-crypto");
    const priv = await makeKey();
    const built = await buildPointer({ bundleJson: await makeBundle(1), privKeyHex: priv, relays: RELAYS });
    const parsed = parsePointer(await decryptApp(built.pointerBytes))!;

    // Relay has nothing for this id.
    const err = await resolvePointer(parsed, async () => null, priv).catch((e) => e);
    expect(err).toBeInstanceOf(PointerUnresolved);
    expect(err.message).toMatch(/no relay returned|propagated/i);
    // Specifically, it must not blame the image -- that sends the user off to
    // re-shoot a photo, which cannot help.
    expect(err.message).not.toMatch(/not a stegstr image|invalid payload/i);
  });

  it("refuses a pointer from a newer version instead of misreading it", async () => {
    const { parsePointer, resolvePointer, PointerUnresolved } = await import("../pointer");
    const future = parsePointer(JSON.stringify({ t: "p", v: 99, i: "a".repeat(64), k: "b".repeat(64) }))!;
    const err = await resolvePointer(future, async () => null, await makeKey()).catch((e) => e);
    expect(err).toBeInstanceOf(PointerUnresolved);
    expect(err.message).toMatch(/newer version/i);
  });

  describe("parsePointer", () => {
    it("does not mistake a self-contained bundle for a pointer", async () => {
      const { parsePointer, isPointer } = await import("../pointer");
      const bundle = await makeBundle(2);
      expect(parsePointer(bundle)).toBeNull();
      expect(isPointer(bundle)).toBe(false);
    });

    it("rejects malformed pointers", async () => {
      const { parsePointer } = await import("../pointer");
      expect(parsePointer("not json")).toBeNull();
      expect(parsePointer("null")).toBeNull();
      expect(parsePointer(JSON.stringify({ t: "p" }))).toBeNull();
      // Short id, non-hex id, and a key that is not a key.
      expect(parsePointer(JSON.stringify({ t: "p", v: 1, i: "abc" }))).toBeNull();
      expect(parsePointer(JSON.stringify({ t: "p", v: 1, i: "z".repeat(64) }))).toBeNull();
      expect(parsePointer(JSON.stringify({ t: "p", v: 1, i: "a".repeat(64), k: "nope" }))).toBeNull();
      expect(parsePointer(JSON.stringify({ t: "p", v: 1, i: "a".repeat(64), r: [1, 2] }))).toBeNull();
    });

    it("accepts a pointer with no relay hints", async () => {
      const { parsePointer } = await import("../pointer");
      const p = parsePointer(JSON.stringify({ t: "p", v: 1, i: "A".repeat(64) }));
      expect(p).not.toBeNull();
      // Normalised to lowercase so id comparisons against relay output hold.
      expect(p!.i).toBe("a".repeat(64));
    });
  });

  it("falls back to the user's own relays when hints were trimmed away", async () => {
    const { resolvePointer, PointerUnresolved } = await import("../pointer");
    const pointer = { t: "p" as const, v: 1, i: "a".repeat(64), k: "b".repeat(64) };

    // No hints and no fallbacks: nothing to try, and it says so.
    const err = await resolvePointer(pointer, async () => null, await makeKey(), []).catch((e) => e);
    expect(err).toBeInstanceOf(PointerUnresolved);
    expect(err.message).toMatch(/no relays available/i);

    // With fallbacks, those are what gets queried.
    let queried: string[] = [];
    await resolvePointer(pointer, async (_id, relays) => { queried = relays; return null; }, await makeKey(), RELAYS)
      .catch(() => {});
    expect(queried).toEqual(RELAYS);
  });
});
