// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmbedModal, type EmbedModalProps } from "../EmbedModal";

/**
 * "Pick specific notes" driven through the actual control.
 *
 * embed-candidates.test.ts pins the rule; this pins the wiring, because the
 * rule being right does not help if the radio stays disabled or the checkbox
 * does not report what the user ticked. The bug as reported was purely
 * visible: a disabled radio saying "you have not written any notes yet".
 */

const note = (over: Partial<EmbedModalProps["selectableNotes"][0]> = {}) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  content: over.content ?? "a note",
  created_at: over.created_at ?? 1700000000,
  mine: over.mine ?? true,
});

function renderModal(over: Partial<EmbedModalProps> = {}) {
  const onSelectedNoteIdsChange = vi.fn();
  const props: EmbedModalProps = {
    onClose: () => {},
    onConfirm: () => {},
    embedding: false,
    stegoProgress: "",
    embedCoverFile: null,
    onCoverFileChange: () => {},
    recipientMode: "open",
    onRecipientModeChange: () => {},
    recipientInput: "",
    onRecipientInputChange: () => {},
    recipients: [],
    onRecipientsChange: () => {},
    profiles: {},
    stegoMethod: "qim",
    onStegoMethodChange: () => {},
    targetPlatform: "universal",
    onTargetPlatformChange: () => {},
    pointerMode: false,
    onPointerModeChange: () => {},
    slotOrder: "profile",
    onSlotOrderChange: () => {},
    selectableNotes: [],
    selectedNoteIds: null,
    onSelectedNoteIdsChange,
    ...over,
  };
  render(<EmbedModal {...props} />);
  return { onSelectedNoteIdsChange };
}

const pickRadio = () => screen.getByRole("radio", { name: /Pick specific notes/i });

describe("the reported bug, at the control", () => {
  it("enables the radio when only a followed author's notes are available", () => {
    // The exact case that looked broken: nothing of your own, a feed full of
    // notes that automatic mode would have carried.
    renderModal({ selectableNotes: [note({ mine: false, content: "friend's note" })] });
    expect(pickRadio()).toBeEnabled();
  });

  it("no longer claims you have written nothing when that is not the reason", () => {
    renderModal({ selectableNotes: [] });
    expect(screen.queryByText(/have not written any notes yet/i)).toBeNull();
    expect(screen.getByText(/post a note, or follow someone/i)).toBeInTheDocument();
  });

  it("still disables the radio, with a reason, when there is genuinely nothing", () => {
    renderModal({ selectableNotes: [] });
    expect(pickRadio()).toBeDisabled();
  });
});

describe("choosing notes", () => {
  it("switches to explicit selection when the radio is clicked", () => {
    const { onSelectedNoteIdsChange } = renderModal({ selectableNotes: [note()] });
    fireEvent.click(pickRadio());
    // An empty array, not null: null means "carry my feed automatically".
    expect(onSelectedNoteIdsChange).toHaveBeenCalledWith([]);
  });

  it("reports the note the user ticked", () => {
    const n = note({ id: "n1", content: "carry just this" });
    const { onSelectedNoteIdsChange } = renderModal({
      selectableNotes: [n],
      selectedNoteIds: [],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /carry just this/i }));
    expect(onSelectedNoteIdsChange).toHaveBeenCalledWith(["n1"]);
  });

  it("unticks a note that was selected", () => {
    const n = note({ id: "n1", content: "already chosen" });
    const { onSelectedNoteIdsChange } = renderModal({
      selectableNotes: [n],
      selectedNoteIds: ["n1"],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /already chosen/i }));
    expect(onSelectedNoteIdsChange).toHaveBeenCalledWith([]);
  });

  it("selects and clears all", () => {
    const notes = [note({ id: "a" }), note({ id: "b" })];
    const { onSelectedNoteIdsChange } = renderModal({
      selectableNotes: notes,
      selectedNoteIds: [],
    });
    fireEvent.click(screen.getByRole("button", { name: /Select all/i }));
    expect(onSelectedNoteIdsChange).toHaveBeenCalledWith(["a", "b"]);
    fireEvent.click(screen.getByRole("button", { name: /Select none/i }));
    expect(onSelectedNoteIdsChange).toHaveBeenCalledWith([]);
  });
});

describe("whose note is it", () => {
  it("marks a followed author's note, so you know before you send it", () => {
    renderModal({
      selectableNotes: [note({ mine: false, content: "someone else wrote this" })],
      selectedNoteIds: [],
    });
    expect(screen.getByText("theirs")).toBeInTheDocument();
  });

  it("does not mark your own", () => {
    renderModal({
      selectableNotes: [note({ mine: true, content: "I wrote this" })],
      selectedNoteIds: [],
    });
    expect(screen.queryByText("theirs")).toBeNull();
  });
});
