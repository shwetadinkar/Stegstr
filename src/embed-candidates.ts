/**
 * Which events an image is allowed to carry.
 *
 * WHY THIS IS ITS OWN MODULE. This rule was written twice in App.tsx and the
 * two copies disagreed. Automatic packing took notes from you *or people you
 * follow*; the "Pick specific notes" list offered only your own. The visible
 * result was a feature that looked broken: a user who had not yet posted saw
 * the radio disabled and "you have not written any notes yet" while their feed
 * sat full of notes the automatic mode would have carried quite happily. Even
 * once they had posted, they could not pick a followed author's note that
 * automatic mode would include on its own.
 *
 * That is the same failure as the desktop detect path (HANDOFF §20.1): a
 * second implementation of a rule does not inherit changes made to the first.
 * One function now, used by both.
 */

import type { NostrEvent } from "./types";

export interface CandidateContext {
  /** Pubkeys of this user's own identities. */
  ourPubkeys: ReadonlySet<string>;
  /** Pubkeys this user follows. */
  contacts: ReadonlySet<string>;
  /** Ids of notes deleted locally or by a relayed tombstone. */
  deletedNoteIds: ReadonlySet<string>;
}

/**
 * True if this event may be carried in an image.
 *
 * Authorship: yours or someone you follow. Without this, "embed my feed"
 * silently became "embed a slice of the entire Global feed" -- strangers'
 * profile events are small and score highly on density, so at any capacity
 * tight enough to matter they crowded out the note text you actually meant to
 * send.
 *
 * Deletions: a kind-5 tombstone is ~380 bytes of pure overhead with no
 * content, which packForCapacity scores at roughly 2.3x the density of a real
 * note and sorts to the FRONT. The orphan-reply rule then drags the deleted
 * note in alongside it, because a tombstone's ["e", id] tag looks like a
 * reply. On a tight cover the image ends up preferentially carrying a note you
 * deleted plus the tombstone that deleted it -- and accepting it on the far
 * side can re-apply the deletion.
 */
export function isEmbedCandidate(e: NostrEvent, ctx: CandidateContext): boolean {
  return (
    (ctx.ourPubkeys.has(e.pubkey) || ctx.contacts.has(e.pubkey)) &&
    e.kind !== 5 &&
    !ctx.deletedNoteIds.has(e.id)
  );
}

/** Every event eligible for automatic packing. */
export function embedCandidates(
  events: readonly NostrEvent[],
  ctx: CandidateContext,
): NostrEvent[] {
  return events.filter((e) => isEmbedCandidate(e, ctx));
}

/**
 * Which profiles a bundle must carry so the recipient can tell whose words
 * these are.
 *
 * THE GAP THIS CLOSES. The embed path could only ever *synthesise* a kind-0,
 * which requires a private key, so it covered the user's own identities and
 * nobody else. That was sufficient while the note picker offered only your own
 * notes. Once a followed author's note can be picked -- and an explicit
 * selection is filtered down to exactly the chosen ids -- their profile is no
 * longer in the bundle, and the recipient sees a bare pubkey instead of a name.
 *
 * A profile we already hold is their own signed event, so it can be carried
 * unmodified and verifies on the far side exactly as it does here. Nothing is
 * re-signed: attributing words or a name to someone under a different key is
 * precisely what this app must never do.
 */
export function profilesToCarry(
  eventList: readonly NostrEvent[],
  allEvents: readonly NostrEvent[],
  canSignFor: ReadonlySet<string>,
): { synthesise: string[]; borrow: NostrEvent[] } {
  const mentioned = new Set(
    eventList.flatMap((e) => [e.pubkey, ...e.tags.filter((t) => t[0] === "p").map((t) => t[1])]),
  );
  const alreadyIncluded = new Set(
    eventList.filter((e) => e.kind === 0).map((e) => e.pubkey),
  );

  const synthesise: string[] = [];
  const borrow: NostrEvent[] = [];
  for (const pk of mentioned) {
    if (!pk || alreadyIncluded.has(pk)) continue;
    if (canSignFor.has(pk)) {
      synthesise.push(pk);
      continue;
    }
    // Newest wins: profiles are replaceable events.
    const real = allEvents
      .filter((e) => e.kind === 0 && e.pubkey === pk)
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (real) borrow.push(real);
  }
  return { synthesise, borrow };
}

/** How many notes the picker will show. Enough to choose from, bounded. */
export const MAX_SELECTABLE_NOTES = 50;

export interface SelectableNote {
  id: string;
  content: string;
  created_at: number;
  /** False for a followed author's note, so the UI can say whose it is. */
  mine: boolean;
}

/**
 * The notes offered in "Pick specific notes", newest first.
 *
 * Deliberately the same eligibility rule as {@link embedCandidates}, narrowed
 * only to kind 1 -- you pick notes, not profile or contact-list events, which
 * buildBundle adds on its own so the recipient can identify the sender.
 */
export function selectableNotes(
  events: readonly NostrEvent[],
  ctx: CandidateContext,
  limit: number = MAX_SELECTABLE_NOTES,
): SelectableNote[] {
  return events
    .filter((e) => e.kind === 1 && isEmbedCandidate(e, ctx))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      content: e.content,
      created_at: e.created_at,
      mine: ctx.ourPubkeys.has(e.pubkey),
    }));
}
