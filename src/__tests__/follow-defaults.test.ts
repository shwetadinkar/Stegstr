import { describe, it, expect } from "vitest";
import type { NostrEvent } from "../types";
import {
  currentContactPubkeys,
  usingDefaultFollows,
  getDefaultFollowPubkeys,
  contactListTags,
} from "../follow-list";

/**
 * "You cannot unfollow people."
 *
 * A new local identity follows five default accounts so the feed is not empty
 * when the network is on. Those follows are a **phantom**: they are shown in
 * Following, and the feed reads from them, but no kind-3 event ever holds
 * them. Both follow handlers treated kind 3 as the source of truth, which made
 * two bugs out of one omission:
 *
 *   Unfollow  `if (!kind3) return` -- silently did nothing, no error, no
 *             status. This is what the user reported.
 *   Follow    started from an empty tag list, so following one account wrote a
 *             kind 3 containing only them; a kind 3 then existed, so the
 *             defaults stopped being seeded, and five follows vanished.
 *
 * The second was never reported, because losing follows is invisible in a way
 * that a dead button is not.
 */

const ME = "a".repeat(64);
const THEM = "b".repeat(64);

const kind3 = (pubkey: string, follows: string[], extra: string[][] = []): NostrEvent => ({
  id: "k3",
  pubkey,
  created_at: 1700000000,
  kind: 3,
  tags: [...extra, ...follows.map((f) => ["p", f])],
  content: "",
  sig: "0".repeat(128),
});

describe("the phantom default follows", () => {
  it("reports defaults as followed when no contact list exists", () => {
    expect(usingDefaultFollows([], ME, "local")).toBe(true);
    const list = currentContactPubkeys([], ME, true);
    expect(list).toEqual(getDefaultFollowPubkeys());
    expect(list.length).toBeGreaterThan(0);
  });

  it("stops standing in once a real contact list exists", () => {
    const events = [kind3(ME, [THEM])];
    expect(usingDefaultFollows(events, ME, "local")).toBe(false);
    expect(currentContactPubkeys(events, ME, false)).toEqual([THEM]);
  });

  it("does not seed defaults for a nostr identity", () => {
    // Someone bringing their own key has a real contact list elsewhere;
    // inventing follows for them would be editing their social graph.
    expect(usingDefaultFollows([], ME, "nostr")).toBe(false);
    expect(currentContactPubkeys([], ME, false)).toEqual([]);
  });
});

describe("unfollowing a default -- the reported bug", () => {
  it("has something to remove, which is what the handler used to lack", () => {
    // The handler returned early because no kind 3 existed. The effective list
    // is what it should have been reading.
    const defaults = getDefaultFollowPubkeys();
    const effective = currentContactPubkeys([], ME, true);
    expect(effective).toContain(defaults[0]);

    const remaining = effective.filter((pk) => pk !== defaults[0]);
    expect(remaining).toHaveLength(defaults.length - 1);
    expect(remaining).not.toContain(defaults[0]);
  });

  it("keeps every other default when one is removed", () => {
    const defaults = getDefaultFollowPubkeys();
    const remaining = currentContactPubkeys([], ME, true).filter((pk) => pk !== defaults[2]);
    for (const pk of defaults) {
      if (pk === defaults[2]) continue;
      expect(remaining).toContain(pk);
    }
  });
});

describe("following while on defaults -- the bug nobody reported", () => {
  it("keeps the defaults instead of replacing them", () => {
    const defaults = getDefaultFollowPubkeys();
    const existing = currentContactPubkeys([], ME, true);
    const after = [...existing, THEM];

    // The old behaviour produced exactly [THEM] and dropped the rest.
    expect(after).toHaveLength(defaults.length + 1);
    expect(after).toContain(THEM);
    for (const pk of defaults) expect(after).toContain(pk);
  });
});

describe("a real contact list is edited, not rebuilt", () => {
  it("preserves tags that are not follows", () => {
    // Contact lists can carry relay hints and other tags. Rebuilding the event
    // from the follow list alone would silently discard them.
    const events = [kind3(ME, [THEM, "c".repeat(64)], [["relay", "wss://example"]])];
    const existing = currentContactPubkeys(events, ME, false);
    const rebuilt = contactListTags(events[0], existing.filter((pk) => pk !== THEM));

    expect(rebuilt).toContainEqual(["relay", "wss://example"]);
    expect(rebuilt.filter((t) => t[0] === "p")).toEqual([["p", "c".repeat(64)]]);
  });
});
