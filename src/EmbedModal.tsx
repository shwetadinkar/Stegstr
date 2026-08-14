import { useState, useEffect } from "react";
import * as Nostr from "./nostr-stub";
import { isWeb, pickImageFile } from "./platform-web";
import { getQimCapacityForFile } from "./stego-qim";
import { PLATFORM_PROFILES, profileFor, USER_PLATFORMS } from "./stego-adaptive";
import { getDotCapacityForFile } from "./stego-dot-web";
import type { ProfileData } from "./types";

export type StegoMethod = "qim" | "dot";

/**
 * A one-line explanation that opens on demand.
 *
 * The modal had grown five paragraphs of prose, which pushed the Embed button
 * off the bottom of the dialog -- so the text meant to help was in the way of
 * the action it was explaining. Collapsed by default: the summary says what
 * the note is about, and anyone who wants the reasoning can ask for it.
 */
function Note({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="embed-note">
      <summary>{label}</summary>
      <div className="embed-note-body">{children}</div>
    </details>
  );
}

// Labels state the geometry actually used. The previous values were wrong in
// two places that mattered: Instagram was labelled 1080px (Instagram upscales
// that to its 1440 canvas, destroying the payload) and WhatsApp HD 4096px
// (downscaled to 1600, same result).
const PLATFORM_LABELS: Record<string, string> = {
  whatsapp_standard: "WhatsApp (1600px, HD included)",
  whatsapp_hd: "WhatsApp HD (1600px)",
  telegram_photo: "Telegram, as photo (1280px — Telegram resizes to this)",
  telegram_photo_1600: "Telegram test - old 1600px (resampled by Telegram)",
  telegram_file: "Telegram, as file (no resize, biggest capacity)",
  instagram: "Instagram (1440 square)",
  facebook: "Facebook (2048px)",
  twitter: "Twitter/X (1600px)",
  imessage: "iMessage (1280px)",
  universal: "Universal (1600px — WhatsApp, Twitter, Facebook)",
  instagram_d40: "Instagram test - step 40",
  instagram_d44: "Instagram test - step 44",
  instagram_d48: "Instagram test - step 48",
  instagram_d52: "Instagram test - step 52",
  instagram_d56: "Instagram test - step 56",
  instagram_d72: "Instagram test - step 72",
  instagram_chroma_d28: "Instagram test - chroma step 28",
  instagram_chroma_d40: "Instagram test - chroma step 40",
  instagram_chroma_d56: "Instagram test - chroma step 56",
  instagram_zz6_d20: "Instagram test - zigzag1-6 step 20",
  instagram_zz6_d28: "Instagram test - zigzag1-6 step 28",
  instagram_zz6_d40: "Instagram test - zigzag1-6 step 40",
  instagram_zz6_d56: "Instagram test - zigzag1-6 step 56",
  none: "No resize (original size)",
};

export interface EmbedModalProps {
  onClose: () => void;
  onConfirm: () => void;
  embedding: boolean;
  stegoProgress: string;
  embedCoverFile: File | null;
  onCoverFileChange: (file: File | null) => void;
  recipientMode: "open" | "recipients";
  onRecipientModeChange: (mode: "open" | "recipients") => void;
  recipientInput: string;
  onRecipientInputChange: (value: string) => void;
  recipients: string[];
  onRecipientsChange: (recipients: string[]) => void;
  profiles: Record<string, ProfileData>;
  stegoMethod: StegoMethod;
  onStegoMethodChange: (method: StegoMethod) => void;
  targetPlatform: string;
  onTargetPlatformChange: (platform: string) => void;
  pointerMode: boolean;
  onPointerModeChange: (on: boolean) => void;
  slotOrder: "profile" | "ac-major" | "spread";
  onSlotOrderChange: (order: "profile" | "ac-major" | "spread") => void;
  /** The user's own recent notes, newest first, offered for explicit selection. */
  selectableNotes: { id: string; content: string; created_at: number }[];
  /** null = carry the whole feed by priority; a list = carry exactly these. */
  selectedNoteIds: string[] | null;
  onSelectedNoteIdsChange: (ids: string[] | null) => void;
}

export function EmbedModal({
  onClose,
  onConfirm,
  embedding,
  stegoProgress,
  embedCoverFile,
  onCoverFileChange,
  recipientMode,
  onRecipientModeChange,
  recipientInput,
  onRecipientInputChange,
  recipients,
  onRecipientsChange,
  profiles,
  stegoMethod,
  onStegoMethodChange,
  targetPlatform,
  onTargetPlatformChange,
  pointerMode,
  onPointerModeChange,
  slotOrder,
  onSlotOrderChange,
  selectableNotes,
  selectedNoteIds,
  onSelectedNoteIdsChange,
}: EmbedModalProps) {
  const [capacityInfo, setCapacityInfo] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Bracket/experiment profiles are hidden by default -- there are 13 of them
  // against 9 real targets, which buried the platforms anyone actually wants.
  // The currently selected one always stays listed, so a selection made with
  // the toggle on does not silently vanish when it is turned off.
  const [showTestProfiles, setShowTestProfiles] = useState(false);
  const platformKeys = [
    ...USER_PLATFORMS.filter((k) => k in PLATFORM_PROFILES),
    ...Object.keys(PLATFORM_PROFILES).filter(
      (k) => !USER_PLATFORMS.includes(k) && (showTestProfiles || k === targetPlatform),
    ),
  ];

  useEffect(() => {
    if (!embedCoverFile) {
      setCapacityInfo("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (stegoMethod === "qim") {
          const info = await getQimCapacityForFile(embedCoverFile, targetPlatform);
          if (!cancelled) {
            setCapacityInfo(
              `Capacity: ~${Math.floor(info.capacityBytes / 1024)} KB (${info.width}x${info.height} JPEG)`,
            );
          }
        } else {
          const bytes = await getDotCapacityForFile(embedCoverFile);
          if (!cancelled) {
            setCapacityInfo(`Capacity: ~${Math.floor(bytes / 1024)} KB (PNG)`);
          }
        }
      } catch {
        if (!cancelled) setCapacityInfo("Could not compute capacity");
      }
    })();
    return () => { cancelled = true; };
  }, [embedCoverFile, stegoMethod, targetPlatform]);

  const addRecipient = () => {
    const raw = recipientInput.trim();
    if (!raw) return;
    let pk = raw;
    if (raw.startsWith("npub")) {
      try {
        const d = Nostr.nip19.decode(raw);
        if (d.type === "npub") pk = Nostr.bytesToHex(d.data);
      } catch { return; }
    }
    if (/^[a-fA-F0-9]{64}$/.test(pk) && !recipients.includes(pk)) {
      onRecipientsChange([...recipients, pk]);
      onRecipientInputChange("");
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal embed-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Embed feed into image</h3>
        <p className="muted">Data is encrypted so only Stegstr users can read it. DMs are encrypted for the recipient only.</p>

        {/* What makes a good cover. Stated at the point of choosing, because
            by the time an embed fails on a flat image the user has already
            spent the time -- and the property that matters (fine detail) is
            not one people would guess at. */}
        <p className="muted" style={{ fontSize: "0.82rem", margin: "0.5rem 0", lineHeight: 1.45 }}>
          <strong>Pick a detailed photo</strong> — foliage, fabric, crowds, brickwork.
        </p>
        <Note label="What makes a good cover photo?">
          Detail hides the data, and the same texture is what lets it survive a
          platform's re-compression. Avoid large smooth areas — sky, plain walls,
          screenshots and logos give it nowhere to hide.
        </Note>

        {/* Cover image picker */}
        {isWeb() && (
          <div className="embed-cover-web" style={{ margin: "0.75rem 0" }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={async () => {
                const file = await pickImageFile();
                if (file) onCoverFileChange(file);
              }}
            >
              {embedCoverFile ? embedCoverFile.name : "Choose cover image"}
            </button>
          </div>
        )}

        {/* Capacity info. In pointer mode the cover's capacity stops being the
            constraint -- the payload is a fixed ~200 bytes and the feed lives
            on a relay -- so quoting a KB figure here would answer a question
            that no longer applies. */}
        {capacityInfo && (
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            {pointerMode && stegoMethod === "qim"
              ? `${capacityInfo} — not the limit in pointer mode; a ~200-byte pointer carries your whole feed.`
              : capacityInfo}
          </p>
        )}

        {/* What to carry.
            "Back up my whole feed" and "send this one message to this one
            person" are different jobs, and only the first was possible before:
            selection was automatic, by usefulness per byte. That is the right
            default and the wrong only option. */}
        <div className="embed-what" style={{ margin: "0.75rem 0" }}>
          <label style={{ marginRight: "1rem", cursor: "pointer" }}>
            <input
              type="radio"
              name="embed-what"
              checked={selectedNoteIds === null}
              onChange={() => onSelectedNoteIdsChange(null)}
            />
            {" "}My feed (chosen automatically)
          </label>
          <label style={{ cursor: "pointer" }}>
            <input
              type="radio"
              name="embed-what"
              checked={selectedNoteIds !== null}
              onChange={() => onSelectedNoteIdsChange([])}
              disabled={selectableNotes.length === 0}
            />
            {" "}Pick specific notes
          </label>
          {/* A disabled radio with no reason next to it just looks broken.
              Say why it is unavailable. */}
          {selectableNotes.length === 0 && (
            <span className="muted" style={{ fontSize: "0.78rem", marginLeft: "0.4rem" }}>
              — you have not written any notes yet
            </span>
          )}

          {selectedNoteIds !== null && (
            <div style={{ marginTop: "0.5rem" }}>
              {selectableNotes.length === 0 ? (
                <p className="muted" style={{ fontSize: "0.82rem" }}>
                  You have no notes to choose from yet.
                </p>
              ) : (
                <>
                  <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.35rem" }}>
                    <button
                      type="button"
                      className="btn-small"
                      onClick={() => onSelectedNoteIdsChange(selectableNotes.map((n) => n.id))}
                    >
                      Select all
                    </button>
                    <button type="button" className="btn-small" onClick={() => onSelectedNoteIdsChange([])}>
                      Select none
                    </button>
                    <span className="muted" style={{ fontSize: "0.78rem", alignSelf: "center" }}>
                      {selectedNoteIds.length} selected
                    </span>
                  </div>
                  <div className="embed-note-picker">
                    {selectableNotes.map((n) => {
                      const on = selectedNoteIds.includes(n.id);
                      return (
                        <label key={n.id} className="embed-note-pick">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() =>
                              onSelectedNoteIdsChange(
                                on
                                  ? selectedNoteIds.filter((x) => x !== n.id)
                                  : [...selectedNoteIds, n.id],
                              )
                            }
                          />
                          <span>{n.content.replace(/\s+/g, " ").slice(0, 90) || "(no text)"}</span>
                        </label>
                      );
                    })}
                  </div>
                  {selectedNoteIds.length === 0 && (
                    <p className="muted" style={{ fontSize: "0.78rem", margin: "0.3rem 0 0" }}>
                      Nothing selected — pick at least one note.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Recipient mode */}
        <div className="embed-recipient-mode" style={{ margin: "0.75rem 0" }}>
          <label style={{ marginRight: "1rem" }}>
            <input type="radio" name="embed-mode" checked={recipientMode === "open"} onChange={() => onRecipientModeChange("open")} />
            {" "}Open (any Stegstr user)
          </label>
          <label>
            <input type="radio" name="embed-mode" checked={recipientMode === "recipients"} onChange={() => onRecipientModeChange("recipients")} />
            {" "}Recipients only
          </label>
        </div>
        {recipientMode === "recipients" && (
          <div className="embed-recipients" style={{ marginBottom: "0.75rem" }}>
            <div className="row" style={{ gap: "0.5rem", marginBottom: "0.25rem" }}>
              <input
                type="text"
                value={recipientInput}
                onChange={(e) => onRecipientInputChange(e.target.value)}
                placeholder="npub or hex pubkey"
                className="wide"
                style={{ flex: 1 }}
              />
              <button type="button" className="btn-secondary" onClick={addRecipient}>
                Add
              </button>
            </div>
            {recipients.length > 0 && (
              <ul style={{ listStyle: "none", padding: 0, margin: "0.25rem 0" }}>
                {recipients.map((pk) => (
                  <li key={pk} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
                    <span>{profiles[pk]?.name ?? `${pk.slice(0, 12)}…`}</span>
                    <button type="button" className="btn-delete muted" style={{ fontSize: "0.75rem" }} onClick={() => onRecipientsChange(recipients.filter((p) => p !== pk))}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
            {recipients.length === 0 && <p className="muted" style={{ fontSize: "0.85rem" }}>Add at least one recipient pubkey.</p>}
          </div>
        )}

        {/* Pointer tier. Surfaced here rather than under Advanced because it
            changes what the image fundamentally IS -- self-contained forever
            versus a reference that needs the network -- and that is not a
            detail to bury. QIM only: the pointer path is wired through the
            JPEG encoder, and Dot is legacy. */}
        {stegoMethod === "qim" && (
          <div className="embed-pointer-mode" style={{ margin: "0.75rem 0" }}>
            <label style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={pointerMode}
                onChange={(e) => onPointerModeChange(e.target.checked)}
              />
              {" "}Send a link instead of the content
            </label>
            <Note label={pointerMode ? "What sending a link means" : "What embedding everything means"}>
              {pointerMode
                ? "The image carries a ~200-byte pointer and your feed goes to a relay, encrypted. " +
                  "Far less visible, carries your whole feed regardless of cover size, and survives " +
                  "channels that would destroy a full payload. The recipient must be online to read " +
                  "it, and their relay request is visible to anyone watching their traffic."
                : "The image carries everything, so it works offline forever and leaks nothing. " +
                  "How much of your feed fits depends on the cover, and a large payload is more " +
                  "visible in the image."}
            </Note>
          </div>
        )}

        {/* Advanced options toggle */}
        <button
          type="button"
          className="btn-link muted"
          style={{ fontSize: "0.85rem", padding: 0, border: "none", background: "none", cursor: "pointer", textDecoration: "underline" }}
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? "Hide advanced options" : "Advanced options"}
        </button>

        {showAdvanced && (
          <div className="embed-advanced" style={{ margin: "0.5rem 0", padding: "0.5rem", border: "1px solid #ddd", borderRadius: "4px" }}>
            {/* Stego method selector */}
            <div className="embed-method-selector">
              <label className="embed-section-label">Encoding method:</label>
              <div style={{ display: "flex", gap: "1rem" }}>
                <label style={{ cursor: "pointer" }}>
                  <input type="radio" name="stego-method" checked={stegoMethod === "qim"} onChange={() => onStegoMethodChange("qim")} />
                  {" "}QIM (JPEG, robust)
                </label>
                <label style={{ cursor: "pointer" }}>
                  <input type="radio" name="stego-method" checked={stegoMethod === "dot"} onChange={() => onStegoMethodChange("dot")} />
                  {" "}Dot (PNG, legacy)
                </label>
              </div>
            </div>

            {/* Slot ordering (§17.4) -- an A/B control, not a setting anyone
                should need. Present so the same cover and payload can be shot
                both ways through a real platform and judged by eye, because CI
                cannot answer which looks better. Decode is unaffected: the
                blind sweep tries both orderings regardless, so an image made
                either way still reads. */}
            {stegoMethod === "qim" && (
              <div className="embed-slot-order" style={{ marginTop: "0.5rem" }}>
                <label className="embed-section-label">Slot ordering (comparison):</label>
                <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                  {([
                    ["profile", "Profile default"],
                    ["ac-major", "AC-major (fills top-down)"],
                    ["spread", "Spread (scattered)"],
                  ] as const).map(([value, label]) => (
                    <label key={value} style={{ cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="slot-order"
                        checked={slotOrder === value}
                        onChange={() => onSlotOrderChange(value)}
                      />
                      {" "}{label}
                    </label>
                  ))}
                </div>
                <Note label="What slot ordering does">
                  AC-major writes one frequency from the top down, so a small payload
                  forms a band across the upper part of the frame. Spread scatters the
                  same bits over every frequency and the whole image. The filename
                  records which was used.
                </Note>
              </div>
            )}

            {/* Platform selector (QIM only) */}
            {stegoMethod === "qim" && (
              <div className="embed-platform-selector" style={{ marginTop: "0.5rem" }}>
                <label className="embed-section-label">Target platform:</label>
                <select
                  value={targetPlatform}
                  onChange={(e) => onTargetPlatformChange(e.target.value)}
                >
                  {platformKeys.map((key) => (
                    <option key={key} value={key}>{PLATFORM_LABELS[key] ?? key}</option>
                  ))}
                </select>
                <label style={{ display: "block", marginTop: "0.4rem", fontSize: "0.8rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={showTestProfiles}
                    onChange={(e) => setShowTestProfiles(e.target.checked)}
                  />
                  {" "}Show experimental test profiles (for bracket testing)
                </label>
                <Note label="About this platform target">
                  {(() => {
                    const prof = profileFor(targetPlatform);
                    const size = prof.width === 0
                      ? "no resize"
                      : prof.square
                        ? prof.width + " x " + prof.width + " square"
                        : prof.width + "px wide";
                    return "Pre-resizes to " + size + ". " + prof.note;
                  })()}
                  {" "}Sizes are measured from real platform round-trips. Choosing a size
                  the platform will resize destroys the hidden data.
                </Note>
              </div>
            )}
          </div>
        )}

        {/* Progress indicator */}
        {embedding && (
          <div className="stego-progress" style={{ marginTop: "1rem" }}>
            <p className="muted detect-status">{stegoProgress || "Processing..."}</p>
            <div className="progress-bar"><div className="progress-bar-indeterminate"></div></div>
          </div>
        )}
        <div className="row modal-actions">
          <button type="button" onClick={onClose} disabled={embedding}>Cancel</button>
          <button type="button" onClick={onConfirm} className="btn-primary" disabled={embedding || (isWeb() && !embedCoverFile)}>
            {embedding ? "Embedding..." : "Embed"}
          </button>
        </div>
      </div>
    </div>
  );
}
