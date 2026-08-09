import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RelayPool, Outbox, MemoryStorage, RelayRouter, parseRelayList,
  OPEN, type NostrEvent, type WebSocketLike, type BackoffFn,
} from "../net-pool";

/** Deterministic backoff: real jitter is 1000-2000ms, which races a fixed wait. */
const fastBackoff: BackoffFn = () => 10;

/** Scriptable fake relay: no network, full control over timing and replies. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;

  constructor(public url: string, public autoOk = true, public accept = true) {
    FakeSocket.all.push(this);
  }
  static all: FakeSocket[] = [];
  static reset() { FakeSocket.all = []; }

  connect() { this.readyState = OPEN; this.onopen?.(); }

  send(data: string) {
    this.sent.push(data);
    const msg = JSON.parse(data) as unknown[];
    if (msg[0] === "EVENT" && this.autoOk) {
      const ev = msg[1] as NostrEvent;
      queueMicrotask(() => this.reply(["OK", ev.id, this.accept, this.accept ? "" : "blocked"]));
    }
  }
  reply(msg: unknown[]) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
  close() { this.readyState = 3; }
}

const ev = (id: string, pubkey = "aa", tags: string[][] = []): NostrEvent => ({
  id, pubkey, created_at: 1, kind: 1, tags, content: "hi", sig: "00",
});

beforeEach(() => FakeSocket.reset());

describe("RelayPool", () => {
  it("reuses one socket per relay across many publishes", async () => {
    const pool = new RelayPool((u) => new FakeSocket(u));
    const relays = ["wss://a", "wss://b"];
    pool.ensure("wss://a"); pool.ensure("wss://b");
    FakeSocket.all.forEach((s) => s.connect());

    for (let i = 0; i < 5; i++) await pool.publish(ev(`e${i}`), relays);

    // Old code opened one socket per relay PER EVENT: 10 here. We open 2.
    expect(FakeSocket.all.length).toBe(2);
    expect(FakeSocket.all[0].sent.length).toBe(5);
    pool.close();
  });

  it("reports per-relay outcomes instead of returning void", async () => {
    const pool = new RelayPool((u) =>
      new FakeSocket(u, true, u !== "wss://bad"));
    pool.ensure("wss://good"); pool.ensure("wss://bad");
    FakeSocket.all.forEach((s) => s.connect());

    const res = await pool.publish(ev("x1"), ["wss://good", "wss://bad"]);
    expect(res["wss://good"].ok).toBe(true);
    expect(res["wss://bad"].ok).toBe(false);
    expect(res["wss://bad"].message).toBe("blocked");
    pool.close();
  });

  it("marks a relay not-connected rather than silently dropping", async () => {
    const pool = new RelayPool((u) => new FakeSocket(u));
    const res = await pool.publish(ev("x2"), ["wss://never"]);
    expect(res["wss://never"].ok).toBe(false);
    expect(res["wss://never"].message).toBe("not connected");
    pool.close();
  });

  it("re-arms subscriptions after a reconnect", async () => {
    const pool = new RelayPool((u) => new FakeSocket(u), () => Date.now(), fastBackoff);
    const got: NostrEvent[] = [];
    pool.subscribe("s1", [{ kinds: [1] }], ["wss://a"], (e) => got.push(e));
    const first = FakeSocket.all[0];
    first.connect();
    expect(first.sent.some((s) => s.includes('"REQ"'))).toBe(true);

    first.drop();
    await new Promise((r) => setTimeout(r, 60));
    const second = FakeSocket.all[1];
    expect(second).toBeDefined();
    second.connect();
    // Without re-arming, the feed would go silent forever after one blip.
    expect(second.sent.some((s) => s.includes('"REQ"'))).toBe(true);

    second.reply(["EVENT", "s1", ev("incoming")]);
    expect(got.length).toBe(1);
    pool.close();
  });

  it("tracks health and ranks healthy relays first", async () => {
    const pool = new RelayPool((u) => new FakeSocket(u));
    pool.ensure("wss://up"); pool.ensure("wss://down");
    FakeSocket.all[0].connect();
    await pool.publish(ev("h1"), ["wss://up"]);

    const health = pool.getHealth();
    expect(health.find((h) => h.url === "wss://up")!.accepted).toBe(1);
    expect(pool.rankedRelays()[0]).toBe("wss://up");
    pool.close();
  });
});

describe("Outbox", () => {
  it("survives a restart and delivers later", async () => {
    const storage = new MemoryStorage();
    // First run: no relay reachable, so nothing can be delivered.
    const pool1 = new RelayPool((u) => new FakeSocket(u));
    const out1 = new Outbox(pool1, storage);
    await out1.load();
    await out1.enqueue(ev("persist-me"), ["wss://a"]);
    await out1.flush();
    expect(out1.pending().length).toBe(1);
    pool1.close();

    // Simulate app restart: brand new objects, same storage.
    FakeSocket.reset();
    const pool2 = new RelayPool((u) => new FakeSocket(u));
    const out2 = new Outbox(pool2, storage, 1, () => Date.now() + 10 * 60_000);
    await out2.load();
    expect(out2.pending().length).toBe(1);   // recovered from storage

    pool2.ensure("wss://a");
    FakeSocket.all[0].connect();
    const r = await out2.flush();
    expect(r.delivered).toBe(1);
    expect(out2.pending().length).toBe(0);
    pool2.close();
  });

  it("retries with backoff and does not busy-loop", async () => {
    const storage = new MemoryStorage();
    let clock = 1_000_000;
    const pool = new RelayPool((u) => new FakeSocket(u));
    const out = new Outbox(pool, storage, 1, () => clock);
    await out.load();
    await out.enqueue(ev("retry-me"), ["wss://a"]);

    await out.flush();
    expect(out.pending()[0].attempts).toBe(1);

    // Immediately again: not yet due, so no wasted attempt.
    await out.flush();
    expect(out.pending()[0].attempts).toBe(1);

    clock += 120_000;
    await out.flush();
    expect(out.pending()[0].attempts).toBe(2);
    pool.close();
  });

  it("gives up after a bounded number of attempts", async () => {
    const storage = new MemoryStorage();
    let clock = 1_000_000;
    const pool = new RelayPool((u) => new FakeSocket(u));
    const out = new Outbox(pool, storage, 1, () => clock);
    await out.load();
    await out.enqueue(ev("doomed"), ["wss://a"]);
    for (let i = 0; i < 20; i++) { clock += 300_000; await out.flush(); }
    expect(out.pending().length).toBe(0);   // dropped, not retried forever
    pool.close();
  });

  it("only clears once a relay actually acknowledged", async () => {
    const storage = new MemoryStorage();
    const pool = new RelayPool((u) => new FakeSocket(u, true, false)); // always rejects
    const out = new Outbox(pool, storage);
    await out.load();
    pool.ensure("wss://a");
    FakeSocket.all[0].connect();
    await out.enqueue(ev("rejected"), ["wss://a"]);
    const r = await out.flush();
    expect(r.delivered).toBe(0);
    expect(out.pending().length).toBe(1);
    pool.close();
  });

  it("dedupes the same event arriving from several relays", async () => {
    const out = new Outbox(new RelayPool((u) => new FakeSocket(u)), new MemoryStorage());
    await out.load();
    expect(out.markSeen("dup")).toBe(true);
    expect(out.markSeen("dup")).toBe(false);
    expect(out.markSeen("dup")).toBe(false);
  });
});

describe("NIP-65 routing", () => {
  const list = (pubkey: string, tags: string[][]): NostrEvent => ({
    id: "l", pubkey, created_at: 1, kind: 10002, tags, content: "", sig: "0",
  });

  it("parses read/write markers, treating bare tags as both", () => {
    const e = list("alice", [
      ["r", "wss://both"],
      ["r", "wss://ro", "read"],
      ["r", "wss://wo", "write"],
    ]);
    const parsed = parseRelayList(e);
    expect(parsed).toEqual([
      { url: "wss://both", read: true, write: true },
      { url: "wss://ro", read: true, write: false },
      { url: "wss://wo", read: false, write: true },
    ]);
  });

  it("publishes to author write relays plus mentioned users' read relays", () => {
    const router = new RelayRouter(["wss://fallback"]);
    router.ingest(list("alice", [["r", "wss://alice-write", "write"]]));
    router.ingest(list("bob", [["r", "wss://bob-read", "read"]]));

    const targets = router.publishTargets(ev("m1", "alice", [["p", "bob"]]));
    expect(targets).toContain("wss://alice-write");
    // Without this, a mention never reaches the person mentioned.
    expect(targets).toContain("wss://bob-read");
  });

  it("falls back when a user has advertised nothing", () => {
    const router = new RelayRouter(["wss://fallback"]);
    expect(router.writeRelaysFor("stranger")).toEqual(["wss://fallback"]);
  });
});
