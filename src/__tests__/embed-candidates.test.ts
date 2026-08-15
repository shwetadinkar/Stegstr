import { describe, it, expect } from "vitest";
import {
  isEmbedCandidate,
  embedCandidates,
  selectableNotes,
  profilesToCarry,
  type CandidateContext,
} from "../embed-candidates";
import type { NostrEvent } from "../types";

/**
 * "Pick specific notes is also not working."
 *
 * It was reported as not working because the picker and the automatic packer
 * used different rules for whose notes could be carried. These tests pin them
 * to the same rule, and the first two are the user-visible bug.
 */

const ME = "a".repeat(64);
const FRIEND = "b".repeat(64);
const STRANGER = "c".repeat(64);

const ev = (over: Partial<NostrEvent> = {}): NostrEvent => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  pubkey: over.pubkey ?? ME,
  created_at: over.created_at ?? 1700000000,
  kind: over.kind ?? 1,
  tags: over.tags ?? [],
  content: over.content ?? "hello",
  sig: "0".repeat(128),
});

const ctx = (over: Partial<CandidateContext> = {}): CandidateContext => ({
  ourPubkeys: over.ourPubkeys ?? new Set([ME]),
  contacts: over.contacts ?? new Set([FRIEND]),
  deletedNoteIds: over.deletedNoteIds ?? new Set(),
});

describe("the reported bug: the picker offered less than the packer carried", () => {
  it("offers a followed author's note, which automatic mode would carry anyway", () => {
    const notes = [ev({ pubkey: FRIEND, content: "from someone I follow" })];
    // Automatic mode has always been willing to carry this.
    expect(embedCandidates(notes, ctx())).toHaveLength(1);
    // So the picker must offer it too. It used to offer nothing.
    const pick = selectableNotes(notes, ctx());
    expect(pick).toHaveLength(1);
    expect(pick[0].content).toBe("from someone I follow");
  });

  it("is not empty for a user who has not posted yet", () => {
    // This is what made it look broken: the radio was disabled with "you have
    // not written any notes yet" while the feed was full of carryable notes.
    const feed = [
      ev({ pubkey: FRIEND, content: "friend one" }),
      ev({ pubkey: FRIEND, content: "friend two" }),
    ];
    expect(selectableNotes(feed, ctx({ ourPubkeys: new Set([ME]) }))).toHaveLength(2);
  });

  it("marks whose note each one is, so the UI need not guess", () => {
    const pick = selectableNotes(
      [ev({ pubkey: ME, content: "mine", created_at: 2 }),
       ev({ pubkey: FRIEND, content: "theirs", created_at: 1 })],
      ctx(),
    );
    expect(pick.map((n) => [n.content, n.mine])).toEqual([["mine", true], ["theirs", false]]);
  });
});

describe("eligibility, held identical for both paths", () => {
  it("excludes a stranger's note from both", () => {
    // Without this, "embed my feed" became "embed a slice of Global": small
    // stranger events score highly on density and crowd out real note text.
    const notes = [ev({ pubkey: STRANGER, content: "spam" })];
    expect(embedCandidates(notes, ctx())).toHaveLength(0);
    expect(selectableNotes(notes, ctx())).toHaveLength(0);
  });

  it("excludes deletions and deleted notes from both", () => {
    const gone = ev({ id: "gone", content: "deleted note" });
    const tomb = ev({ kind: 5, tags: [["e", "gone"]], content: "" });
    const c = ctx({ deletedNoteIds: new Set(["gone"]) });
    expect(embedCandidates([gone, tomb], c)).toHaveLength(0);
    expect(selectableNotes([gone, tomb], c)).toHaveLength(0);
  });

  it("agrees with itself across every author and state", () => {
    // The property that matters: anything the picker offers, the packer would
    // also have carried. A divergence here is the original bug returning.
    const c = ctx({ deletedNoteIds: new Set(["d"]) });
    const all = [
      ev({ pubkey: ME }), ev({ pubkey: FRIEND }), ev({ pubkey: STRANGER }),
      ev({ id: "d", pubkey: ME }), ev({ kind: 5, pubkey: ME }),
      ev({ kind: 0, pubkey: FRIEND }),
    ];
    const carried = new Set(embedCandidates(all, c).map((e) => e.id));
    for (const n of selectableNotes(all, c)) expect(carried.has(n.id)).toBe(true);
  });
});

describe("the picker's own rules", () => {
  it("shows only notes, not profile or contact-list events", () => {
    const all = [
      ev({ kind: 1, content: "a note" }),
      ev({ kind: 0, content: '{"name":"me"}' }),
      ev({ kind: 3, content: "" }),
    ];
    // Profiles are still carried -- buildBundle adds them so the recipient can
    // identify the sender. They are just not things you pick.
    expect(embedCandidates(all, ctx())).toHaveLength(3);
    expect(selectableNotes(all, ctx()).map((n) => n.content)).toEqual(["a note"]);
  });

  it("shows newest first and caps the list", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      ev({ content: `note ${i}`, created_at: 1700000000 + i }));
    const pick = selectableNotes(many, ctx());
    expect(pick).toHaveLength(50);
    expect(pick[0].content).toBe("note 59");
  });

  it("honours an explicit limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => ev({ created_at: i }));
    expect(selectableNotes(many, ctx(), 3)).toHaveLength(3);
  });
});

describe("profiles carried alongside the notes", () => {
  /**
   * The gap that opened the moment a followed author's note became pickable:
   * the embed path could only synthesise a kind-0 for keys it holds, so
   * picking someone else's note produced a bundle with no profile for its
   * author and the recipient saw a bare pubkey.
   */
  const profile = (pk: string, name: string, at = 1000) =>
    ev({ kind: 0, pubkey: pk, content: JSON.stringify({ name }), created_at: at });

  it("carries a followed author's own profile, since we cannot sign one for them", () => {
    const theirNote = ev({ pubkey: FRIEND, content: "their words" });
    const theirProfile = profile(FRIEND, "Friend");
    const { synthesise, borrow } = profilesToCarry([theirNote], [theirNote, theirProfile], new Set([ME]));
    expect(synthesise).toEqual([]);
    expect(borrow).toEqual([theirProfile]);
  });

  it("carries it unmodified -- nothing is re-signed under another key", () => {
    // Re-signing would attribute a name to someone under a key that is not
    // theirs. The event must come through byte-identical.
    const theirProfile = profile(FRIEND, "Friend");
    const { borrow } = profilesToCarry(
      [ev({ pubkey: FRIEND })], [theirProfile], new Set([ME]),
    );
    expect(borrow[0]).toBe(theirProfile);
  });

  it("asks for a synthetic profile for our own identity", () => {
    const mine = ev({ pubkey: ME, content: "my words" });
    const { synthesise, borrow } = profilesToCarry([mine], [mine], new Set([ME]));
    expect(synthesise).toEqual([ME]);
    expect(borrow).toEqual([]);
  });

  it("does not duplicate a profile already in the selection", () => {
    const theirProfile = profile(FRIEND, "Friend");
    const list = [ev({ pubkey: FRIEND }), theirProfile];
    const { synthesise, borrow } = profilesToCarry(list, list, new Set([ME]));
    expect(synthesise).toEqual([]);
    expect(borrow).toEqual([]);
  });

  it("prefers the newest profile, since kind 0 is replaceable", () => {
    const old = profile(FRIEND, "Old Name", 1000);
    const recent = profile(FRIEND, "New Name", 2000);
    const { borrow } = profilesToCarry(
      [ev({ pubkey: FRIEND })], [old, recent], new Set([ME]),
    );
    expect(borrow).toEqual([recent]);
  });

  it("covers people mentioned in a p tag, not only authors", () => {
    const mention = ev({ pubkey: ME, tags: [["p", FRIEND]], content: "hi @friend" });
    const theirProfile = profile(FRIEND, "Friend");
    const { borrow } = profilesToCarry([mention], [mention, theirProfile], new Set([ME]));
    expect(borrow).toEqual([theirProfile]);
  });

  it("simply omits a profile it does not have, rather than inventing one", () => {
    const theirNote = ev({ pubkey: FRIEND, content: "no profile known" });
    const { synthesise, borrow } = profilesToCarry([theirNote], [theirNote], new Set([ME]));
    expect(synthesise).toEqual([]);
    expect(borrow).toEqual([]);
  });
});

describe("isEmbedCandidate", () => {
  it("accepts your own and a followed author's, rejects a stranger's", () => {
    expect(isEmbedCandidate(ev({ pubkey: ME }), ctx())).toBe(true);
    expect(isEmbedCandidate(ev({ pubkey: FRIEND }), ctx())).toBe(true);
    expect(isEmbedCandidate(ev({ pubkey: STRANGER }), ctx())).toBe(false);
  });
});
