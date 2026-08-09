import { describe, it, expect } from "vitest";
import * as secp from "@noble/secp256k1";
import vectors from "./fixtures/nip44.vectors.json";
import {
  getConversationKey, getMessageKeys, calcPaddedLen,
  encrypt, decrypt, bytesToHex, hexToBytes,
} from "../nip44";

/**
 * Driven entirely by the official NIP-44 vectors rather than by expectations I
 * wrote myself. A hand-written test for a cipher mostly proves the code agrees
 * with itself; these prove it agrees with every other NIP-44 implementation,
 * which is the only property that matters for interoperability.
 */

const v2 = (vectors as any).v2;

describe("NIP-44 conversation keys", () => {
  const cases = v2.valid.get_conversation_key as Array<{
    sec1: string; pub2: string; conversation_key: string;
  }>;

  it(`derives all ${cases.length} official conversation keys`, () => {
    for (const c of cases) {
      expect(bytesToHex(getConversationKey(c.sec1, c.pub2))).toBe(c.conversation_key);
    }
  });

  it("is symmetric: each party derives the same key from the other's pubkey", () => {
    const { sec1, sec2, conversation_key } = v2.valid.encrypt_decrypt[0];
    const pub1 = bytesToHex(secp.schnorr.getPublicKey(hexToBytes(sec1)));
    const pub2 = bytesToHex(secp.schnorr.getPublicKey(hexToBytes(sec2)));
    const fromAlice = bytesToHex(getConversationKey(sec1, pub2));
    const fromBob = bytesToHex(getConversationKey(sec2, pub1));
    expect(fromAlice).toBe(fromBob);
    expect(fromAlice).toBe(conversation_key);
  });

  it("rejects invalid inputs", () => {
    for (const c of v2.invalid.get_conversation_key as Array<{ sec1: string; pub2: string }>) {
      expect(() => getConversationKey(c.sec1, c.pub2)).toThrow();
    }
  });
});

describe("NIP-44 message keys", () => {
  it("expands per-message keys exactly as the spec vectors do", () => {
    const { conversation_key, keys } = v2.valid.get_message_keys;
    const ck = hexToBytes(conversation_key);
    for (const k of keys as Array<Record<string, string>>) {
      const got = getMessageKeys(ck, hexToBytes(k.nonce));
      expect(bytesToHex(got.chacha_key)).toBe(k.chacha_key);
      expect(bytesToHex(got.chacha_nonce)).toBe(k.chacha_nonce);
      expect(bytesToHex(got.hmac_key)).toBe(k.hmac_key);
    }
  });
});

describe("NIP-44 padding", () => {
  it("matches all official padded lengths", () => {
    for (const [len, padded] of v2.valid.calc_padded_len as Array<[number, number]>) {
      expect(calcPaddedLen(len)).toBe(padded);
    }
  });

  it("hides short message lengths in a common bucket", () => {
    // A 1-byte and a 32-byte message must be indistinguishable by size.
    expect(calcPaddedLen(1)).toBe(calcPaddedLen(32));
  });

  it("rejects nonsense lengths", () => {
    expect(() => calcPaddedLen(0)).toThrow();
    expect(() => calcPaddedLen(-1)).toThrow();
  });
});

describe("NIP-44 encrypt/decrypt", () => {
  const cases = v2.valid.encrypt_decrypt as Array<{
    sec1: string; sec2: string; conversation_key: string;
    nonce: string; plaintext: string; payload: string;
  }>;

  it(`reproduces all ${cases.length} official payloads byte for byte`, () => {
    for (const c of cases) {
      const ck = hexToBytes(c.conversation_key);
      expect(encrypt(c.plaintext, ck, hexToBytes(c.nonce))).toBe(c.payload);
    }
  });

  it("decrypts every official payload", () => {
    for (const c of cases) {
      expect(decrypt(c.payload, hexToBytes(c.conversation_key))).toBe(c.plaintext);
    }
  });

  it("handles long messages", () => {
    for (const c of v2.valid.encrypt_decrypt_long_msg as Array<any>) {
      const ck = hexToBytes(c.conversation_key);
      const plaintext = c.pattern.repeat(c.repeat);
      const out = encrypt(plaintext, ck, hexToBytes(c.nonce));
      expect(decrypt(out, ck)).toBe(plaintext);
    }
  });

  it("round-trips with a random nonce", () => {
    const ck = hexToBytes(v2.valid.encrypt_decrypt[0].conversation_key);
    for (const msg of ["a", "hello world", "🔐 unicode ✓", "x".repeat(5000)]) {
      expect(decrypt(encrypt(msg, ck), ck)).toBe(msg);
    }
  });
});

describe("NIP-44 rejects tampering", () => {
  const good = v2.valid.encrypt_decrypt[0];
  const ck = hexToBytes(good.conversation_key);

  it("rejects every official invalid payload", () => {
    for (const c of v2.invalid.decrypt as Array<{ conversation_key: string; payload: string }>) {
      expect(() => decrypt(c.payload, hexToBytes(c.conversation_key))).toThrow();
    }
  });

  it("rejects a flipped ciphertext bit", () => {
    const payload = encrypt("secret message", ck);
    const raw = Buffer.from(payload, "base64");
    raw[40] ^= 0x01;
    // NIP-04 used unauthenticated CBC and would have returned garbage here.
    expect(() => decrypt(raw.toString("base64"), ck)).toThrow(/MAC/);
  });

  it("rejects a swapped nonce", () => {
    const payload = encrypt("secret message", ck);
    const raw = Buffer.from(payload, "base64");
    raw[5] ^= 0xff;
    expect(() => decrypt(raw.toString("base64"), ck)).toThrow(/MAC/);
  });

  it("rejects the wrong conversation key", () => {
    const payload = encrypt("secret message", ck);
    const wrong = hexToBytes(v2.valid.get_conversation_key[1].conversation_key);
    expect(() => decrypt(payload, wrong)).toThrow();
  });

  it("rejects unsupported versions", () => {
    const payload = encrypt("x", ck);
    const raw = Buffer.from(payload, "base64");
    raw[0] = 3;
    expect(() => decrypt(raw.toString("base64"), ck)).toThrow(/version/);
  });

  it("rejects plaintext outside the allowed length range", () => {
    for (const [len, ok] of v2.invalid.encrypt_msg_lengths
      ? (v2.invalid.encrypt_msg_lengths as number[]).map((n) => [n, false] as const)
      : []) {
      if (!ok) expect(() => encrypt("x".repeat(len), ck)).toThrow();
    }
  });
});
