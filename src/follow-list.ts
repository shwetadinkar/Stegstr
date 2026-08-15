/**
 * follow-list.ts — who an identity follows, as the app actually behaves.
 *
 * A new local identity follows a few default accounts so the feed is not empty
 * when the network is first turned on. Those follows are a **phantom**: they
 * are shown in Following, and the feed reads from them, but no kind-3 event
 * ever holds them.
 *
 * Both follow handlers treated kind 3 as the source of truth, which turned one
 * omission into two bugs:
 *
 *   Unfollow  `if (!kind3) return` -- silently did nothing at all. No error,
 *             no status line. The button simply had no effect, which is how
 *             the user found it.
 *   Follow    started from an empty tag list, so following one account wrote a
 *             kind 3 holding only them. A kind 3 then existed, so the defaults
 *             stopped being seeded, and the other follows vanished.
 *
 * The second was never reported, because silently losing follows is invisible
 * in a way that a dead button is not.
 *
 * Reading the *effective* list rather than only the stored one makes the first
 * edit materialise the defaults into a real kind 3 -- which is what the UI has
 * been claiming all along.
 */

import * as Nostr from "./nostr-stub";
import type { NostrEvent } from "./types";

/** Default follows for new local identities so the feed shows posts when network is on. */
export const DEFAULT_FOLLOW_NPUBS = [
  "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m", // jack
  "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6", // fiatjaf
  "npub1rs787tkd6mle8jxvqr07zngzf8h6qu5fc8g3jfdtj8xux9a6aumqkdgtgf",
  "npub1c3lf9hdmghe4l7xcy8phlhepr66hz7wp5dnkpwxjvw8x7hzh0pesc9mpv4",
  "npub1gcxzte5zlknqx26dzuyuzhhnz5q4fvnvcyn0x0cpqvjq0s8qfjds0x2df2",
];

export function getDefaultFollowPubkeys(): string[] {
  const out: string[] = [];
  for (const npub of DEFAULT_FOLLOW_NPUBS) {
    try {
      const d = Nostr.nip19.decode(npub);
      if (d.type === "npub" && d.data.length === 32) out.push(Nostr.bytesToHex(d.data));
    } catch (_) {}
  }
  return out;
}

/**
 * Whether the defaults are standing in for a contact list this identity does
 * not have yet.
 *
 * Used both to display them and to materialise them on the first edit, so the
 * two cannot drift apart -- which is exactly how "Pick specific notes" broke
 * (HANDOFF §21.1).
 *
 * Only local identities. Someone who brought their own key has a contact list
 * elsewhere; inventing follows for them would be editing their social graph.
 */
export function usingDefaultFollows(
  events: readonly NostrEvent[],
  pubkey: string | null,
  category: string | undefined,
): boolean {
  return (
    category === "local" &&
    !!pubkey &&
    !events.some((e) => e.kind === 3 && e.pubkey === pubkey)
  );
}

/** Who this identity follows right now: the stored list, or the defaults standing in. */
export function currentContactPubkeys(
  events: readonly NostrEvent[],
  pubkey: string,
  seedDefaults: boolean,
): string[] {
  const kind3 = events.find((e) => e.kind === 3 && e.pubkey === pubkey);
  if (kind3) return kind3.tags.filter((t) => t[0] === "p").map((t) => t[1]);
  return seedDefaults ? getDefaultFollowPubkeys() : [];
}

/**
 * The tags for a contact list with `follows` as its follow set.
 *
 * Non-"p" tags from the existing event are preserved: contact lists can carry
 * relay hints, and rebuilding from the follow set alone would discard them
 * silently on every follow and unfollow.
 */
export function contactListTags(
  existing: NostrEvent | undefined,
  follows: readonly string[],
): string[][] {
  const others = existing ? existing.tags.filter((t) => t[0] !== "p") : [];
  return [...others, ...follows.map((pk) => ["p", pk])];
}
