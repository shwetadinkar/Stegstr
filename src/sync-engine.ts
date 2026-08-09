/**
 * sync-engine.ts — merging steganographically-delivered content.
 *
 * Stegstr's real transport is not the relay. With Network off the app still
 * works: you embed your feed into a JPEG, hand it to WhatsApp, and the
 * recipient detects and merges it. The image IS the packet and WhatsApp is the
 * carrier. That makes this a gossip protocol over sneakernet, and the sync
 * rules below are the part that makes it reliable rather than merely possible.
 *
 * Four problems this solves, none of which the relay path has to deal with:
 *
 *   TRUST      A received image is untrusted input arriving from a channel
 *              anyone can send on. Every event is signature-verified before it
 *              is considered at all, and events from authors the user does not
 *              follow are quarantined rather than merged. Without that, anyone
 *              who sends you a picture can inject notes into your feed.
 *
 *   DEDUPE     The same event can arrive by relay and by image, or by four
 *              images from four friends. Dedupe is keyed on event id and
 *              shared with the relay Outbox, so a note surfaces once no matter
 *              how many paths it took.
 *
 *   CONFLICTS  Two people edit a profile while offline and swap images. NIP-01
 *              replaceable events (kind 0, 3, and 10000-19999) resolve by
 *              newest created_at, with the event id as a deterministic
 *              tie-break so every peer converges on the same winner rather
 *              than on whichever image they happened to open last.
 *
 *   CAPACITY   A feed is usually larger than an image can carry: 4KB on
 *              Instagram against a 40KB store. Selection is therefore a
 *              knapsack, not a truncation -- pick the events most worth
 *              carrying, respecting compression, and never emit a reply whose
 *              parent the recipient will not have.
 */

import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import type { NostrEvent } from "./net-pool";

const h = (secp as unknown as {
  hashes: {
    sha256?: (m: Uint8Array) => Uint8Array;
    hmacSha256?: (k: Uint8Array, m: Uint8Array) => Uint8Array;
  };
}).hashes;
if (!h.sha256) h.sha256 = (m: Uint8Array) => sha256(m);
if (!h.hmacSha256) h.hmacSha256 = (k: Uint8Array, m: Uint8Array) => hmac(sha256, k, m);

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error("odd hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** NIP-01 serialisation: sha256 of [0, pubkey, created_at, kind, tags, content]. */
export function computeEventId(ev: NostrEvent): string {
  const ser = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  return bytesToHex(sha256(new TextEncoder().encode(ser)));
}

/**
 * Full verification: the id must match the content AND the signature must
 * check out. Verifying only the signature would let an attacker keep a valid
 * signature while swapping the id; verifying only the id would let anyone
 * forge authorship outright.
 */
export function verifyEvent(ev: NostrEvent): boolean {
  try {
    if (!ev || typeof ev.id !== "string" || typeof ev.sig !== "string") return false;
    if (ev.id.length !== 64 || ev.sig.length !== 128 || ev.pubkey.length !== 64) return false;
    if (computeEventId(ev) !== ev.id) return false;
    return secp.schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey));
  } catch {
    return false;
  }
}

/** NIP-01: kind 0, kind 3 and 10000-19999 are replaceable; only the newest counts. */
export function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/** 30000-39999 are parameterised replaceable, keyed by pubkey+kind+d-tag. */
export function isParamReplaceable(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

export function replaceableKey(ev: NostrEvent): string | null {
  if (isReplaceable(ev.kind)) return `${ev.pubkey}:${ev.kind}`;
  if (isParamReplaceable(ev.kind)) {
    const d = ev.tags.find((t) => t[0] === "d")?.[1] ?? "";
    return `${ev.pubkey}:${ev.kind}:${d}`;
  }
  return null;
}

/**
 * Which of two versions of a replaceable event wins.
 * Newer created_at wins; ties break on lower id so all peers agree.
 */
export function replaceableWinner(a: NostrEvent, b: NostrEvent): NostrEvent {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at ? a : b;
  return a.id < b.id ? a : b;
}

export type Verdict = "merged" | "quarantined" | "duplicate" | "replaced" | "superseded"
  | "invalid-signature" | "rejected-limit" | "rejected-future";

export interface IngestReport {
  total: number;
  merged: NostrEvent[];
  quarantined: NostrEvent[];
  verdicts: Record<Verdict, number>;
  /** Authors seen in this payload that the user does not follow. */
  strangers: string[];
}

/**
 * What to do with a payload the user just opened.
 *
 * This is a per-detection decision, not a global setting: opening an image from
 * a close friend and opening one from a stranger in a group chat are different
 * situations, and the person opening it is the only one who knows which is
 * which. The default is deliberately the cautious one.
 */
export type MergePolicy =
  /** Everything merges straight into the feed. The user vouched for it. */
  | "merge-all"
  /** Followed authors merge; everyone else waits for review. Default. */
  | "follows-only"
  /** Nothing merges; the whole payload goes to review. */
  | "review-all";

export interface SyncOptions {
  /** Pubkeys whose events merge straight into the feed under follows-only. */
  follows: Set<string>;
  /** Cap events accepted from a single image. */
  maxEventsPerPayload?: number;
  /** Reject events dated further ahead than this many seconds. */
  maxFutureSkewSec?: number;
  /** Policy when a call does not specify one. */
  defaultPolicy?: MergePolicy;
  /** @deprecated use defaultPolicy: "merge-all". */
  trustUnknown?: boolean;
  now?: () => number;
}

/**
 * The merge engine.
 *
 * Holds the canonical event store plus a quarantine, and is the single place
 * events enter the app regardless of whether they arrived by relay or image.
 */
export class SyncEngine {
  private store = new Map<string, NostrEvent>();
  private replaceables = new Map<string, string>();  // replaceable key -> event id
  private quarantine = new Map<string, NostrEvent>();
  private seen = new Set<string>();

  constructor(private opts: SyncOptions) {}

  get size(): number { return this.store.size; }
  events(): NostrEvent[] { return [...this.store.values()]; }
  quarantined(): NostrEvent[] { return [...this.quarantine.values()]; }
  has(id: string): boolean { return this.seen.has(id); }

  /** Seed from local storage without re-verifying content the user already had. */
  hydrate(events: NostrEvent[]): void {
    for (const ev of events) {
      this.store.set(ev.id, ev);
      this.seen.add(ev.id);
      const rk = replaceableKey(ev);
      if (rk) this.replaceables.set(rk, ev.id);
    }
  }

  /** Promote a single held event once the user has decided to trust it. */
  promote(id: string): boolean {
    const ev = this.quarantine.get(id);
    if (!ev) return false;
    this.quarantine.delete(id);
    this.insert(ev);
    return true;
  }

  /** Accept everything currently held. Returns how many were merged. */
  promoteAll(filter?: (ev: NostrEvent) => boolean): number {
    let n = 0;
    for (const ev of [...this.quarantine.values()]) {
      if (filter && !filter(ev)) continue;
      this.quarantine.delete(ev.id);
      this.insert(ev);
      n += 1;
    }
    return n;
  }

  /** Accept everything by a given author -- "trust this person" in one action. */
  promoteAuthor(pubkey: string): number {
    return this.promoteAll((ev) => ev.pubkey === pubkey);
  }

  /**
   * Discard a held event. The id stays in the seen set, so a rejected item does
   * not reappear every time the same image is opened again.
   */
  reject(id: string): boolean {
    return this.quarantine.delete(id);
  }

  rejectAll(filter?: (ev: NostrEvent) => boolean): number {
    let n = 0;
    for (const ev of [...this.quarantine.values()]) {
      if (filter && !filter(ev)) continue;
      this.quarantine.delete(ev.id);
      n += 1;
    }
    return n;
  }

  /** Held events grouped by author, which is how a review UI wants them. */
  pendingByAuthor(): Array<{ pubkey: string; events: NostrEvent[] }> {
    const m = new Map<string, NostrEvent[]>();
    for (const ev of this.quarantine.values()) {
      const list = m.get(ev.pubkey) ?? [];
      list.push(ev);
      m.set(ev.pubkey, list);
    }
    return [...m.entries()].map(([pubkey, events]) => ({ pubkey, events }));
  }

  private insert(ev: NostrEvent): Verdict {
    const rk = replaceableKey(ev);
    if (rk) {
      const existingId = this.replaceables.get(rk);
      if (existingId) {
        const existing = this.store.get(existingId)!;
        const winner = replaceableWinner(ev, existing);
        if (winner.id === existingId) return "superseded";
        this.store.delete(existingId);
        this.store.set(ev.id, ev);
        this.replaceables.set(rk, ev.id);
        return "replaced";
      }
      this.replaceables.set(rk, ev.id);
    }
    this.store.set(ev.id, ev);
    return "merged";
  }

  /**
   * Ingest a payload decoded from an image, or a batch from a relay.
   * Same path either way, so dedupe and trust rules apply uniformly.
   */
  ingest(
    events: NostrEvent[],
    source: "image" | "relay" = "image",
    policy?: MergePolicy,
  ): IngestReport {
    const effective: MergePolicy = policy
      ?? (this.opts.trustUnknown ? "merge-all" : undefined)
      ?? this.opts.defaultPolicy
      ?? "follows-only";
    const now = (this.opts.now ?? (() => Date.now()))() / 1000;
    const skew = this.opts.maxFutureSkewSec ?? 900;
    const cap = this.opts.maxEventsPerPayload ?? 500;

    const report: IngestReport = {
      total: events.length, merged: [], quarantined: [],
      verdicts: {
        merged: 0, quarantined: 0, duplicate: 0, replaced: 0, superseded: 0,
        "invalid-signature": 0, "rejected-limit": 0, "rejected-future": 0,
      },
      strangers: [],
    };
    const strangers = new Set<string>();
    let accepted = 0;

    for (const ev of events) {
      if (accepted >= cap) { report.verdicts["rejected-limit"] += 1; continue; }

      if (this.seen.has(ev.id)) { report.verdicts.duplicate += 1; continue; }

      // Signature first: everything downstream assumes authorship is real.
      if (!verifyEvent(ev)) { report.verdicts["invalid-signature"] += 1; continue; }

      // A far-future timestamp would pin a replaceable event permanently.
      if (ev.created_at > now + skew) { report.verdicts["rejected-future"] += 1; continue; }

      this.seen.add(ev.id);
      accepted += 1;

      // Relay events are not user-opened content and keep the old path.
      const trusted = source === "relay"
        || effective === "merge-all"
        || (effective === "follows-only" && this.opts.follows.has(ev.pubkey));

      if (!trusted) {
        this.quarantine.set(ev.id, ev);
        report.quarantined.push(ev);
        report.verdicts.quarantined += 1;
        strangers.add(ev.pubkey);
        continue;
      }

      const v = this.insert(ev);
      report.verdicts[v] += 1;
      if (v === "merged" || v === "replaced") report.merged.push(ev);
    }

    report.strangers = [...strangers];
    return report;
  }
}

// -------------------------------------------------------------- packing ----

export interface PackOptions {
  /** Bytes available in the carrier after framing and error correction. */
  budget: number;
  /** Author whose own notes are most worth carrying. */
  self?: string;
  follows?: Set<string>;
  /** Compression ratio to assume; measured at ~0.35 for real nostr feeds. */
  compressionRatio?: number;
}

export interface PackResult {
  events: NostrEvent[];
  estimatedBytes: number;
  skipped: number;
  /** Replies whose parent was not included, so threads stay readable. */
  droppedOrphans: number;
}

function eventCost(ev: NostrEvent): number {
  return JSON.stringify(ev).length;
}

/**
 * Choose which events to embed for a given carrier budget.
 *
 * Not truncation: an image holding 4KB against a 40KB store has to choose, and
 * a naive "newest N" both wastes space on large events and emits replies whose
 * parents are missing. Events are scored by usefulness per byte, then a second
 * pass removes replies whose parent did not make the cut.
 */
export function packForCapacity(
  all: NostrEvent[],
  opts: PackOptions,
): PackResult {
  const ratio = opts.compressionRatio ?? 0.35;
  const follows = opts.follows ?? new Set<string>();
  const nowSec = Date.now() / 1000;

  const scored = all.map((ev) => {
    let score = 1;
    if (opts.self && ev.pubkey === opts.self) score += 4;   // your own notes matter most
    if (follows.has(ev.pubkey)) score += 2;
    if (isReplaceable(ev.kind)) score += 3;                 // profiles/relay lists are small and vital
    const ageDays = Math.max(0, (nowSec - ev.created_at) / 86400);
    score += Math.max(0, 3 - ageDays / 7);                  // recency, decaying over weeks
    const cost = eventCost(ev);
    return { ev, cost, density: score / Math.max(1, cost) };
  });

  scored.sort((a, b) => b.density - a.density);

  const chosen: NostrEvent[] = [];
  let raw = 0;
  let skipped = 0;
  for (const s of scored) {
    const projected = (raw + s.cost) * ratio;
    if (projected > opts.budget) { skipped += 1; continue; }
    chosen.push(s.ev);
    raw += s.cost;
  }

  // Drop replies whose parent did not make it: a dangling reply is noise.
  const ids = new Set(chosen.map((e) => e.id));
  const kept: NostrEvent[] = [];
  let droppedOrphans = 0;
  for (const ev of chosen) {
    const parent = ev.tags.find((t) => t[0] === "e")?.[1];
    if (parent && !ids.has(parent)) { droppedOrphans += 1; continue; }
    kept.push(ev);
  }

  return {
    events: kept,
    estimatedBytes: Math.round(kept.reduce((n, e) => n + eventCost(e), 0) * ratio),
    skipped,
    droppedOrphans,
  };
}
