// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FeedView } from "../FeedView";

/**
 * Attaching a file appeared to do nothing.
 *
 * The handler was correct and every branch reported what happened -- through
 * setStatus, which renders inside the Steganography aside next to the embed
 * and detect controls. Attaching happens in the compose box at the top of the
 * main column. So "Network is off, attaching needs it" and "no server accepted
 * the file" were both written to a panel on the other side of the screen,
 * while the user watched the Attach button do nothing at all.
 *
 * A dead button and an invisible error are the same thing from the outside.
 * These tests pin the message to the control that caused it.
 */

const noop = () => {};

function renderCompose(over: Record<string, unknown> = {}) {
  const props = {
    myPicture: null, myName: "me",
    newPost: "", setNewPost: noop,
    postAttachments: [], setPostAttachments: noop,
    uploadingMedia: false,
    attachError: null,
    onDismissAttachError: noop,
    postMediaInputRef: { current: null },
    handlePostMediaUpload: noop,
    handlePost: noop,
    feedFilter: "global", setFeedFilter: noop,
    hideSensitive: true, setHideSensitive: noop,
    notesEmpty: true, feedItems: [],
    searchTrim: "", searchLower: "", searchNoSpaces: "",
    searchPubkeyHex: null, npubStr: null,
    networkEnabled: false, profiles: {}, pubkey: null,
    focusedNoteId: null, notes: [],
    getRepliesTo: () => [],
    noteCardState: {}, noteCardActions: {},
    replyingTo: null, replyContent: "", onReplyContentChange: noop,
    handleReply: noop, handleReplyCancel: noop,
    loadingMore: false, loadMoreSentinelRef: { current: null },
    setViewingProfilePubkey: noop, setView: noop,
    ...over,
  } as unknown as React.ComponentProps<typeof FeedView>;
  return render(<FeedView {...props} />);
}

describe("attach failures are visible where the user clicked", () => {
  it("shows the reason next to the Attach button", () => {
    renderCompose({
      attachError:
        "Attaching uploads the file to a Blossom server, so it needs the network — and Network is off.",
    });
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toMatch(/Network is off/i);
  });

  it("shows nothing when there is nothing wrong", () => {
    renderCompose();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports an upload refusal, which names the servers that declined", () => {
    renderCompose({
      attachError: "No server accepted the attachment.\nhttps://blossom.primal.net: 413 too large",
    });
    expect(screen.getByRole("alert").textContent).toMatch(/413 too large/);
  });

  it("can be dismissed", () => {
    const onDismissAttachError = vi.fn();
    renderCompose({ attachError: "something went wrong", onDismissAttachError });
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismissAttachError).toHaveBeenCalled();
  });

  it("still shows the button as busy while uploading", () => {
    // The only feedback that already worked. Keep it.
    renderCompose({ uploadingMedia: true });
    expect(screen.getByRole("button", { name: /Encrypting/i })).toBeInTheDocument();
  });
});
