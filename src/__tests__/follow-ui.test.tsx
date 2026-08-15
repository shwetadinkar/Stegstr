// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { webcrypto } from "node:crypto";

/**
 * Unfollow, driven through the app the way the user found it broken.
 *
 * follow-defaults.test.ts pins the rule; this pins the handler, because the
 * bug was not in a rule at all -- it was `if (!kind3) return` sitting at the
 * top of handleUnfollow, and no test of a pure function would ever have
 * reached it. The button was wired, enabled, and did nothing.
 *
 * A fresh local identity follows the defaults with no kind-3 event to hold
 * them, which is exactly the state a new user is in.
 */

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

async function openFollowing() {
  const { default: AppBootstrap } = await import("../App");
  render(<AppBootstrap />);
  await screen.findByText(/Steganography/i, {}, { timeout: 10000 });
  // The shell renders a desktop and a mobile nav, so both match. Either opens
  // the same view; take the first.
  await waitFor(
    () => expect(screen.getAllByRole("button", { name: /^Following/i }).length).toBeGreaterThan(0),
    { timeout: 10000 },
  );
  fireEvent.click(screen.getAllByRole("button", { name: /^Following/i })[0]);
  return await screen.findByText(/From your Nostr contact list/i, {}, { timeout: 10000 });
}

const unfollowButtons = () => screen.queryAllByRole("button", { name: /^Unfollow$/i });

describe("Unfollow on a new local identity", () => {
  it("starts out showing the default follows", async () => {
    await openFollowing();
    // If this is empty the rest of the test proves nothing.
    expect(unfollowButtons().length).toBeGreaterThan(0);
  }, 60000);

  it("removes the account from the list when clicked", async () => {
    await openFollowing();
    const before = unfollowButtons().length;
    expect(before).toBeGreaterThan(1);

    fireEvent.click(unfollowButtons()[0]);

    // The reported bug: this count never changed, because the handler returned
    // before doing anything.
    await waitFor(() => expect(unfollowButtons().length).toBe(before - 1), { timeout: 10000 });
  }, 60000);

  it("keeps the other follows rather than clearing the list", async () => {
    await openFollowing();
    const before = unfollowButtons().length;
    fireEvent.click(unfollowButtons()[0]);
    await waitFor(() => expect(unfollowButtons().length).toBe(before - 1), { timeout: 10000 });

    // Materialising the defaults must not lose them. One goes, the rest stay.
    expect(unfollowButtons().length).toBe(before - 1);
    expect(unfollowButtons().length).toBeGreaterThan(0);
  }, 60000);

  it("unfollows a second account, so the change persisted as a real contact list", async () => {
    // The first unfollow writes a kind 3. If it did not, the second would be
    // operating on the defaults again and the count would go back up.
    await openFollowing();
    const before = unfollowButtons().length;

    fireEvent.click(unfollowButtons()[0]);
    await waitFor(() => expect(unfollowButtons().length).toBe(before - 1), { timeout: 10000 });
    fireEvent.click(unfollowButtons()[0]);
    await waitFor(() => expect(unfollowButtons().length).toBe(before - 2), { timeout: 10000 });
  }, 60000);

  it("reflects the removal in the sidebar count", async () => {
    await openFollowing();
    const before = unfollowButtons().length;
    const nav = screen.getAllByRole("button", { name: /^Following/i })[0];
    expect(within(nav).getByText(new RegExp(`\\(${before}\\)`))).toBeTruthy();

    fireEvent.click(unfollowButtons()[0]);
    await waitFor(
      () => expect(within(nav).getByText(new RegExp(`\\(${before - 1}\\)`))).toBeTruthy(),
      { timeout: 10000 },
    );
  }, 60000);
});
