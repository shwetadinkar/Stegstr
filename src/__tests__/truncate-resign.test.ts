import { describe, it, expect } from "vitest";
import * as Nostr from "../nostr-stub";
import { verifyEvent } from "../sync-engine";

/**
 * A note too long for a cover image is carried shortened rather than dropped.
 *
 * The constraint that shapes this: a nostr event's `content` is covered by its
 * id (a hash over the serialised event) and by `sig`. Cutting the content
 * therefore invalidates both, and the far side's `verifyEvent` rejects it --
 * unless the note is re-signed. These tests pin the two halves of that: a cut
 * note that is NOT re-signed must fail verification (otherwise the app would be
 * shipping events that silently fail on decode), and one that IS re-signed must
 * pass (otherwise the truncation feature carries nothing usable).
 */

const TRUNCATE_MARKER = " […cut to fit image]";

async function ownNote(sk: Uint8Array, content: string) {
  return (await Nostr.finishEventAsync(
    { kind: 1, content, tags: [], created_at: Math.floor(Date.now() / 1000) },
    sk,
  )) as never;
}

describe("truncate-and-re-sign for over-long notes", () => {
  it("a cut note that is not re-signed fails verification", async () => {
    const sk = Nostr.generateSecretKey();
    const original = await ownNote(sk, "x".repeat(2000));
    expect(verifyEvent(original)).toBe(true);

    // Naive truncation: rewrite content, keep the original id and sig.
    const naive = { ...(original as Record<string, unknown>), content: "x".repeat(200) };
    expect(verifyEvent(naive as never)).toBe(false);
  });

  it("a cut note that is re-signed verifies, and keeps author and timestamp", async () => {
    const sk = Nostr.generateSecretKey();
    const pubkey = Nostr.getPublicKey(sk);
    const original = await ownNote(sk, "y".repeat(2000));

    const cut = (await Nostr.finishEventAsync(
      {
        kind: (original as { kind: number }).kind,
        content: "y".repeat(200).trimEnd() + TRUNCATE_MARKER,
        tags: (original as { tags: string[][] }).tags,
        created_at: (original as { created_at: number }).created_at,
      },
      sk,
    )) as never;

    expect(verifyEvent(cut)).toBe(true);
    expect((cut as { pubkey: string }).pubkey).toBe(pubkey);
    expect((cut as { created_at: number }).created_at).toBe(
      (original as { created_at: number }).created_at,
    );
    // A different event, not a duplicate of the original -- so the far side
    // offers it as new rather than silently discarding it as already-held.
    expect((cut as { id: string }).id).not.toBe((original as { id: string }).id);
    expect((cut as { content: string }).content.endsWith(TRUNCATE_MARKER)).toBe(true);
  });

  it("re-signing is only possible for keys we hold", async () => {
    // The reason other authors' notes are dropped whole rather than cut: with
    // only their pubkey there is no way to produce a valid signature, and
    // signing altered text with our own key would change the author, putting
    // words in someone else's mouth.
    const theirSk = Nostr.generateSecretKey();
    const oursSk = Nostr.generateSecretKey();
    const theirNote = await ownNote(theirSk, "z".repeat(2000));

    const forged = (await Nostr.finishEventAsync(
      {
        kind: 1,
        content: "z".repeat(200) + TRUNCATE_MARKER,
        tags: [],
        created_at: (theirNote as { created_at: number }).created_at,
      },
      oursSk,
    )) as never;

    // It verifies, but as OUR event -- the authorship changed, which is
    // exactly why this path is not taken for other people's notes.
    expect(verifyEvent(forged)).toBe(true);
    expect((forged as { pubkey: string }).pubkey).not.toBe(
      (theirNote as { pubkey: string }).pubkey,
    );
  });
});
