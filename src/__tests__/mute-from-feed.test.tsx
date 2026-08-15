// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NoteCard, type NoteCardActions, type NoteCardState } from "../NoteCard";
import type { NostrEvent } from "../types";

/**
 * Muting an account from the feed.
 *
 * The mute list, its feed filter and its unmute UI in Settings all existed
 * already. The only way to ADD to it was to paste a pubkey into Settings by
 * hand, so an account filling the Global feed with the same note over and over
 * looked like something the user could do nothing about -- Delete renders only
 * on your own notes, and correctly so, because nostr cannot withdraw someone
 * else's note from the network.
 *
 * These pin the distinction the UI must not blur: Delete is your note leaving
 * the network; Mute is their note leaving your screen.
 */

const ME = "a".repeat(64);
const THEM = "b".repeat(64);

const ev = (pubkey: string): NostrEvent => ({
  id: "n1", pubkey, created_at: 1700000000, kind: 1,
  tags: [], content: "buy my thing", sig: "0".repeat(128),
});

const state = (): NoteCardState => ({
  profiles: {},
  selfPubkeys: [ME],
  hasLiked: () => false,
  hasBookmarked: () => false,
  getLikeCount: () => 0,
  getZapCount: () => 0,
});

function renderNote(pubkey: string, actions: NoteCardActions) {
  return render(
    <NoteCard event={ev(pubkey)} state={state()} actions={actions} showActions />,
  );
}

describe("Mute is offered where the note is", () => {
  it("appears on someone else's note", () => {
    renderNote(THEM, { onMuteAuthor: vi.fn(), onDelete: vi.fn() });
    expect(screen.getByRole("button", { name: /^Mute$/i })).toBeInTheDocument();
  });

  it("calls back with the note whose author to mute", () => {
    const onMuteAuthor = vi.fn();
    renderNote(THEM, { onMuteAuthor });
    fireEvent.click(screen.getByRole("button", { name: /^Mute$/i }));
    expect(onMuteAuthor).toHaveBeenCalledTimes(1);
    expect(onMuteAuthor.mock.calls[0][0].pubkey).toBe(THEM);
  });

  it("says plainly that nothing is published", () => {
    // The user is about to act on someone else's content. If they think this
    // is visible to the author, or to a relay, they will not use it.
    renderNote(THEM, { onMuteAuthor: vi.fn() });
    const btn = screen.getByRole("button", { name: /^Mute$/i });
    expect(btn.getAttribute("title")).toMatch(/nothing is published/i);
  });
});

describe("Mute and Delete are kept apart", () => {
  it("does not offer Mute on your own note", () => {
    // Muting yourself would look exactly like the app losing your posts.
    renderNote(ME, { onMuteAuthor: vi.fn(), onDelete: vi.fn() });
    expect(screen.queryByRole("button", { name: /^Mute$/i })).toBeNull();
  });

  it("does not offer Delete on someone else's note", () => {
    // nostr has no way to withdraw another person's note; a Delete button here
    // would be a lie about what the app can do.
    renderNote(THEM, { onMuteAuthor: vi.fn(), onDelete: vi.fn() });
    expect(screen.queryByRole("button", { name: /^Delete$/i })).toBeNull();
  });

  it("still offers Delete on your own note", () => {
    renderNote(ME, { onDelete: vi.fn() });
    expect(screen.getByRole("button", { name: /^Delete$/i })).toBeInTheDocument();
  });
});
