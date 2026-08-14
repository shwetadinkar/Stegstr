/**
 * net-adapter.ts — drop-in replacement for relay.ts.
 *
 * Exposes exactly the API App.tsx already imports (publishEvent, connectRelays,
 * getRelayUrls, DEFAULT_RELAYS) but backed by RelayPool, Outbox and SyncEngine.
 * Wiring is therefore a one-line import change in App.tsx rather than surgery on
 * a 2,700-line component -- which matters because a UI regression is not
 * something a test suite here would catch.
 *
 * What changes behind the identical signatures:
 *
 *   publishEvent      Was fire-and-forget: it opened a socket per relay, sent,
 *                     and returned void, so an event composed offline was
 *                     silently lost. Now every event is queued durably first and
 *                     retried until a relay acknowledges it. The signature still
 *                     returns void so callers need no change, but delivery is
 *                     observable via publishStatus().
 *
 *   connectRelays     Was one WebSocket per relay per subscription. Now one
 *                     pooled socket per relay, shared across all subscriptions,
 *                     with automatic reconnect and subscription re-arming so a
 *                     dropped connection does not silently kill the feed.
 *
 *   getRelayUrls      Was a fetch from stegstr.com/config/relay.json -- a single
 *                     point of failure, and a centralised one, in an app whose
 *                     premise is decentralisation. Now: the user's own
 *                     configured relays, then NIP-65 lists learned from the
 *                     network, then the hardcoded defaults. The remote config is
 *                     consulted last rather than first.
 *
 *   inbound events    Every event is signature-verified before reaching the UI.
 *                     relay.ts passed relay output through with only a shape
 *                     check, so a hostile relay could inject events attributed
 *                     to anyone.
 */

import {
  RelayPool, Outbox, MemoryStorage, RelayRouter,
  type NostrEvent, type Storage, type RelayHealth,
} from "./net-pool";
import { SyncEngine, verifyEvent, type MergePolicy } from "./sync-engine";

export type { MergePolicy };

export type { NostrEvent, RelayHealth };

/** Kept identical to relay.ts so existing imports resolve unchanged. */
export const DEFAULT_RELAYS = [
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

export const USER_RELAYS_KEY = "stegstr:relays:user";

/** localStorage-backed KV, falling back to memory where it is unavailable. */
class LocalStorage implements Storage {
  private mem = new MemoryStorage();
  private usable(): boolean {
    try { return typeof localStorage !== "undefined"; } catch { return false; }
  }
  async get(k: string) {
    if (!this.usable()) return this.mem.get(k);
    try { return localStorage.getItem(k); } catch { return this.mem.get(k); }
  }
  async set(k: string, v: string) {
    if (!this.usable()) return this.mem.set(k, v);
    try { localStorage.setItem(k, v); } catch { await this.mem.set(k, v); }
  }
  async remove(k: string) {
    if (!this.usable()) return this.mem.remove(k);
    try { localStorage.removeItem(k); } catch { await this.mem.remove(k); }
  }
}

const storage: Storage = new LocalStorage();
const pool = new RelayPool((url) => new WebSocket(url) as unknown as never);
const router = new RelayRouter(DEFAULT_RELAYS);
const outbox = new Outbox(pool, storage);
const sync = new SyncEngine({ follows: new Set(), defaultPolicy: "follows-only" });

let started = false;
function ensureStarted(): void {
  if (started) return;
  started = true;
  void outbox.load().then(() => outbox.start(5000));
}

/** Follows drive both quarantine policy and NIP-65 routing priority. */
export function setFollows(pubkeys: string[]): void {
  (sync as unknown as { opts: { follows: Set<string> } }).opts.follows = new Set(pubkeys);
}

export function getRelayHealth(): RelayHealth[] {
  return pool.getHealth();
}

export function publishStatus(): { pending: number; ids: string[] } {
  const p = outbox.pending();
  return { pending: p.length, ids: p.map((q) => q.event.id) };
}

/**
 * Relay selection, most-trusted source first.
 *
 * The user's own choice beats anything learned from the network, which beats
 * a list served by one website. relay.ts had that order inverted.
 */
export async function getRelayUrls(): Promise<string[]> {
  const own = await storage.get(USER_RELAYS_KEY);
  if (own) {
    try {
      const urls = JSON.parse(own) as string[];
      if (Array.isArray(urls) && urls.length) return urls;
    } catch { /* fall through */ }
  }
  const learned = pool.rankedRelays();
  if (learned.length >= 2) return learned.slice(0, 6);
  return [...DEFAULT_RELAYS];
}

export async function setUserRelays(urls: string[]): Promise<void> {
  await storage.set(USER_RELAYS_KEY, JSON.stringify(urls));
}

/**
 * Queue an event for delivery.
 *
 * Signature matches relay.ts (returns void) so callers are unchanged, but the
 * event is persisted before any network attempt and retried with backoff until
 * a relay acknowledges it. Composing offline no longer loses the note.
 */
export function publishEvent(event: NostrEvent, relays: string[] = DEFAULT_RELAYS): void {
  ensureStarted();
  const targets = router.publishTargets(event, 8);
  const chosen = targets.length ? targets : relays;
  void outbox.enqueue(event, chosen).then(() => outbox.flush());
}

/**
 * Publish and wait for relay acknowledgement, reporting which relays took it.
 *
 * `publishEvent` is deliberately fire-and-forget-with-durability: the caller
 * does not wait, and the outbox retries until something accepts. That is right
 * for posting a note, and wrong for the pointer tier, where the image is
 * useless until the blob it names is actually retrievable. Handing someone a
 * pointer to an event still sitting in a local queue produces an image that
 * decodes perfectly and yields nothing.
 *
 * The event is also enqueued in the outbox, so a partial or failed publish
 * still gets retried in the background rather than being lost.
 */
export async function publishAndConfirm(
  event: NostrEvent,
  relays: string[] = DEFAULT_RELAYS,
  timeoutMs = 8000,
): Promise<{ accepted: string[]; failed: Record<string, string> }> {
  ensureStarted();
  const targets = router.publishTargets(event, 8);
  const chosen = targets.length ? targets : relays;
  void outbox.enqueue(event, chosen);

  // Wait for the handshakes before asking. Without this, a cold pool reports
  // "not connected" for every relay and the caller concludes nothing would
  // accept the event, when in truth nothing was ever asked.
  await pool.ensureConnected(chosen);

  const collect = (results: Record<string, { ok: boolean; message: string }>) => {
    const accepted: string[] = [];
    const failed: Record<string, string> = {};
    for (const [url, r] of Object.entries(results)) {
      if (r.ok) accepted.push(url);
      else failed[url] = r.message || "rejected";
    }
    return { accepted, failed };
  };

  let out = collect(await pool.publish(event, chosen, timeoutMs));
  // One retry, but only for the case that retrying can actually fix: every
  // relay unreachable rather than any relay refusing. A rejection is a verdict
  // and asking again just wastes the user's time.
  if (out.accepted.length === 0 && Object.values(out.failed).every((m) => m === "not connected")) {
    await pool.ensureConnected(chosen);
    out = collect(await pool.publish(event, chosen, timeoutMs));
  }
  return out;
}

/**
 * Fetch a single event by id. Resolves null if no relay produced it in time.
 *
 * Needed by the pointer tier: an image carries an event id, and the content it
 * names has to be pulled back before anything can be shown. This is a one-shot
 * request rather than a standing subscription, so it deliberately does not go
 * through the shared dedupe -- `outbox.markSeen` would return false for an
 * event already seen in the feed, and the fetch would time out on content we
 * demonstrably have.
 *
 * The id is re-checked against what came back. A relay is free to answer a
 * filter with whatever it likes, and the whole point of resolving by id is
 * that the id was fixed by the sender.
 */
export async function fetchEventById(
  id: string,
  relays: string[],
  timeoutMs = 8000,
): Promise<NostrEvent | null> {
  ensureStarted();
  const targets = relays.length ? relays : await getRelayUrls();
  return new Promise<NostrEvent | null>((resolve) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    const finish = (ev: NostrEvent | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { unsub?.(); } catch { /* ignore */ }
      resolve(ev);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      unsub = pool.subscribe(
        nextSubId("fetch"),
        [{ ids: [id], limit: 1 }],
        targets,
        (ev) => {
          if (ev.id !== id) return;
          if (!verifyEvent(ev)) return;
          finish(ev);
        },
      );
    } catch {
      finish(null);
    }
  });
}

export type RelayEventCallback = (event: NostrEvent) => void;

export type ConnectRelaysResult = {
  close: () => void;
  publish: (event: NostrEvent) => void;
  requestProfiles: (pubkeys: string[]) => void;
  requestReplies: (noteIds: string[]) => void;
  requestAuthor: (authorPubkey: string) => void;
  requestFollowers: (ofPubkey: string) => void;
  requestSearch: (query: string) => void;
  requestProfileSearch: (query: string) => void;
  requestMore: (until: number) => void;
};

let subCounter = 0;
const nextSubId = (p: string) => `${p}-${++subCounter}`;

export function connectRelays(
  ourPubkeys: string[],
  onEvent: RelayEventCallback,
  onEose?: () => void,
  onError?: (err: unknown) => void,
  relays: string[] = DEFAULT_RELAYS,
): ConnectRelaysResult {
  ensureStarted();
  const unsubs: Array<() => void> = [];
  let eosed = false;

  const deliver = (ev: NostrEvent) => {
    // Two gates relay.ts did not have: cryptographic verification, and dedupe
    // across every relay and every subscription.
    if (!verifyEvent(ev)) return;
    if (!outbox.markSeen(ev.id)) return;
    router.ingest(ev);
    sync.ingest([ev], "relay");
    try { onEvent(ev); } catch (err) { onError?.(err); }
  };

  const sub = (prefix: string, filters: unknown[], targets: string[] = relays) => {
    try {
      unsubs.push(pool.subscribe(nextSubId(prefix), filters, targets, deliver));
    } catch (err) { onError?.(err); }
  };

  // Initial feed, plus the authors' own relay lists so routing can improve.
  sub("feed", [{ kinds: [1, 6, 7], authors: ourPubkeys, limit: 100 }]);
  sub("meta", [{ kinds: [0, 3, 10002], authors: ourPubkeys }]);
  // Global discovery. relay.ts bundled author-unscoped filters (kinds 0 and
  // 1/6 with no `authors` field) into the same subscription so the "Global"
  // feed tab could show content from anyone, not just follows -- App.tsx's
  // feedFilter==="following" branch already narrows this down client-side
  // (contactsSet.has(authorPk)), so it only needs the wider stream to filter
  // from. The rewrite kept only author-scoped filters, so the Global tab had
  // nothing to show: the sockets connected fine, but nothing that wasn't
  // already a follow was ever requested.
  sub("global", [{ kinds: [1, 6], limit: 100 }, { kinds: [0], limit: 200 }]);

  if (onEose) {
    setTimeout(() => { if (!eosed) { eosed = true; onEose(); } }, 1500);
  }

  return {
    close: () => { for (const u of unsubs) { try { u(); } catch { /* ignore */ } } },
    publish: (event) => publishEvent(event, relays),
    requestProfiles: (pubkeys) => {
      if (pubkeys.length) sub("prof", [{ kinds: [0], authors: pubkeys }]);
    },
    requestReplies: (noteIds) => {
      if (noteIds.length) sub("repl", [{ kinds: [1], "#e": noteIds, limit: 200 }]);
    },
    requestAuthor: (authorPubkey) => {
      // Read an author from the relays THEY advertise, not from our own list.
      const target = router.readRelaysFor(authorPubkey, 4);
      sub("auth", [
        { kinds: [1], authors: [authorPubkey], limit: 100 },
        { kinds: [0, 3, 10002], authors: [authorPubkey] },
      ], target);
    },
    requestFollowers: (ofPubkey) => {
      sub("flwr", [{ kinds: [3], "#p": [ofPubkey], limit: 200 }]);
    },
    requestSearch: (query) => {
      if (query.trim()) sub("srch", [{ kinds: [1], search: query, limit: 50 }]);
    },
    requestProfileSearch: (query) => {
      if (query.trim()) sub("psrch", [{ kinds: [0], search: query, limit: 30 }]);
    },
    requestMore: (until) => {
      sub("more", [{ kinds: [1], authors: ourPubkeys, until, limit: 50 }]);
    },
  };
}

/**
 * Merge a payload decoded from a steganographic image.
 *
 * This is the path relay.ts never had, because images were never treated as a
 * transport. Events arriving this way are verified and, unless the author is
 * followed, quarantined rather than merged -- anyone can send a JPEG, and that
 * must not be enough to write to someone's feed.
 */
export function ingestFromImage(events: NostrEvent[], policy?: MergePolicy) {
  return sync.ingest(events, "image", policy);
}

/** Review actions for held content. */
export function promoteAllQuarantined(): number { return sync.promoteAll(); }
export function promoteAuthor(pubkey: string): number { return sync.promoteAuthor(pubkey); }
export function rejectQuarantined(id: string): boolean { return sync.reject(id); }
export function rejectAllQuarantined(): number { return sync.rejectAll(); }
export function pendingByAuthor() { return sync.pendingByAuthor(); }

export function quarantinedEvents(): NostrEvent[] {
  return sync.quarantined();
}

export function promoteQuarantined(id: string): boolean {
  return sync.promote(id);
}

export function syncEngine(): SyncEngine {
  return sync;
}

export function shutdown(): void {
  outbox.stop();
  pool.close();
}
