import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

/**
 * The combination the note picker was actually built for: one chosen note,
 * encrypted for one chosen person, carried as a pointer.
 *
 * Each half existed already and each was tested on its own. The combination
 * was not, and it was claimed to work from reading the code -- which is how
 * several things went wrong today, so it is verified here instead.
 */
describe("selected note + recipients + pointer mode", () => {
  it("carries only the chosen note, readable only by the chosen recipient", async () => {
    const { buildPointer, parsePointer, resolvePointer, MAX_POINTER_BYTES } = await import("../pointer");
    const { decryptApp } = await import("../stego-crypto");
    const Nostr = await import("../nostr-stub");

    const senderSk = Nostr.generateSecretKey();
    const sender = Nostr.bytesToHex(senderSk);
    const recipient = Nostr.bytesToHex(Nostr.generateSecretKey());
    const stranger = Nostr.bytesToHex(Nostr.generateSecretKey());
    const recipientPk = Nostr.getPublicKey(Nostr.hexToBytes(recipient));

    // Three notes exist; the user picks the middle one.
    const notes = [];
    for (const text of ["first note", "THE CHOSEN ONE", "third note"]) {
      notes.push(await Nostr.finishEventAsync(
        { kind: 1, content: text, tags: [], created_at: 1700000000 }, senderSk,
      ));
    }
    const chosen = [notes[1]];
    const bundleJson = JSON.stringify({ version: 1, events: chosen });

    const built = await buildPointer({
      bundleJson,
      privKeyHex: sender,
      relays: ["wss://relay.primal.net", "wss://nos.lol"],
      recipients: [recipientPk],
    });

    // Still a pointer, still tiny -- recipients mode carries no key, so it is
    // if anything smaller than the open case.
    expect(built.pointerBytes.length).toBeLessThanOrEqual(MAX_POINTER_BYTES);
    const pointer = parsePointer(await decryptApp(built.pointerBytes))!;
    expect(pointer.k).toBeUndefined();

    const fetcher = async (id: string) => (id === built.event.id ? (built.event as never) : null);

    // The recipient gets exactly the one note, and not the other two.
    const out = JSON.parse(await resolvePointer(pointer, fetcher, recipient));
    expect(out.events).toHaveLength(1);
    expect(out.events[0].content).toBe("THE CHOSEN ONE");

    // Holding the image is not enough for anyone else.
    await expect(resolvePointer(pointer, fetcher, stranger)).rejects.toThrow();

    // And the unselected notes are nowhere in what left the machine.
    expect(built.event.content).not.toContain("first note");
    expect(built.event.content).not.toContain("third note");
  });
});
