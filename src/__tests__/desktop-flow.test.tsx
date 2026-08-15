// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { installCanvasPolyfill, makeCoverJpeg } from "../node-canvas";

/**
 * The desktop path, driven end to end with the Tauri bridge mocked.
 *
 * This exists because the desktop build cannot be rendered in CI or in this
 * development environment -- WebKitGTK cannot initialise GL under WSLg, so the
 * window opens at the right size and paints nothing. Every desktop bug in this
 * project was therefore found by a person clicking, one at a time, after a
 * twenty-minute build: the Python shim that could never resolve, the missing
 * cover picker, and a detect path that merged images into the feed with no
 * review at all.
 *
 * Mocking the bridge covers everything above the IPC boundary, which is where
 * all three of those bugs lived. What it does not cover is the Rust side --
 * read_file_base64 and write_file_base64 -- which is a dozen lines of fs plus
 * base64 and is exercised by CI compiling it.
 *
 * isWeb() keys off window.__TAURI_INTERNALS__, so setting it makes the app take
 * the desktop branch exactly as it does in the packaged build.
 */

const invoke = vi.fn();
const saveDialog = vi.fn();
const openDialog = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openDialog(...a),
  save: (...a: unknown[]) => saveDialog(...a),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

installCanvasPolyfill();

/** Everything the desktop bridge is asked for, backed by an in-memory disk. */
const disk = new Map<string, Uint8Array>();
const toB64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) {
    s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 8192)));
  }
  return btoa(s);
};

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
  // Make isWeb() report desktop.
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

  invoke.mockImplementation(async (cmd: string, args: Record<string, string>) => {
    switch (cmd) {
      case "read_file_base64": {
        const bytes = disk.get(args.path);
        if (!bytes) throw new Error(`no such file: ${args.path}`);
        return toB64(bytes);
      }
      case "write_file_base64":
        disk.set(args.path, Uint8Array.from(atob(args.data), (c) => c.charCodeAt(0)));
        return null;
      case "get_desktop_path": return "/home/tester/Desktop";
      case "get_test_profile": return null;
      case "stegstr_log": return null;
      default: return null;
    }
  });
});

describe("desktop flow (Tauri bridge mocked)", () => {
  it("reports itself as the desktop build, not the browser", async () => {
    const { isWeb } = await import("../platform-web");
    expect(isWeb()).toBe(false);
  });

  it("reads a file through the Rust bridge and returns a usable File", async () => {
    const { fileFromPath } = await import("../platform-web");
    disk.set("/tmp/cover.jpg", makeCoverJpeg(320, 240, 3));
    const f = await fileFromPath("/tmp/cover.jpg");
    expect(f.name).toBe("cover.jpg");
    expect(f.type).toBe("image/jpeg");
    expect(f.size).toBe(disk.get("/tmp/cover.jpg")!.length);
  });

  it("saves through a native dialog and writes the real bytes", async () => {
    const { saveBlob } = await import("../platform-web");
    saveDialog.mockResolvedValueOnce("/home/tester/Desktop/out.jpg");
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" });
    const path = await saveBlob(blob, "out.jpg");
    expect(path).toBe("/home/tester/Desktop/out.jpg");
    // The bytes must actually reach disk -- a save dialog that returns a path
    // and writes nothing is the worst version of this bug.
    expect(Array.from(disk.get("/home/tester/Desktop/out.jpg")!)).toEqual([1, 2, 3, 4]);
  });

  it("returns null when the user cancels the save, rather than writing anywhere", async () => {
    const { saveBlob } = await import("../platform-web");
    saveDialog.mockResolvedValueOnce(null);
    const before = disk.size;
    expect(await saveBlob(new Blob([new Uint8Array([9])]), "x.jpg")).toBeNull();
    expect(disk.size).toBe(before);
  });

  it("appends the extension when the user omits it", async () => {
    const { saveBlob } = await import("../platform-web");
    saveDialog.mockResolvedValueOnce("/home/tester/Desktop/noext");
    const p = await saveBlob(new Blob([new Uint8Array([7])]), "thing.jpg");
    expect(p).toBe("/home/tester/Desktop/noext.jpg");
  });

  it("mounts the app in desktop mode with its controls present", async () => {
    const { default: AppBootstrap } = await import("../App");
    render(<AppBootstrap />);
    await waitFor(() => expect(screen.getByText(/Steganography/i)).toBeTruthy(), { timeout: 5000 });
    expect(screen.getByRole("button", { name: /detect image/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /embed image/i })).toBeTruthy();
  }, 30000);

  it("offers a cover picker in the embed dialog on desktop", async () => {
    // This is the control that was wrapped in isWeb() and therefore never
    // rendered in the packaged app, leaving no way to choose an image at all.
    const { default: AppBootstrap } = await import("../App");
    render(<AppBootstrap />);
    await waitFor(() => expect(screen.getByRole("button", { name: /embed image/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /embed image/i }));
    await waitFor(() => expect(screen.getByText(/Embed feed into image/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: /choose cover image/i })).toBeTruthy();
  }, 30000);
});

describe("desktop detect shows the review dialog", () => {
  /**
   * The bug this pins.
   *
   * The desktop build had its own detect implementation that never received
   * the review dialog. Opening any image merged its whole contents into the
   * feed unreviewed and switched the view to Global so they would be visible.
   * Anyone who could send a photo could write to your feed.
   *
   * There is now one implementation for both platforms, so this drives the
   * packaged app's actual path: a file on disk, read through the Rust bridge,
   * decoded, and offered for review rather than merged.
   */
  it("decodes a real stego image from disk and asks before merging", async () => {
    const { encodeQimImageFile, resizeCoverForPlatform } = await import("../stego-qim");
    const { encryptOpen } = await import("../stego-crypto");
    const Nostr = await import("../nostr-stub");

    // A real signed note in a real bundle, encrypted exactly as the app does.
    const sk = Nostr.generateSecretKey();
    const note = await Nostr.finishEventAsync(
      { kind: 1, content: "Desktop review dialog must appear", tags: [], created_at: 1700000000 },
      sk,
    );
    const payload = await encryptOpen(JSON.stringify({ version: 1, events: [note] }));

    const cover = new File([makeCoverJpeg(1200, 900, 11)], "c.jpg", { type: "image/jpeg" });
    const resized = await resizeCoverForPlatform(cover, 1600, false);
    const blob = await encodeQimImageFile(resized, payload, { platform: "universal" });
    disk.set("/tmp/received.jpg", new Uint8Array(await blob.arrayBuffer()));

    const { default: AppBootstrap } = await import("../App");
    render(<AppBootstrap />);
    await waitFor(() => expect(screen.getByRole("button", { name: /detect image/i })).toBeTruthy());

    // The native picker hands back a path, as it does in the packaged app.
    openDialog.mockResolvedValueOnce("/tmp/received.jpg");
    fireEvent.click(screen.getByRole("button", { name: /detect image/i }));

    // The dialog, not a silent merge.
    await waitFor(
      () => expect(screen.getByText(/Found in this image/i)).toBeTruthy(),
      { timeout: 120000 },
    );
    expect(screen.getByText(/Desktop review dialog must appear/)).toBeTruthy();
  }, 180000);
});
