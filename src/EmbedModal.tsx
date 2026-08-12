import { useState, useEffect } from "react";
import * as Nostr from "./nostr-stub";
import { isWeb, pickImageFile } from "./platform-web";
import { getQimCapacityForFile } from "./stego-qim";
import { PLATFORM_PROFILES, profileFor, USER_PLATFORMS } from "./stego-adaptive";
import { getDotCapacityForFile } from "./stego-dot-web";
import type { ProfileData } from "./types";

export type StegoMethod = "qim" | "dot";

// Labels state the geometry actually used. The previous values were wrong in
// two places that mattered: Instagram was labelled 1080px (Instagram upscales
// that to its 1440 canvas, destroying the payload) and WhatsApp HD 4096px
// (downscaled to 1600, same result).
const PLATFORM_LABELS: Record<string, string> = {
  whatsapp_standard: "WhatsApp (1600px)",
  whatsapp_hd: "WhatsApp HD (1600px)",
  telegram_photo: "Telegram (1600px)",
  instagram: "Instagram (1440 square)",
  facebook: "Facebook (2048px)",
  twitter: "Twitter/X (1600px)",
  imessage: "iMessage (1280px)",
  universal: "Universal (1440 square, safe everywhere)",
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

        {/* Capacity info */}
        {capacityInfo && (
          <p className="muted" style={{ fontSize: "0.85rem" }}>{capacityInfo}</p>
        )}

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
                <p className="muted" style={{ fontSize: "0.8rem", marginTop: "0.25rem" }}>
                  {(() => {
                    const prof = profileFor(targetPlatform);
                    const size = prof.width === 0
                      ? "no resize"
                      : prof.square
                        ? prof.width + " x " + prof.width + " square"
                        : prof.width + "px wide";
                    return "Pre-resizes to " + size + ". " + prof.note;
                  })()}
                </p>
                <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.2rem" }}>
                  Sizes are measured from real platform round-trips. Choosing a size
                  the platform will resize destroys the hidden data.
                </p>
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
