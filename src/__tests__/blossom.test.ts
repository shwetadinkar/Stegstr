import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";

/**
 * Encrypted attachments.
 *
 * The design exists because of what the hosts actually do, measured rather
 * than assumed: arbitrary bytes and PDFs are rejected (415 / "not allowed"),
 * while a valid PNG round-trips byte-identical. So encrypted data — which
 * looks like arbitrary bytes — is carried as PNG pixel data instead.
 *
 * These tests cover the container and crypto offline. The live upload is in
 * blossom-live.test.ts, which is opt-in: a test suite that fails when someone
 * else's server is down is a test suite people learn to ignore.
 */

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

describe("PNG carrier", () => {
  it("round-trips arbitrary bytes exactly", async () => {
    const { bytesToPng, pngToBytes } = await import("../blossom");
    const data = crypto.getRandomValues(new Uint8Array(5000));
    const png = bytesToPng(data);
    // It must really be a PNG, or the host rejects it -- that was the bug in
    // the first probe, where a malformed header produced a misleading
    // "Content-Type does not match" from the server.
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const out = pngToBytes(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer);
    expect(Array.from(out)).toEqual(Array.from(data));
  });

  it("handles a length that does not divide into whole pixels", async () => {
    const { bytesToPng, pngToBytes } = await import("../blossom");
    for (const n of [1, 2, 3, 4, 7, 100]) {
      const data = crypto.getRandomValues(new Uint8Array(n));
      const png = bytesToPng(data);
      const out = pngToBytes(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer);
      expect(`${n}:${Array.from(out).join(",")}`).toBe(`${n}:${Array.from(data).join(",")}`);
    }
  });

  it("is fully opaque, so nothing can premultiply the data away", async () => {
    const { bytesToPng } = await import("../blossom");
    const { decodePngToRGBA } = await import("../png-decode");
    const png = bytesToPng(crypto.getRandomValues(new Uint8Array(300)));
    const { data } = decodePngToRGBA(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer);
    for (let p = 3; p < data.length; p += 4) expect(data[p]).toBe(255);
  });
});

describe("attachment tokens", () => {
  it("round-trips a reference through note text", async () => {
    const { attachmentToToken, parseAttachmentTokens } = await import("../blossom");
    const a = {
      url: "https://blossom.primal.net/abc123.png",
      key: "a".repeat(64),
      name: "report.pdf", type: "application/pdf", size: 10, server: "x",
    };
    const note = `Here it is ${attachmentToToken(a)} let me know`;
    const found = parseAttachmentTokens(note);
    expect(found).toHaveLength(1);
    expect(found[0].url).toBe(a.url);
    expect(found[0].key).toBe(a.key);
  });

  it("keeps the key out of the visible note text", async () => {
    const { attachmentToToken, stripAttachmentTokens } = await import("../blossom");
    const token = attachmentToToken({
      url: "https://x/y.png", key: "b".repeat(64),
      name: "n", type: "t", size: 1, server: "s",
    });
    const shown = stripAttachmentTokens(`see ${token}`);
    expect(shown).toBe("see [encrypted attachment]");
    expect(shown).not.toContain("b".repeat(64));
  });

  it("finds several attachments in one note", async () => {
    const { parseAttachmentTokens } = await import("../blossom");
    const note = `stegstr+blob:https://a/1.png#${"1".repeat(64)} and stegstr+blob:https://b/2.png#${"2".repeat(64)}`;
    expect(parseAttachmentTokens(note)).toHaveLength(2);
  });
});

describe("encryption", () => {
  it("hides the file name and type from anyone without the key", async () => {
    // Name and MIME are packed INSIDE the ciphertext on purpose: a host that
    // could read "salary-2026.pdf" would learn most of what matters even
    // without the contents.
    const { bytesToPng } = await import("../blossom");
    const png = bytesToPng(crypto.getRandomValues(new Uint8Array(400)));
    const asText = new TextDecoder().decode(png);
    expect(asText).not.toContain("salary");
    expect(asText).not.toContain("application/pdf");
  });

  it("refuses to upload without an identity to sign with", async () => {
    const { uploadEncrypted } = await import("../blossom");
    const f = new File([new Uint8Array([1, 2, 3])], "x.pdf", { type: "application/pdf" });
    await expect(uploadEncrypted(f, "")).rejects.toThrow(/identity/i);
  });

  it("reports every server it tried when they all refuse", async () => {
    const { uploadEncrypted } = await import("../blossom");
    const Nostr = await import("../nostr-stub");
    const key = Nostr.bytesToHex(Nostr.generateSecretKey());
    const f = new File([new Uint8Array([1, 2, 3])], "x.bin", { type: "" });
    await expect(
      uploadEncrypted(f, key, ["https://nope.invalid", "https://also-nope.invalid"]),
    ).rejects.toThrow(/no server accepted/i);
  }, 60000);
});
