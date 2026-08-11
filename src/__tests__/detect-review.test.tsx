import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DetectResultModal, { type DetectedEvent } from "../DetectResultModal";

const ev = (over: Partial<DetectedEvent> = {}): DetectedEvent => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  pubkey: over.pubkey ?? "a".repeat(64),
  created_at: over.created_at ?? Math.floor(Date.now() / 1000) - 3600,
  kind: over.kind ?? 1,
  tags: [],
  content: over.content ?? "hello world",
  sig: "0".repeat(128),
  verified: over.verified ?? true,
  followed: over.followed ?? false,
  duplicate: over.duplicate ?? false,
});

describe("DetectResultModal", () => {
  it("shows what the image contained instead of a bare count", () => {
    render(
      <DetectResultModal
        events={[ev({ content: "a secret note" })]}
        onAccept={() => {}}
        onClose={() => {}}
      />,
    );
    // The old behaviour reported only "Loaded N events" and hid the content
    // in the feed. The content itself must be visible.
    expect(screen.getByText(/a secret note/)).toBeInTheDocument();
  });

  it("does not pre-select content from people the user does not follow", () => {
    const onAccept = vi.fn();
    render(
      <DetectResultModal
        events={[ev({ followed: false, content: "from a stranger" })]}
        onAccept={onAccept}
        onClose={() => {}}
      />,
    );
    // Anyone can send a JPEG; opening one must not import their feed.
    const add = screen.getByRole("button", { name: /Add/ });
    expect(add).toBeDisabled();
    expect(screen.getByText(/not following/)).toBeInTheDocument();
  });

  it("pre-selects content from followed authors", () => {
    render(
      <DetectResultModal
        events={[ev({ followed: true, content: "from a friend" })]}
        onAccept={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Add 1/ })).toBeEnabled();
  });

  it("withholds events that failed signature verification", () => {
    render(
      <DetectResultModal
        events={[ev({ verified: false, content: "forged content" })]}
        onAccept={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/forged content/)).not.toBeInTheDocument();
    expect(screen.getByText(/failed signature check/)).toBeInTheDocument();
  });

  it("reports duplicates rather than offering them again", () => {
    render(
      <DetectResultModal
        events={[ev({ duplicate: true, followed: true })]}
        onAccept={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Nothing new to add/)).toBeInTheDocument();
  });

  it("returns only the ids the user selected", () => {
    const onAccept = vi.fn();
    const a = ev({ id: "keep", followed: true, content: "wanted" });
    const b = ev({ id: "drop", followed: true, content: "unwanted", pubkey: "b".repeat(64) });
    render(<DetectResultModal events={[a, b]} onAccept={onAccept} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Select none/ }));
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[boxes.length - 1]);
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept.mock.calls[0][0]).toHaveLength(1);
  });

  it("select all then discard passes nothing on", () => {
    const onAccept = vi.fn();
    const onClose = vi.fn();
    render(
      <DetectResultModal
        events={[ev({ followed: true }), ev({ followed: false })]}
        onAccept={onAccept}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Discard all/ }));
    expect(onClose).toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
  });
});
