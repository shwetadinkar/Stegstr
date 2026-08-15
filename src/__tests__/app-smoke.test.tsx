// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { webcrypto } from "node:crypto";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

/**
 * Does the app mount at all?
 *
 * Every test in this suite exercises a module. None of them render the app, so
 * a crash on first paint -- a bad import, a null deref in initial state, a
 * throw in a top-level hook -- passes CI and produces a window that never
 * shows anything. On desktop that is indistinguishable from a hang, which is
 * exactly the class of failure that has been hard to see: the process is
 * alive, so it looks fine from outside.
 */
describe("app smoke", () => {
  it("mounts and renders its main controls without throwing", async () => {
    const { default: AppBootstrap } = await import("../App");
    render(<AppBootstrap />);
    // Something from the shell, so this fails loudly if render produced nothing.
    expect(await screen.findByText(/Steganography/i, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: /detect image/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /embed image/i })).toBeTruthy();
  }, 30000);
});
