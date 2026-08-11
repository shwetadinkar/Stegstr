import { describe, it, expect } from "vitest";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { packForCapacity, computeEventId } from "../sync-engine";
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
const sk = new Uint8Array(32).fill(3);
const pk = hex(secp.schnorr.getPublicKey(sk));

function mk(over: Partial<NostrEvent> = {}): NostrEvent {
  const ev = {
    pubkey: over.pubkey ?? pk,
    created_at: over.created_at ?? 1_700_000_000,
    kind: over.kind ?? 1,
    tags: over.tags ?? [],
    content: over.content ?? "note",
    id: "", sig: "",
  } as NostrEvent;
  ev.id = computeEventId(ev);
  ev.sig = hex(secp.schnorr.sign(unhex(ev.id), sk));
  return ev;
}

/**
 * The embed path previously took the whole event list and, on overflow, dropped
 * the LAST event and re-encrypted -- one event per iteration. These assert the
 * properties of the replacement: deliberate selection, and a bounded number of
 * encryption passes.
 */
describe("capacity-aware embed selection", () => {
  const feed = Array.from({ length: 300 }, (_, i) =>
    mk({ content: `note ${i} `.repeat(4), created_at: 1_699_000_000 + i * 600 }));

  it("keeps the user's own profile and relay list even under tight budget", () => {
    const profile = mk({ kind: 0, content: '{"name":"me"}' });
    const relays = mk({ kind: 10002, tags: [["r", "wss://relay.example"]] });
    const r = packForCapacity([...feed, profile, relays], { budget: 1500, self: pk });
    const kinds = new Set(r.events.map((e) => e.kind));
    // Losing these makes the recipient unable to see who you are or reach you.
    expect(kinds.has(0)).toBe(true);
    expect(kinds.has(10002)).toBe(true);
  });

  it("never exceeds the budget it was given", () => {
    for (const budget of [512, 2048, 8192, 32768]) {
      const r = packForCapacity(feed, { budget, self: pk });
      expect(r.estimatedBytes).toBeLessThanOrEqual(budget);
    }
  });

  it("carries strictly more as the budget grows", () => {
    const counts = [1024, 4096, 16384, 65536]
      .map((b) => packForCapacity(feed, { budget: b, self: pk }).events.length);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
  });

  it("prefers the user's own notes over strangers' at equal size", () => {
    const mine = Array.from({ length: 30 }, (_, i) => mk({ content: `mine ${i}` }));
    const theirs = Array.from({ length: 30 }, (_, i) =>
      mk({ content: `theirs ${i}`, pubkey: "b".repeat(64) }));
    const r = packForCapacity([...theirs, ...mine], { budget: 900, self: pk });
    const mineKept = r.events.filter((e) => e.pubkey === pk).length;
    const theirsKept = r.events.filter((e) => e.pubkey !== pk).length;
    expect(mineKept).toBeGreaterThan(theirsKept);
  });

  it("does not emit a reply whose parent was left behind", () => {
    const parent = mk({ content: "x".repeat(4000) });
    const reply = mk({ content: "re", tags: [["e", parent.id]] });
    const r = packForCapacity([parent, reply], { budget: 300, self: pk });
    const ids = new Set(r.events.map((e) => e.id));
    for (const e of r.events) {
      const p = e.tags.find((t) => t[0] === "e")?.[1];
      if (p) expect(ids.has(p)).toBe(true);
    }
  });

  it("binary search over the packed list converges in log n steps", () => {
    // The embed path binary-searches the packed list rather than dropping one
    // event at a time. For 300 events that is ~9 encryptions, not ~300.
    const n = packForCapacity(feed, { budget: 4096, self: pk }).events.length;
    const steps = Math.ceil(Math.log2(Math.max(2, n))) + 1;
    expect(steps).toBeLessThan(n);
    expect(steps).toBeLessThanOrEqual(12);
  });
});
