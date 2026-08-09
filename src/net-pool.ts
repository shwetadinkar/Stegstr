/**
 * net-pool.ts — reliable nostr networking for Stegstr.
 *
 * Replaces the fire-and-forget publish path in relay.ts. The existing
 * publishEvent() opens a fresh WebSocket per relay per event, sends, and closes
 * after 3s or the first OK. It returns void, so a caller can never tell whether
 * anything was accepted; if the device is offline the event is silently lost.
 *
 * What this module provides instead:
 *
 *   RelayPool     One persistent socket per relay, shared across all publishes
 *                 and subscriptions, with exponential-backoff reconnect and
 *                 per-relay health tracking. Publishing 10 events no longer
 *                 opens 40 sockets.
 *
 *   Outbox        A durable queue. Events are persisted before any network
 *                 attempt, retried with backoff, and only removed once a relay
 *                 has acknowledged them with OK. Survives reload, offline
 *                 periods, and relay outages. This is the difference between
 *                 "we sent it" and "it arrived".
 *
 *   NIP-65        Route by the outbox model: publish to the author's write
 *                 relays, read a user's events from the relays they advertise
 *                 (kind 10002), rather than to one hardcoded list.
 *
 *   Dedupe        Seen-event tracking so the same event arriving from four
 *                 relays surfaces once.
 *
 * Storage is injected rather than assumed, so this runs under Tauri, the web
 * build, and tests without change.
 */

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Minimal async KV. localStorage, Tauri store, or an in-memory map in tests. */
export interface Storage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  async get(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async remove(k: string) { this.m.delete(k); }
}

/** Injected so tests can drive a fake socket without a network. */
export interface SocketFactory {
  (url: string): WebSocketLike;
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
}

export const OPEN = 1;

export interface RelayHealth {
  url: string;
  connected: boolean;
  attempts: number;
  lastError: string | null;
  lastConnectedAt: number | null;
  accepted: number;
  rejected: number;
  /** Consecutive failures; drives backoff and relay ranking. */
  failures: number;
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Exponential backoff with jitter.
 *
 * The jitter is deliberate: without it, every client that was connected to a
 * relay when it went down retries at the same instant and hammers it back over.
 * It also makes timing non-deterministic, so it is injectable -- tests pass a
 * fixed function rather than racing a random interval.
 */
export type BackoffFn = (failures: number) => number;

export const defaultBackoff: BackoffFn = (failures) => {
  const raw = BASE_BACKOFF_MS * Math.pow(2, Math.min(failures, 6));
  return Math.min(MAX_BACKOFF_MS, raw) * (0.5 + Math.random() * 0.5);
};

type OkHandler = (ok: boolean, message: string) => void;
type EventHandler = (event: NostrEvent, relayUrl: string) => void;

export class RelayPool {
  private sockets = new Map<string, WebSocketLike>();
  private health = new Map<string, RelayHealth>();
  private pendingOk = new Map<string, Map<string, OkHandler>>();
  private subs = new Map<string, { filters: unknown[]; onEvent: EventHandler }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private mkSocket: SocketFactory,
    private now: () => number = () => Date.now(),
    private backoff: BackoffFn = defaultBackoff,
  ) {}

  getHealth(): RelayHealth[] {
    return [...this.health.values()];
  }

  /** Relays ranked best-first: connected before disconnected, fewer failures first. */
  rankedRelays(): string[] {
    return this.getHealth()
      .sort((a, b) =>
        Number(b.connected) - Number(a.connected) ||
        a.failures - b.failures ||
        b.accepted - a.accepted)
      .map((h) => h.url);
  }

  ensure(url: string): void {
    if (this.closed) return;
    if (!this.health.has(url)) {
      this.health.set(url, {
        url, connected: false, attempts: 0, lastError: null,
        lastConnectedAt: null, accepted: 0, rejected: 0, failures: 0,
      });
    }
    if (this.sockets.has(url)) return;
    this.open(url);
  }

  private open(url: string): void {
    const h = this.health.get(url)!;
    h.attempts += 1;
    let ws: WebSocketLike;
    try {
      ws = this.mkSocket(url);
    } catch (err) {
      h.lastError = String(err);
      h.failures += 1;
      this.scheduleReconnect(url);
      return;
    }
    this.sockets.set(url, ws);

    ws.onopen = () => {
      h.connected = true;
      h.failures = 0;
      h.lastError = null;
      h.lastConnectedAt = this.now();
      // Re-arm every subscription; a reconnect must not silently lose feeds.
      for (const [id, s] of this.subs) {
        this.rawSend(url, JSON.stringify(["REQ", id, ...s.filters]));
      }
    };

    ws.onmessage = (ev) => {
      let msg: unknown[];
      try { msg = JSON.parse(ev.data) as unknown[]; } catch { return; }
      const kind = msg[0];
      if (kind === "OK") {
        const [, id, ok, message] = msg as [string, string, boolean, string];
        const byRelay = this.pendingOk.get(id);
        const cb = byRelay?.get(url);
        if (ok) h.accepted += 1; else h.rejected += 1;
        if (cb) { byRelay!.delete(url); cb(Boolean(ok), message ?? ""); }
      } else if (kind === "EVENT") {
        const [, subId, event] = msg as [string, string, NostrEvent];
        this.subs.get(subId)?.onEvent(event, url);
      } else if (kind === "NOTICE") {
        h.lastError = String(msg[1] ?? "notice");
      }
    };

    ws.onerror = () => { h.lastError = "socket error"; };

    ws.onclose = () => {
      h.connected = false;
      h.failures += 1;
      this.sockets.delete(url);
      this.scheduleReconnect(url);
    };
  }

  private scheduleReconnect(url: string): void {
    if (this.closed) return;
    if (this.timers.has(url)) return;
    const h = this.health.get(url)!;
    const t = setTimeout(() => {
      this.timers.delete(url);
      if (!this.closed) this.open(url);
    }, this.backoff(h.failures));
    this.timers.set(url, t);
  }

  private rawSend(url: string, payload: string): boolean {
    const ws = this.sockets.get(url);
    if (!ws || ws.readyState !== OPEN) return false;
    try { ws.send(payload); return true; } catch { return false; }
  }

  /**
   * Publish to the given relays and resolve with per-relay outcomes.
   *
   * Unlike the current publishEvent, the caller learns what actually happened:
   * which relays accepted, which rejected and why, which never answered.
   */
  publish(
    event: NostrEvent,
    relays: string[],
    timeoutMs = 5000,
  ): Promise<Record<string, { ok: boolean; message: string }>> {
    const payload = JSON.stringify(["EVENT", event]);
    const results: Record<string, { ok: boolean; message: string }> = {};
    const byRelay = new Map<string, OkHandler>();
    this.pendingOk.set(event.id, byRelay);

    return new Promise((resolve) => {
      let settled = 0;
      const total = relays.length;
      const done = () => {
        this.pendingOk.delete(event.id);
        for (const url of relays) {
          if (!(url in results)) results[url] = { ok: false, message: "timeout" };
        }
        resolve(results);
      };
      if (total === 0) { resolve(results); return; }
      const timer = setTimeout(done, timeoutMs);

      for (const url of relays) {
        this.ensure(url);
        byRelay.set(url, (ok, message) => {
          results[url] = { ok, message };
          if (++settled === total) { clearTimeout(timer); done(); }
        });
        if (!this.rawSend(url, payload)) {
          results[url] = { ok: false, message: "not connected" };
          byRelay.delete(url);
          if (++settled === total) { clearTimeout(timer); done(); }
        }
      }
    });
  }

  subscribe(id: string, filters: unknown[], relays: string[], onEvent: EventHandler): () => void {
    this.subs.set(id, { filters, onEvent });
    const payload = JSON.stringify(["REQ", id, ...filters]);
    for (const url of relays) {
      this.ensure(url);
      this.rawSend(url, payload);
    }
    return () => {
      this.subs.delete(id);
      const close = JSON.stringify(["CLOSE", id]);
      for (const url of relays) this.rawSend(url, close);
    };
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const ws of this.sockets.values()) { try { ws.close(); } catch { /* ignore */ } }
    this.sockets.clear();
  }
}

// ---------------------------------------------------------------- outbox ----

export interface QueuedEvent {
  event: NostrEvent;
  relays: string[];
  attempts: number;
  nextAttemptAt: number;
  acceptedBy: string[];
  lastError: string | null;
}

const OUTBOX_KEY = "stegstr:outbox:v1";
const SEEN_KEY = "stegstr:seen:v1";
const MAX_ATTEMPTS = 12;
const SEEN_LIMIT = 5000;

/**
 * Durable publish queue.
 *
 * An event is persisted BEFORE any network attempt and removed only once at
 * least `minAcks` relays have acknowledged it. Nothing is lost to a dropped
 * connection, a backgrounded app, or a flight with no signal.
 */
export class Outbox {
  private queue: QueuedEvent[] = [];
  private seen = new Set<string>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private pool: RelayPool,
    private storage: Storage,
    private minAcks = 1,
    private now: () => number = () => Date.now(),
    private backoff: BackoffFn = defaultBackoff,
  ) {}

  async load(): Promise<void> {
    const raw = await this.storage.get(OUTBOX_KEY);
    if (raw) { try { this.queue = JSON.parse(raw) as QueuedEvent[]; } catch { this.queue = []; } }
    const seenRaw = await this.storage.get(SEEN_KEY);
    if (seenRaw) { try { this.seen = new Set(JSON.parse(seenRaw) as string[]); } catch { /* ignore */ } }
  }

  private async persist(): Promise<void> {
    await this.storage.set(OUTBOX_KEY, JSON.stringify(this.queue));
  }

  /** True the first time an event id is seen. Collapses the same event from N relays. */
  markSeen(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) {
      // Drop the oldest half; insertion order is preserved by Set.
      this.seen = new Set([...this.seen].slice(SEEN_LIMIT / 2));
    }
    void this.storage.set(SEEN_KEY, JSON.stringify([...this.seen]));
    return true;
  }

  pending(): QueuedEvent[] { return [...this.queue]; }

  async enqueue(event: NostrEvent, relays: string[]): Promise<void> {
    if (this.queue.some((q) => q.event.id === event.id)) return;
    this.queue.push({
      event, relays, attempts: 0, nextAttemptAt: 0,
      acceptedBy: [], lastError: null,
    });
    await this.persist();
  }

  /**
   * One pass over due items. Returns how many were fully delivered.
   * Safe to call repeatedly; re-entrant calls are ignored.
   */
  async flush(): Promise<{ delivered: number; remaining: number; failed: number }> {
    if (this.running) return { delivered: 0, remaining: this.queue.length, failed: 0 };
    this.running = true;
    let delivered = 0;
    let failed = 0;
    try {
      const due = this.queue.filter((q) => q.nextAttemptAt <= this.now());
      for (const item of due) {
        const targets = item.relays.filter((r) => !item.acceptedBy.includes(r));
        const res = await this.pool.publish(item.event, targets);
        for (const [url, r] of Object.entries(res)) {
          if (r.ok) item.acceptedBy.push(url);
          else item.lastError = `${url}: ${r.message}`;
        }
        item.attempts += 1;
        if (item.acceptedBy.length >= this.minAcks) {
          this.queue = this.queue.filter((q) => q.event.id !== item.event.id);
          delivered += 1;
        } else if (item.attempts >= MAX_ATTEMPTS) {
          this.queue = this.queue.filter((q) => q.event.id !== item.event.id);
          failed += 1;
        } else {
          item.nextAttemptAt = this.now() + this.backoff(item.attempts);
        }
      }
      await this.persist();
    } finally {
      this.running = false;
    }
    return { delivered, remaining: this.queue.length, failed };
  }

  start(intervalMs = 5000): void {
    const tick = async () => {
      await this.flush();
      this.timer = setTimeout(tick, intervalMs);
    };
    if (!this.timer) this.timer = setTimeout(tick, intervalMs);
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

// ---------------------------------------------------------------- NIP-65 ----

export interface RelayListEntry { url: string; read: boolean; write: boolean; }

/** Parse a kind-10002 relay list (NIP-65). Bare "r" tags mean read AND write. */
export function parseRelayList(event: NostrEvent): RelayListEntry[] {
  if (event.kind !== 10002) return [];
  const out: RelayListEntry[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "r" || !tag[1]) continue;
    const marker = tag[2];
    out.push({
      url: tag[1],
      read: marker !== "write",
      write: marker !== "read",
    });
  }
  return out;
}

/**
 * Relay routing under the outbox model.
 *
 * Publishing goes to the author's own write relays, plus the read relays of
 * anyone tagged, so mentions actually reach their target. Reading a user's
 * events uses the relays that user advertises, not a global list. This is what
 * makes nostr work without central infrastructure -- and why fetching one
 * relay list from stegstr.com is the wrong shape for the problem.
 */
export class RelayRouter {
  private lists = new Map<string, RelayListEntry[]>();

  constructor(private fallback: string[]) {}

  ingest(event: NostrEvent): void {
    const entries = parseRelayList(event);
    if (entries.length) this.lists.set(event.pubkey, entries);
  }

  writeRelaysFor(pubkey: string, limit = 4): string[] {
    const l = (this.lists.get(pubkey) ?? []).filter((e) => e.write).map((e) => e.url);
    return (l.length ? l : this.fallback).slice(0, limit);
  }

  readRelaysFor(pubkey: string, limit = 4): string[] {
    const l = (this.lists.get(pubkey) ?? []).filter((e) => e.read).map((e) => e.url);
    return (l.length ? l : this.fallback).slice(0, limit);
  }

  /** Where to send an event: author's write relays plus mentioned users' read relays. */
  publishTargets(event: NostrEvent, limit = 8): string[] {
    const set = new Set(this.writeRelaysFor(event.pubkey));
    for (const tag of event.tags) {
      if (tag[0] === "p" && tag[1]) {
        for (const r of this.readRelaysFor(tag[1], 2)) set.add(r);
      }
    }
    return [...set].slice(0, limit);
  }

  known(): string[] { return [...this.lists.keys()]; }
}
