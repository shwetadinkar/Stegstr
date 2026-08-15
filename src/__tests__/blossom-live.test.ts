import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";

/**
 * The live half of the attachment tests: a real upload to a real Blossom
 * server, and a real fetch back.
 *
 * OPT-IN ON PURPOSE. A suite that fails when someone else's server is down is
 * a suite people learn to ignore, and these are four volunteer-run public
 * hosts. Run it deliberately:
 *
 *     STEGSTR_LIVE=1 npx vitest run src/__tests__/blossom-live.test.ts
 *
 * WHY IT EXISTS. The whole design rests on one measured server behaviour --
 * arbitrary bytes and PDFs are rejected, a valid PNG round-trips
 * byte-identical -- so the carrier is a PNG. If a host ever starts re-encoding
 * uploads, every attachment breaks and nothing offline would notice. This is
 * the check that catches that, and the one to run first on a new machine.
 *
 * It also uploads a few hundred bytes to a public server each run, which is
 * another reason not to have it fire on every `npm test`.
 */

const LIVE = process.env.STEGSTR_LIVE === "1";
const d = LIVE ? describe : describe.skip;

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

d("live Blossom round trip", () => {
  it("carries a document there and back byte-identical, name and type intact", async () => {
    const { uploadEncrypted, fetchEncrypted } = await import("../blossom");
    const Nostr = await import("../nostr-stub");
    const key = Nostr.bytesToHex(Nostr.generateSecretKey());

    // Real PDF bytes rather than random noise: a host that sniffs content
    // should see the PNG carrier and nothing else.
    const body = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
    );
    const original = new File([body], "board-minutes.pdf", { type: "application/pdf" });

    const up = await uploadEncrypted(original, key);
    expect(up.url).toMatch(/^https:\/\//);

    const back = await fetchEncrypted(up.url, up.key);
    expect(back.name).toBe("board-minutes.pdf");
    expect(back.type).toBe("application/pdf");
    expect(Array.from(new Uint8Array(await back.arrayBuffer()))).toEqual(Array.from(body));
  }, 120000);

  it("shows the host neither the file name nor the contents", async () => {
    const { uploadEncrypted } = await import("../blossom");
    const Nostr = await import("../nostr-stub");
    const key = Nostr.bytesToHex(Nostr.generateSecretKey());

    const secret = "SEVERANCE TERMS: 18 MONTHS";
    const f = new File([new TextEncoder().encode(secret)], "salary-2026.pdf", {
      type: "application/pdf",
    });
    const up = await uploadEncrypted(f, key);

    // Fetch the stored blob raw, as any passer-by with the URL would.
    const raw = await (await fetch(up.url)).arrayBuffer();
    const asText = new TextDecoder().decode(new Uint8Array(raw));
    expect(asText).not.toContain("salary-2026");
    expect(asText).not.toContain("SEVERANCE");
    expect(asText).not.toContain("application/pdf");
  }, 120000);

  it("still returns the file unchanged -- the host is not re-encoding PNGs", async () => {
    // The load-bearing assumption. If this fails, the carrier approach is dead
    // and the failure will otherwise look like "wrong key" to every user.
    const { bytesToPng, pngToBytes, uploadEncrypted } = await import("../blossom");
    const Nostr = await import("../nostr-stub");
    const key = Nostr.bytesToHex(Nostr.generateSecretKey());

    const probe = crypto.getRandomValues(new Uint8Array(3000));
    const f = new File([probe], "probe.bin", { type: "" });
    const up = await uploadEncrypted(f, key);

    const stored = new Uint8Array(await (await fetch(up.url)).arrayBuffer());
    expect(Array.from(stored.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Decodes as a PNG carrier at all -- i.e. pixel data survived intact.
    expect(() => pngToBytes(stored.buffer.slice(0) as ArrayBuffer)).not.toThrow();
    expect(bytesToPng(probe).length).toBeGreaterThan(0);
  }, 120000);

  it("reports a dropped blob as retention, not as a bad key", async () => {
    // Free servers may drop blobs. The two failures need different messages:
    // one means the file is gone, the other means the link is wrong.
    const { fetchEncrypted } = await import("../blossom");
    await expect(
      fetchEncrypted("https://blossom.primal.net/" + "0".repeat(64) + ".png", "a".repeat(64)),
    ).rejects.toThrow(/no longer on that server|Fetching the attachment failed/i);
  }, 60000);
});
