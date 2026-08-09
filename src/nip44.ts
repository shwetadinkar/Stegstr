/**
 * nip44.ts — NIP-44 v2 encrypted payloads.
 *
 * Stegstr currently wraps per-recipient keys with NIP-04 (stego-crypto.ts).
 * NIP-04 is deprecated across the nostr ecosystem for good reasons: it uses
 * unauthenticated CBC so ciphertext can be tampered with undetected, and it
 * leaks plaintext length directly, which for short messages is close to leaking
 * the message. NIP-44 v2 fixes both -- HMAC-SHA256 over the nonce and
 * ciphertext gives authentication, and padding to power-of-two-ish buckets
 * means a 1-byte and a 32-byte message are indistinguishable on the wire.
 *
 * Implemented per the spec and verified against the official test vectors
 * (src/__tests__/fixtures/nip44.vectors.json): 35 conversation-key cases, 24
 * padding cases, 13 encrypt/decrypt cases including 64KB messages, plus the
 * invalid-payload cases that must be rejected.
 *
 * Primitives come from @noble (ciphers, hashes, secp256k1) rather than being
 * hand-rolled, per the project's own REVIEW.md guidance.
 *
 * Note this is deliberately NOT a full NIP-17 private DM implementation. NIP-44
 * is the cipher; NIP-17 adds gift-wrapping (NIP-59) to hide metadata. This
 * module is the layer stego-crypto.ts needs today.
 */

import * as secp from "@noble/secp256k1";
import { chacha20 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { extract as hkdfExtract, expand as hkdfExpand } from "@noble/hashes/hkdf.js";

const utf8 = new TextEncoder();
const utf8dec = new TextDecoder();

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error("invalid hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error("invalid hex");
    out[i] = b;
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Base64 without Buffer or atob/btoa: this module runs in the browser, under
// Tauri, and in tests, and should not assume which globals exist.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

function b64decode(str: string): Uint8Array {
  const clean = str.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0, bits = 0, n = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("invalid base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, n);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Constant-time: a length-dependent early return would leak how much of the
  // MAC matched, which is enough to forge one byte at a time.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Conversation key: HKDF-extract over the ECDH shared X coordinate.
 *
 * Only the x-coordinate is used, per the spec, and the result is symmetric --
 * both parties derive the same key from their own secret and the other's
 * public key.
 */
export function getConversationKey(privkeyHex: string, pubkeyHex: string): Uint8Array {
  // noble v3 wants bytes; the 02 prefix lifts the x-only nostr pubkey to a
  // compressed point (the y parity is irrelevant, only x is used downstream).
  const shared = secp.getSharedSecret(hexToBytes(privkeyHex), hexToBytes("02" + pubkeyHex));
  return hkdfExtract(sha256, shared.subarray(1, 33), utf8.encode("nip44-v2"));
}

/** Per-message keys, expanded from the conversation key and this message's nonce. */
export function getMessageKeys(conversationKey: Uint8Array, nonce: Uint8Array) {
  if (conversationKey.length !== 32) throw new Error("invalid conversation key length");
  if (nonce.length !== 32) throw new Error("invalid nonce length");
  const keys = hkdfExpand(sha256, conversationKey, nonce, 76);
  return {
    chacha_key: keys.subarray(0, 32),
    chacha_nonce: keys.subarray(32, 44),
    hmac_key: keys.subarray(44, 76),
  };
}

/**
 * Padded length for a plaintext.
 *
 * Everything under 32 bytes pads to 32; above that, lengths snap to one of
 * eight buckets per power of two. The point is that message length reveals
 * only a coarse bucket rather than the exact size.
 */
export function calcPaddedLen(len: number): number {
  if (!Number.isSafeInteger(len) || len < 1) throw new Error("expected positive integer");
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function pad(plaintext: string): Uint8Array {
  const unpadded = utf8.encode(plaintext);
  const len = unpadded.length;
  if (len < 1 || len > 65535) throw new Error("invalid plaintext length");
  const padded = new Uint8Array(2 + calcPaddedLen(len));
  new DataView(padded.buffer).setUint16(0, len, false);   // big-endian prefix
  padded.set(unpadded, 2);
  return padded;
}

function unpad(padded: Uint8Array): string {
  if (padded.length < 2) throw new Error("invalid padding");
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0, false);
  const text = padded.subarray(2, 2 + len);
  if (len < 1 || text.length !== len || padded.length !== 2 + calcPaddedLen(len)) {
    throw new Error("invalid padding");
  }
  return utf8dec.decode(text);
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(b);
  else throw new Error("no secure RNG available");
  return b;
}

/** Encrypt to a base64 payload: version || nonce || ciphertext || mac. */
export function encrypt(
  plaintext: string,
  conversationKey: Uint8Array,
  nonce: Uint8Array = randomBytes(32),
): string {
  const { chacha_key, chacha_nonce, hmac_key } = getMessageKeys(conversationKey, nonce);
  const ciphertext = chacha20(chacha_key, chacha_nonce, pad(plaintext));
  // MAC covers the nonce as associated data, so a nonce swap is detected.
  const mac = hmac(sha256, hmac_key, new Uint8Array([...nonce, ...ciphertext]));
  return b64encode(new Uint8Array([2, ...nonce, ...ciphertext, ...mac]));
}

/**
 * Decrypt, rejecting anything that fails authentication.
 *
 * Every failure path throws rather than returning a partial result: with an
 * unauthenticated scheme, returning "best effort" plaintext is how padding
 * oracles happen.
 */
export function decrypt(payload: string, conversationKey: Uint8Array): string {
  if (typeof payload !== "string" || payload.length < 132 || payload.length > 87472) {
    throw new Error("invalid payload length");
  }
  if (payload[0] === "#") throw new Error("unknown encryption version");

  let data: Uint8Array;
  try { data = b64decode(payload); } catch { throw new Error("invalid base64"); }
  if (data.length < 99 || data.length > 65603) throw new Error("invalid payload size");
  if (data[0] !== 2) throw new Error(`unknown encryption version ${data[0]}`);

  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);

  const { chacha_key, chacha_nonce, hmac_key } = getMessageKeys(conversationKey, nonce);
  const expected = hmac(sha256, hmac_key, new Uint8Array([...nonce, ...ciphertext]));
  if (!equalBytes(expected, mac)) throw new Error("invalid MAC");

  return unpad(chacha20(chacha_key, chacha_nonce, ciphertext));
}

/** Convenience wrappers matching the shape of the existing nip04 helpers. */
export function nip44Encrypt(plaintext: string, privkeyHex: string, pubkeyHex: string): string {
  return encrypt(plaintext, getConversationKey(privkeyHex, pubkeyHex));
}

export function nip44Decrypt(payload: string, privkeyHex: string, pubkeyHex: string): string {
  return decrypt(payload, getConversationKey(privkeyHex, pubkeyHex));
}
