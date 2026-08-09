import { describe, it, expect } from "vitest";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import {
  SyncEngine, verifyEvent, computeEventId, packForCapacity,
  replaceableWinner, isReplaceable, replaceableKey,
} from "../sync-engine";
import type { NostrEvent } from "../net-pool";

const h = (secp as unknown as { hashes: Record<string, unknown> }).hashes;
if (!h.sha256) h.sha256 = (m: Uint8Array) => sha256(m);
if (!h.hmacSha256) h.hmacSha256 = (k: Uint8Array, m: Uint8Array) => hmac(sha256, k, m);

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => {
  const o = new Uint8Array(s.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return o;
};

function makeKey(seed: number): { sk: Uint8Array; pk: string } {
  const sk = new Uint8Array(32).fill(seed || 1);
  return { sk, pk: hex(secp.schnorr.getPublicKey(sk)) };
}

function sign(sk: Uint8Array, pk: string, over: Partial<NostrEvent> = {}): NostrEvent {
  const base = {
    pubkey: pk,
    created_at: over.created_at ?? 1_700_000_000,
    kind: over.kind ?? 1,
    tags: over.tags ?? [],
    content: over.content ?? "hello",
  };
  const ev = { ...base, id: "", sig: "" } as NostrEvent;
  ev.id = computeEventId(ev);
  ev.sig = hex(secp.schnorr.sign(unhex(ev.id), sk));
  return ev;
}

const alice = makeKey(1);
const mallory = makeKey(9);
const NOW = () => 1_700_100_000_000;

describe("event verification", () => {
  it("accepts a properly signed event", () => {
    expect(verifyEvent(sign(alice.sk, alice.pk))).toBe(true);
  });

  it("rejects tampered content even though the signature is otherwise valid", () => {
    const ev = sign(alice.sk, alice.pk);
    const forged = { ...ev, content: "malicious rewrite" };
    // id no longer matches content
    expect(verifyEvent(forged)).toBe(false);
  });

  it("rejects an event whose id was swapped to keep a valid signature", () => {
    const ev = sign(alice.sk, alice.pk);
    const other = sign(alice.sk, alice.pk, { content: "different" });
    expect(verifyEvent({ ...ev, id: other.id })).toBe(false);
  });

  it("rejects an event claiming someone else's pubkey", () => {
    const ev = sign(mallory.sk, mallory.pk);
    const impersonation = { ...ev, pubkey: alice.pk };
    expect(verifyEvent(impersonation)).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyEvent({} as NostrEvent)).toBe(false);
    expect(verifyEvent({ ...sign(alice.sk, alice.pk), sig: "zz" })).toBe(false);
  });
});

describe("SyncEngine ingest", () => {
  it("merges events from followed authors", () => {
    const e = new SyncEngine({ follows: new Set([alice.pk]), now: NOW });
    const r = e.ingest([sign(alice.sk, alice.pk)]);
    expect(r.verdicts.merged).toBe(1);
    expect(e.size).toBe(1);
  });

  it("quarantines strangers instead of injecting them into the feed", () => {
    const e = new SyncEngine({ follows: new Set([alice.pk]), now: NOW });
    const r = e.ingest([sign(mallory.sk, mallory.pk)]);
    // Anyone can send you a JPEG; that must not be enough to write to your feed.
    expect(r.verdicts.quarantined).toBe(1);
    expect(e.size).toBe(0);
    expect(e.quarantined().length).toBe(1);
    expect(r.strangers).toEqual([mallory.pk]);
  });

  it("promotes a quarantined event on user decision", () => {
    const e = new SyncEngine({ follows: new Set(), now: NOW });
    const ev = sign(mallory.sk, mallory.pk);
    e.ingest([ev]);
    expect(e.promote(ev.id)).toBe(true);
    expect(e.size).toBe(1);
    expect(e.quarantined().length).toBe(0);
  });

  it("drops forged events before any trust decision", () => {
    const e = new SyncEngine({ follows: new Set([alice.pk]), now: NOW });
    const forged = { ...sign(alice.sk, alice.pk), content: "not what alice said" };
    const r = e.ingest([forged]);
    expect(r.verdicts["invalid-signature"]).toBe(1);
    expect(e.size).toBe(0);
  });

  it("dedupes across transports", () => {
    const e = new SyncEngine({ follows: new Set([alice.pk]), now: NOW });
    const ev = sign(alice.sk, alice.pk);
    e.ingest([ev], "relay");
    const r = e.ingest([ev], "image");
    expect(r.verdicts.duplicate).toBe(1);
    expect(e.size).toBe(1);
  });

  it("caps how many events one image can contribute", () => {
    const e = new SyncEngine({ follows: new Set([alice.pk]), maxEventsPerPayload: 3, now: NOW });
    const many = Array.from({ length: 10 }, (_, i) =>
      sign(alice.sk, alice.pk, { content: `n${i}` }));
    const r = e.ingest(many);
    expect(e.size).toBe(3);
    expect(r.verdicts["rejected-limit"]).toBe(7);
  });

  it("rejects far-future timestamps that would pin a replaceable event", () => {
    const e = new SyncEngine({ follows: new Set([alice.pk]), now: NOW });
    const future = sign(alice.sk, alice.pk, { kind: 0, created_at: 2_000_000_000 });
    const r = e.ingest([future]);
    expect(r.verdicts["rejected-future"]).toBe(1);
  });

  it("trusts relay-sourced events without quarantine", () => {
    const e = new SyncEngine({ follows: new Set(), now: NOW });
    const r = e.ingest([sign(mallory.sk, mallory.pk)], "relay");
    expect(r.verdicts.merged).toBe(1);
  });
});

describe("merge policy (user choice at detect time)", () => {
  const strangerEvents = () => [
    sign(mallory.sk, mallory.pk, { content: "one" }),
    sign(mallory.sk, mallory.pk, { content: "two" }),
  ];

  it("merge-all accepts everything when the user vouches for the image", () => {
    const e = new SyncEngine({ follows: new Set(), now: NOW });
    const r = e.ingest(strangerEvents(), "image", "merge-all");
    expect(r.verdicts.merged).toBe(2);
    expect(e.quarantined().length).toBe(0);
  });

  it("follows-only is the default and holds strangers back", () => {
    const e = new SyncEngine({ follows: new Set([alice.pk]), now: NOW });
    const r = e.ingest([...strangerEvents(), sign(alice.sk, alice.pk)], "image");
    expect(r.verdicts.merged).toBe(1);
    expect(r.verdicts.quarantined).toBe(2);
  });

  it("review-all holds everything, even people you follow", () => {
    const e = new SyncEngine({ follows: new Set([alice.pk]), now: NOW });
    const r = e.ingest([sign(alice.sk, alice.pk)], "image", "review-all");
    expect(r.verdicts.quarantined).toBe(1);
    expect(e.size).toBe(0);
  });

  it("relay events are unaffected by image policy", () => {
    const e = new SyncEngine({ follows: new Set(), now: NOW });
    const r = e.ingest(strangerEvents(), "relay", "review-all");
    expect(r.verdicts.merged).toBe(2);
  });
});

describe("reviewing held content", () => {
  const held = () => {
    const e = new SyncEngine({ follows: new Set(), now: NOW });
    e.ingest([
      sign(mallory.sk, mallory.pk, { content: "m1" }),
      sign(mallory.sk, mallory.pk, { content: "m2" }),
      sign(alice.sk, alice.pk, { content: "a1" }),
    ], "image", "review-all");
    return e;
  };

  it("accepts everything in one action", () => {
    const e = held();
    expect(e.promoteAll()).toBe(3);
    expect(e.size).toBe(3);
    expect(e.quarantined().length).toBe(0);
  });

  it("accepts everything by one author -- 'trust this person'", () => {
    const e = held();
    expect(e.promoteAuthor(mallory.pk)).toBe(2);
    expect(e.size).toBe(2);
    expect(e.quarantined().length).toBe(1);
  });

  it("discards everything in one action", () => {
    const e = held();
    expect(e.rejectAll()).toBe(3);
    expect(e.size).toBe(0);
    expect(e.quarantined().length).toBe(0);
  });

  it("a rejected item does not reappear when the image is opened again", () => {
    const e = new SyncEngine({ follows: new Set(), now: NOW });
    const ev = sign(mallory.sk, mallory.pk);
    e.ingest([ev], "image", "review-all");
    e.reject(ev.id);
    const again = e.ingest([ev], "image", "review-all");
    expect(again.verdicts.duplicate).toBe(1);
    expect(e.quarantined().length).toBe(0);
  });

  it("groups held events by author for review", () => {
    const groups = held().pendingByAuthor();
    expect(groups.length).toBe(2);
    expect(groups.find((g) => g.pubkey === mallory.pk)!.events.length).toBe(2);
  });
});

describe("replaceable event conflicts", () => {
  it("classifies kinds correctly", () => {
    expect(isReplaceable(0)).toBe(true);
    expect(isReplaceable(3)).toBe(true);
    expect(isReplaceable(10002)).toBe(true);
    expect(isReplaceable(1)).toBe(false);
    expect(replaceableKey({ pubkey: "p", kind: 30023, tags: [["d", "slug"]] } as NostrEvent))
      .toBe("p:30023:slug");
  });

  it("keeps the newer profile when two offline edits meet", () => {
    const e = new SyncEngine({ follows: new Set([alice.pk]), now: NOW });
    const older = sign(alice.sk, alice.pk, { kind: 0, content: '{"name":"old"}', created_at: 1000 });
    const newer = sign(alice.sk, alice.pk, { kind: 0, content: '{"name":"new"}', created_at: 2000 });
    e.ingest([older]);
    const r = e.ingest([newer]);
    expect(r.verdicts.replaced).toBe(1);
    expect(e.size).toBe(1);
    expect(e.events()[0].content).toContain("new");
  });

  it("ignores an older profile arriving after a newer one", () => {
    const e = new SyncEngine({ follows: new Set([alice.pk]), now: NOW });
    const older = sign(alice.sk, alice.pk, { kind: 0, content: '{"name":"old"}', created_at: 1000 });
    const newer = sign(alice.sk, alice.pk, { kind: 0, content: '{"name":"new"}', created_at: 2000 });
    e.ingest([newer]);
    const r = e.ingest([older]);
    expect(r.verdicts.superseded).toBe(1);
    expect(e.events()[0].content).toContain("new");
  });

  it("breaks created_at ties deterministically so peers converge", () => {
    const a = sign(alice.sk, alice.pk, { kind: 0, content: "A", created_at: 5000 });
    const b = sign(alice.sk, alice.pk, { kind: 0, content: "B", created_at: 5000 });
    // Order of arrival must not change the outcome.
    expect(replaceableWinner(a, b).id).toBe(replaceableWinner(b, a).id);
  });

  it("converges regardless of arrival order", () => {
    const mk = () => new SyncEngine({ follows: new Set([alice.pk]), now: NOW });
    const v1 = sign(alice.sk, alice.pk, { kind: 0, content: "v1", created_at: 100 });
    const v2 = sign(alice.sk, alice.pk, { kind: 0, content: "v2", created_at: 200 });
    const e1 = mk(); e1.ingest([v1]); e1.ingest([v2]);
    const e2 = mk(); e2.ingest([v2]); e2.ingest([v1]);
    expect(e1.events()[0].id).toBe(e2.events()[0].id);
  });
});

describe("capacity packing", () => {
  const feed = Array.from({ length: 200 }, (_, i) =>
    sign(alice.sk, alice.pk, { content: `note number ${i} `.repeat(3), created_at: 1_699_000_000 + i * 3600 }));

  it("fits inside a small carrier budget", () => {
    const r = packForCapacity(feed, { budget: 4096, self: alice.pk });
    expect(r.estimatedBytes).toBeLessThanOrEqual(4096);
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.skipped).toBeGreaterThan(0);
  });

  it("carries more when the budget is larger", () => {
    const small = packForCapacity(feed, { budget: 4096, self: alice.pk });
    const large = packForCapacity(feed, { budget: 32768, self: alice.pk });
    expect(large.events.length).toBeGreaterThan(small.events.length);
  });

  it("prioritises replaceable events like profiles and relay lists", () => {
    const profile = sign(alice.sk, alice.pk, { kind: 0, content: '{"name":"a"}', created_at: 1_699_000_000 });
    const relays = sign(alice.sk, alice.pk, { kind: 10002, tags: [["r", "wss://x"]], created_at: 1_699_000_000 });
    const r = packForCapacity([...feed, profile, relays], { budget: 2048, self: alice.pk });
    const kinds = new Set(r.events.map((e) => e.kind));
    expect(kinds.has(0)).toBe(true);
    expect(kinds.has(10002)).toBe(true);
  });

  it("drops replies whose parent did not fit", () => {
    const parent = sign(alice.sk, alice.pk, { content: "x".repeat(3000) });
    const reply = sign(alice.sk, alice.pk, { content: "re", tags: [["e", parent.id]] });
    const r = packForCapacity([parent, reply], { budget: 200, self: alice.pk });
    // A reply with no visible parent is noise in the recipient's feed.
    expect(r.events.find((e) => e.id === reply.id)).toBeUndefined();
  });

  it("keeps a reply when its parent is included", () => {
    const parent = sign(alice.sk, alice.pk, { content: "parent" });
    const reply = sign(alice.sk, alice.pk, { content: "child", tags: [["e", parent.id]] });
    const r = packForCapacity([parent, reply], { budget: 8192, self: alice.pk });
    expect(r.events.length).toBe(2);
    expect(r.droppedOrphans).toBe(0);
  });

  it("round-trips: packed events all verify and ingest cleanly", () => {
    const r = packForCapacity(feed, { budget: 8192, self: alice.pk });
    expect(r.events.every(verifyEvent)).toBe(true);
    const e = new SyncEngine({ follows: new Set([alice.pk]), now: NOW });
    const rep = e.ingest(r.events, "image");
    expect(rep.verdicts.merged).toBe(r.events.length);
  });
});
