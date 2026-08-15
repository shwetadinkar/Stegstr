import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { webcrypto } from "node:crypto";

/**
 * Uploads had been failing for every file, silently.
 *
 * nostr.build requires NIP-98 auth and the app sent a bare POST, so every
 * attachment and every profile picture was rejected with "Unauthorized,
 * please provide a valid nip-98 token". Nothing surfaced it: the compose
 * handler filtered by MIME type first and reported "Select image or video
 * files", and both profile handlers were `catch (_) {}`, so a failed upload
 * was indistinguishable from not clicking at all.
 *
 * These tests pin the auth header and the error reporting, because a silent
 * failure is the part that made this hard to see rather than the auth itself.
 */

let key: string;

beforeAll(async () => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
  const Nostr = await import("../nostr-stub");
  key = Nostr.bytesToHex(Nostr.generateSecretKey());
});

afterEach(() => { vi.unstubAllGlobals(); });

const jpeg = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo.jpg", { type: "image/jpeg" });

describe("media upload", () => {
  it("sends a signed NIP-98 token naming the exact URL and method", async () => {
    const { uploadMedia } = await import("../upload");
    let auth = "";
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ data: [{ url: "https://image.nostr.build/abc.jpg" }] }));
    });

    const url = await uploadMedia(jpeg(), key);
    expect(url).toBe("https://image.nostr.build/abc.jpg");

    expect(auth.startsWith("Nostr ")).toBe(true);
    const ev = JSON.parse(atob(auth.slice(6)));
    expect(ev.kind).toBe(27235);
    expect(ev.tags).toContainEqual(["u", "https://nostr.build/api/v2/upload/files"]);
    expect(ev.tags).toContainEqual(["method", "POST"]);
    expect(ev.sig).toMatch(/^[0-9a-f]{128}$/);

    // The signature must actually verify -- an unverifiable token is the same
    // as no token, and the server would reject it exactly as before.
    const { verifyEvent } = await import("../sync-engine");
    expect(verifyEvent(ev)).toBe(true);
  });

  it("reports the server's refusal instead of returning nothing", async () => {
    const { uploadMedia } = await import("../upload");
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ message: "Unauthorized, please provide a valid nip-98 token" })));
    await expect(uploadMedia(jpeg(), key)).rejects.toThrow(/nip-98/i);
  });

  it("refuses a document with a reason, since the host rejects them", async () => {
    // Verified against the live endpoint: a PDF and a text file both come back
    // "Server error". Better to say so than to send it and relay a confusing
    // message from the host.
    const { uploadMedia } = await import("../upload");
    const doc = new File([new Uint8Array([1])], "notes.pdf", { type: "application/pdf" });
    await expect(uploadMedia(doc, key)).rejects.toThrow(/images and video|not an image/i);
  });

  it("refuses to upload without an identity to sign with", async () => {
    const { uploadMedia } = await import("../upload");
    await expect(uploadMedia(jpeg(), "")).rejects.toThrow(/identity/i);
  });

  it("falls back to the extension when the browser reports no MIME type", async () => {
    // Some systems hand back an empty type. The previous code dropped those
    // files silently.
    const { isUploadableMedia } = await import("../upload");
    expect(isUploadableMedia(new File([new Uint8Array([1])], "clip.mp4", { type: "" }))).toBe(true);
    expect(isUploadableMedia(new File([new Uint8Array([1])], "shot.PNG", { type: "" }))).toBe(true);
    expect(isUploadableMedia(new File([new Uint8Array([1])], "report.pdf", { type: "" }))).toBe(false);
  });

  it("explains a network failure rather than surfacing a bare TypeError", async () => {
    const { uploadMedia } = await import("../upload");
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    await expect(uploadMedia(jpeg(), key)).rejects.toThrow(/could not reach nostr\.build/i);
  });
});
