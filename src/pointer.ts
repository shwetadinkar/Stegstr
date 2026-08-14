/**
 * pointer.ts — the pointer tier (§10.4, decided in §15.15).
 *
 * Every channel measurement in this project says the same thing: the artifact
 * is driven by delta x payload. Delta is bounded below by what the channel
 * does to the image, so the only remaining lever is payload -- and no encoder
 * tuning beats not sending the bytes. At 1280x960 (Telegram-as-photo, §15.12)
 * payload size dominates everything else.
 *
 * So: publish the feed as an encrypted blob on nostr, and embed only a pointer
 * to it. ~200 bytes instead of kilobytes. At that size, with rsNsym 32,
 * Telegram-as-photo needs well under one AC position per block -- quieter than
 * WhatsApp is today.
 *
 * WHAT THIS COSTS. The image stops being self-contained: without a relay the
 * recipient gets nothing, where a self-contained image works offline forever.
 * And the fetch is observable -- someone watching the recipient's relay traffic
 * sees a request for a specific event id at a specific time, which is a
 * metadata leak the self-contained mode does not have. This is a real tradeoff
 * and the reason pointer mode is a choice rather than the default.
 *
 * WHAT IT DOES NOT COST. The blob on the relay is ciphertext. A relay operator,
 * or anyone scraping, sees an opaque payload of app-specific data. The key
 * lives in the image and travels with it.
 *
 * TWO KEY MODES, matching the two the embed path already offers:
 *
 *   open        The blob is encrypted with a fresh random key carried in the
 *               pointer. Whoever holds the image can read the feed; the relay
 *               cannot. Note the app key is NOT usable here -- it is derived
 *               from a constant salt, so it is obfuscation against casual
 *               inspection of an image, and on a public relay it would be no
 *               protection at all.
 *
 *   recipients  The blob is encrypted with the existing per-recipient envelope
 *               and the pointer carries no key. Only the listed pubkeys can
 *               read it, even holding the image. This is strictly better than
 *               wrapping the pointer itself per recipient, which would add
 *               ~100 bytes per recipient to the part that has to survive the
 *               channel -- the expensive place to spend bytes.
 */

import * as Nostr from "./nostr-stub";
import type { NostrEvent } from "./types";
import { encryptApp, encryptForRecipients, decryptPayload } from "./stego-crypto";

/**
 * NIP-78 application-specific data. Chosen over a bespoke kind because relays
 * that implement NIP-78 will store it without special configuration, and the
 * contest is judged partly on networking reliability -- an event a relay drops
 * is a broken feature no matter how elegant the number is.
 *
 * It is addressable (a `d` tag), but each blob gets a random `d`, so blobs
 * never replace one another. Resolution is by event id regardless.
 */
export const POINTER_KIND = 30078;

/** Version byte for the pointer envelope, so old images stay readable. */
export const POINTER_VERSION = 1;

/**
 * Hard ceiling on the embedded pointer, envelope included.
 *
 * The point of this tier is smallness; a pointer that quietly grew to a
 * kilobyte would defeat it while still appearing to work. Relay hints are
 * trimmed to stay under this, and a test asserts it.
 */
export const MAX_POINTER_BYTES = 300;

/** Relay hints carried in the pointer, before trimming to fit the budget. */
const MAX_RELAY_HINTS = 3;

export interface Pointer {
  /** Discriminator; distinguishes a pointer from a `{version, events}` bundle. */
  t: "p";
  v: number;
  /** Event id of the blob, 64 hex chars. */
  i: string;
  /** Content key, 64 hex chars. Absent in recipients mode. */
  k?: string;
  /** Relay hints. Best-effort: resolution also tries the user's own relays. */
  r?: string[];
}

// ------------------------------------------------------------------ base64 --

/** Chunked so a large blob does not blow the argument limit on apply(). */
function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 8192;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    s += String.fromCharCode.apply(null, Array.from(sub));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ----------------------------------------------------------------- crypto --

/** Encrypt with a fresh random key. Returns iv||ciphertext and the key. */
async function encryptWithRandomKey(
  plaintext: string,
): Promise<{ blob: Uint8Array; keyHex: string }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    new TextEncoder().encode(plaintext),
  );
  const blob = new Uint8Array(iv.length + ciphertext.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(ciphertext), iv.length);
  return { blob, keyHex: Nostr.bytesToHex(keyBytes) };
}

async function decryptWithKey(blob: Uint8Array, keyHex: string): Promise<string> {
  if (blob.length < 12 + 16) throw new Error("Pointer blob too short");
  const keyBytes = Nostr.hexToBytes(keyHex);
  const iv = blob.slice(0, 12);
  const ciphertext = blob.slice(12);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, ciphertext);
  return new TextDecoder().decode(dec);
}

// ------------------------------------------------------------------ build --

export interface BuildPointerOptions {
  /** The bundle JSON that would otherwise have gone into the image whole. */
  bundleJson: string;
  /** Signs the blob event. */
  privKeyHex: string;
  /** Relay hints to carry, most-preferred first. Trimmed to fit the budget. */
  relays: string[];
  /** When set, the blob is restricted to these pubkeys and no key is carried. */
  recipients?: string[];
}

export interface BuiltPointer {
  /** Signed blob event, ready to publish. Must reach a relay before sending. */
  event: NostrEvent;
  /** Encrypted pointer bytes, to embed in the image. */
  pointerBytes: Uint8Array;
  /** For logging: how many hints survived trimming, and the final size. */
  pointer: Pointer;
  droppedHints: number;
}

/**
 * Build the blob event and the pointer that finds it.
 *
 * The caller must publish `event` and confirm delivery before handing the
 * image to anyone. A pointer to an event no relay holds is an image that
 * decodes cleanly to nothing -- the most confusing possible failure, because
 * every stego-side indicator says success.
 */
export async function buildPointer(opts: BuildPointerOptions): Promise<BuiltPointer> {
  const { bundleJson, privKeyHex, relays, recipients } = opts;

  let blobBytes: Uint8Array;
  let keyHex: string | undefined;
  if (recipients && recipients.length > 0) {
    const selfPk = Nostr.getPublicKey(Nostr.hexToBytes(privKeyHex));
    const all = Array.from(new Set([selfPk, ...recipients]));
    blobBytes = await encryptForRecipients(bundleJson, privKeyHex, all);
  } else {
    const enc = await encryptWithRandomKey(bundleJson);
    blobBytes = enc.blob;
    keyHex = enc.keyHex;
  }

  // A random `d` keeps blobs from replacing one another under NIP-78's
  // addressable-event semantics.
  const dTag = Nostr.bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const event = (await Nostr.finishEventAsync(
    {
      kind: POINTER_KIND,
      content: bytesToBase64(blobBytes),
      tags: [["d", dTag]],
      created_at: Math.floor(Date.now() / 1000),
    },
    Nostr.hexToBytes(privKeyHex),
  )) as NostrEvent;

  // Trim relay hints until the whole thing fits. Hints are the only variable
  // cost here (id and key are fixed-width), so dropping the least-preferred
  // one is the natural lever. The pointer always fits eventually: with no
  // hints at all it is ~150 bytes.
  const wanted = relays.slice(0, MAX_RELAY_HINTS);
  let hints = [...wanted];
  let pointer: Pointer;
  let pointerBytes: Uint8Array;
  for (;;) {
    pointer = { t: "p", v: POINTER_VERSION, i: event.id, ...(keyHex ? { k: keyHex } : {}), ...(hints.length ? { r: hints } : {}) };
    pointerBytes = await encryptApp(JSON.stringify(pointer));
    if (pointerBytes.length <= MAX_POINTER_BYTES || hints.length === 0) break;
    hints = hints.slice(0, -1);
  }

  return { event, pointerBytes, pointer, droppedHints: wanted.length - hints.length };
}

// ------------------------------------------------------------------ parse --

/**
 * True if a decrypted payload is a pointer rather than a self-contained
 * bundle. Both arrive through the same decrypt path, so the detect side has to
 * tell them apart before deciding what to do.
 */
export function isPointer(jsonString: string): boolean {
  return parsePointer(jsonString) !== null;
}

/** Parse and validate. Returns null for anything that is not a valid pointer. */
export function parsePointer(jsonString: string): Pointer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.t !== "p") return null;
  if (typeof p.i !== "string" || !/^[0-9a-f]{64}$/i.test(p.i)) return null;
  if (p.k !== undefined && (typeof p.k !== "string" || !/^[0-9a-f]{64}$/i.test(p.k))) return null;
  if (p.r !== undefined && (!Array.isArray(p.r) || p.r.some((x) => typeof x !== "string"))) return null;
  const v = typeof p.v === "number" ? p.v : 0;
  return {
    t: "p",
    v,
    i: (p.i as string).toLowerCase(),
    ...(p.k ? { k: (p.k as string).toLowerCase() } : {}),
    ...(p.r ? { r: p.r as string[] } : {}),
  };
}

// ---------------------------------------------------------------- resolve --

/** Fetches an event by id, trying the given relays. Resolves null if not found. */
export type FetchEventById = (
  id: string,
  relays: string[],
) => Promise<NostrEvent | null>;

export class PointerUnresolved extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PointerUnresolved";
  }
}

/**
 * Follow a pointer to the bundle JSON it names.
 *
 * Failure here is not the same as a failed decode, and the caller must not
 * report it as one: the image was read perfectly, and the content is missing
 * or unreadable at the far end. Telling the user "not a Stegstr image" when
 * the truth is "the relay does not have it yet" sends them to re-shoot the
 * photo, which cannot help.
 */
export async function resolvePointer(
  pointer: Pointer,
  fetchEvent: FetchEventById,
  ourPrivKeyHex: string,
  extraRelays: string[] = [],
): Promise<string> {
  if (pointer.v > POINTER_VERSION) {
    throw new PointerUnresolved(
      `This image was made by a newer version of Stegstr (pointer v${pointer.v}). Update to read it.`,
    );
  }

  // Hints first -- the sender knows where they published -- then the user's
  // own relays, which cover the case where the hints were trimmed for size.
  const targets = Array.from(new Set([...(pointer.r ?? []), ...extraRelays]));
  if (targets.length === 0) {
    throw new PointerUnresolved("No relays available to fetch the hidden content from.");
  }

  let event: NostrEvent | null;
  try {
    event = await fetchEvent(pointer.i, targets);
  } catch (e) {
    throw new PointerUnresolved(
      `Could not reach a relay to fetch the hidden content: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!event) {
    throw new PointerUnresolved(
      "The image points to content that no relay returned. It may not have propagated yet, " +
      "or it may have been dropped. Try again shortly.",
    );
  }

  let blob: Uint8Array;
  try {
    blob = base64ToBytes(event.content);
  } catch {
    throw new PointerUnresolved("The referenced event is not readable Stegstr content.");
  }

  if (pointer.k) {
    try {
      return await decryptWithKey(blob, pointer.k);
    } catch {
      throw new PointerUnresolved(
        "The referenced content could not be decrypted with the key in this image.",
      );
    }
  }
  // No key: recipients mode. Only a listed pubkey can open it, and
  // decryptPayload throws a specific message when we are not one.
  return decryptPayload(blob, ourPrivKeyHex);
}
