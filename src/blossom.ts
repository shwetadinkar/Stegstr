/**
 * blossom.ts — encrypted attachments of any type, on hosts that only take media.
 *
 * THE PROBLEM. Attaching a file uploaded it to nostr.build unencrypted, so the
 * host held your photo in the clear and anyone with the URL could read it —
 * markedly weaker than the rest of this app, where a relay only ever sees
 * ciphertext. And documents were rejected outright: nostr.build hosts media.
 *
 * WHAT THE SERVERS ACTUALLY DO, measured against four public Blossom servers
 * rather than assumed:
 *
 *   arbitrary bytes (application/octet-stream)   rejected, 415 / "not allowed"
 *   PDF                                          rejected
 *   valid PNG                                    accepted, round-trip byte-IDENTICAL
 *
 * So encrypted data cannot be uploaded as itself — it looks like arbitrary
 * binary, which is exactly what these hosts refuse. But a PNG survives
 * unchanged, which means a PNG is a usable container.
 *
 * THE APPROACH. Encrypt the file, carry the ciphertext as PNG pixel data, and
 * upload that. The host sees and stores an ordinary image. Everything that
 * identifies the file — its name, its type, its bytes — is inside the
 * ciphertext, so any file type works, and the key never leaves the note.
 *
 * This is the same trade the app already makes elsewhere: content hidden
 * inside an image, addressed by something small. Here the "something small" is
 * a URL and a key, which travel in the note that the stego image carries.
 *
 * WHAT IT DOES NOT HIDE. The host knows an image of a certain size was uploaded
 * by a given pubkey at a given time, and can see it is high-entropy noise
 * rather than a photograph. It cannot read the contents. Fetching it is
 * observable to the host, as with any URL.
 */

import * as Nostr from "./nostr-stub";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeRGBAtoPNG } from "./png-encode";
import { decodePngToRGBA } from "./png-decode";

/**
 * Servers confirmed to accept a PNG and return it byte-identical.
 * Tried in order; the first success wins.
 */
export const BLOSSOM_SERVERS = [
  "https://blossom.primal.net",
  "https://nostr.download",
  "https://blossom.band",
  "https://cdn.nostrcheck.me",
] as const;

const MAGIC = "STGBLOB1";
/** magic(8) + nameLen(2) + typeLen(2) + dataLen(4) */
const HEADER_BYTES = 16;

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

// ---------------------------------------------------------------- container --

/**
 * Pack a file into bytes: name and MIME travel WITH the data, inside what will
 * be encrypted, so the host learns neither.
 */
function pack(name: string, type: string, data: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const n = enc.encode(name);
  const t = enc.encode(type || "application/octet-stream");
  const out = new Uint8Array(HEADER_BYTES + n.length + t.length + data.length);
  const dv = new DataView(out.buffer);
  out.set(enc.encode(MAGIC), 0);
  dv.setUint16(8, n.length);
  dv.setUint16(10, t.length);
  dv.setUint32(12, data.length);
  out.set(n, HEADER_BYTES);
  out.set(t, HEADER_BYTES + n.length);
  out.set(data, HEADER_BYTES + n.length + t.length);
  return out;
}

function unpack(buf: Uint8Array): { name: string; type: string; data: Uint8Array } {
  const dec = new TextDecoder();
  if (buf.length < HEADER_BYTES || dec.decode(buf.slice(0, 8)) !== MAGIC) {
    throw new AttachmentError("This is not a Stegstr attachment, or the key is wrong.");
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nLen = dv.getUint16(8), tLen = dv.getUint16(10), dLen = dv.getUint32(12);
  let off = HEADER_BYTES;
  const name = dec.decode(buf.slice(off, off + nLen)); off += nLen;
  const type = dec.decode(buf.slice(off, off + tLen)); off += tLen;
  return { name, type, data: buf.slice(off, off + dLen) };
}

// ------------------------------------------------------------- png carrier --

/**
 * Carry bytes as PNG pixel data.
 *
 * Three bytes per pixel with alpha pinned to 255: a fully opaque image cannot
 * be altered by an alpha-premultiplying step, and these servers return the file
 * unchanged anyway. A 4-byte length prefix bounds the data, since the image
 * dimensions round up to a whole number of pixels.
 */
export function bytesToPng(bytes: Uint8Array): Uint8Array {
  const total = 4 + bytes.length;
  const pixels = Math.ceil(total / 3);
  const width = Math.min(2048, Math.max(1, Math.ceil(Math.sqrt(pixels))));
  const height = Math.ceil(pixels / width);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const src = new Uint8Array(total);
  new DataView(src.buffer).setUint32(0, bytes.length);
  src.set(bytes, 4);
  for (let i = 0, p = 0; i < src.length; i += 3, p += 4) {
    rgba[p] = src[i] ?? 0;
    rgba[p + 1] = src[i + 1] ?? 0;
    rgba[p + 2] = src[i + 2] ?? 0;
    rgba[p + 3] = 255;
  }
  for (let p = 3; p < rgba.length; p += 4) rgba[p] = 255;
  return encodeRGBAtoPNG(rgba, width, height);
}

export function pngToBytes(png: ArrayBuffer): Uint8Array {
  const { data } = decodePngToRGBA(png);
  const flat = new Uint8Array(Math.floor(data.length / 4) * 3);
  for (let p = 0, i = 0; p < data.length; p += 4, i += 3) {
    flat[i] = data[p];
    flat[i + 1] = data[p + 1];
    flat[i + 2] = data[p + 2];
  }
  const len = new DataView(flat.buffer, flat.byteOffset).getUint32(0);
  if (len > flat.length - 4) {
    throw new AttachmentError("Attachment is truncated or was re-encoded in transit.");
  }
  return flat.slice(4, 4 + len);
}

// ------------------------------------------------------------------ crypto --

async function aesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usage);
}

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));

// -------------------------------------------------------------------- auth --

/** BUD-11 authorization: a signed kind-24242 event, base64url without padding. */
async function blossomAuth(privKeyHex: string, verb: string, hash: string): Promise<string> {
  const ev = await Nostr.finishEventAsync(
    {
      kind: 24242,
      content: `Stegstr encrypted attachment (${verb})`,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", verb],
        ["x", hash],
        ["expiration", String(Math.floor(Date.now() / 1000) + 600)],
      ],
    },
    Nostr.hexToBytes(privKeyHex),
  );
  const bytes = new TextEncoder().encode(JSON.stringify(ev));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ------------------------------------------------------------------- public --

export interface UploadedAttachment {
  /** Where the carrier PNG lives. */
  url: string;
  /** Decryption key, hex. Travels in the note, never to the host. */
  key: string;
  name: string;
  type: string;
  /** Original file size, before encryption and PNG wrapping. */
  size: number;
  server: string;
}

/**
 * Encrypt a file, wrap it as a PNG, and upload it to the first server that
 * accepts it. Any file type works: the host only ever sees an image.
 */
export async function uploadEncrypted(
  file: File,
  privKeyHex: string,
  servers: readonly string[] = BLOSSOM_SERVERS,
): Promise<UploadedAttachment> {
  if (!privKeyHex) {
    throw new AttachmentError("Uploading needs an identity to sign the request. Log in first.");
  }

  const raw = new Uint8Array(await file.arrayBuffer());
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const packed = pack(file.name, file.type, raw);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      await aesKey(keyBytes, ["encrypt"]),
      packed,
    ),
  );

  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0);
  blob.set(ct, iv.length);
  const png = bytesToPng(blob);
  const hash = hex(sha256(png));

  const failures: string[] = [];
  for (const server of servers) {
    try {
      const res = await fetch(`${server}/upload`, {
        method: "PUT",
        headers: {
          Authorization: `Nostr ${await blossomAuth(privKeyHex, "upload", hash)}`,
          "Content-Type": "image/png",
        },
        body: png,
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text.slice(0, 90);
        try { msg = JSON.parse(text).message ?? msg; } catch { /* keep raw */ }
        failures.push(`${server}: ${res.status} ${msg}`);
        continue;
      }
      const url = (JSON.parse(text) as { url?: string }).url;
      if (!url) { failures.push(`${server}: no url in response`); continue; }
      return { url, key: hex(keyBytes), name: file.name, type: file.type, size: raw.length, server };
    } catch (e) {
      failures.push(`${server}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new AttachmentError(`No server accepted the attachment.\n${failures.join("\n")}`);
}

/** Fetch an encrypted attachment and return the original file. */
export async function fetchEncrypted(url: string, keyHex: string): Promise<File> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new AttachmentError(
      `Could not reach ${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new AttachmentError(
      res.status === 404
        ? "The attachment is no longer on that server. Blossom servers may drop blobs over time."
        : `Fetching the attachment failed: ${res.status} ${res.statusText}`,
    );
  }

  const blob = pngToBytes(await res.arrayBuffer());
  if (blob.length < 12 + 16) throw new AttachmentError("Attachment is too short to be valid.");
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.slice(0, 12), tagLength: 128 },
      await aesKey(unhex(keyHex), ["decrypt"]),
      blob.slice(12),
    );
  } catch {
    throw new AttachmentError("Wrong key, or the attachment was modified on the server.");
  }
  const { name, type, data } = unpack(new Uint8Array(plain));
  return new File([data], name, { type });
}

// ------------------------------------------------------------- note format --

/**
 * How an attachment is referenced in a note.
 *
 * A single token so it survives being copied around, and so a client without
 * Stegstr shows something inert rather than a working public link. The key is
 * after a `#`, which by convention is not sent to servers by browsers.
 */
const TOKEN = /stegstr\+blob:(\S+?)#([0-9a-f]{64})/gi;

export function attachmentToToken(a: UploadedAttachment): string {
  return `stegstr+blob:${a.url}#${a.key}`;
}

export function parseAttachmentTokens(content: string): Array<{ url: string; key: string }> {
  const out: Array<{ url: string; key: string }> = [];
  for (const m of content.matchAll(TOKEN)) out.push({ url: m[1], key: m[2].toLowerCase() });
  return out;
}

/** Content with attachment tokens replaced by a readable placeholder. */
export function stripAttachmentTokens(content: string): string {
  return content.replace(TOKEN, "[encrypted attachment]").trim();
}
