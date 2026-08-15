import { useMemo, useState } from "react";
import type { NostrEvent } from "./net-pool";

/**
 * DetectResultModal — shows what was actually inside a decoded image.
 *
 * The app previously merged decoded events straight into the feed and reported
 * only "Loaded N events from image." The notes were then sorted by created_at
 * among everything the user already had, so anything not recent was effectively
 * invisible. For an app whose whole purpose is extracting hidden messages, not
 * showing the extracted messages is the wrong default.
 *
 * It is also a security boundary. An image arrives from WhatsApp or a group
 * chat -- anyone can send one. Merging on open means anyone who sends you a
 * picture can write to your feed. Here, content from people you do not follow
 * is held until you decide, per author, and the signature status of every event
 * is shown rather than assumed.
 */

export interface DetectedEvent extends NostrEvent {
  /** Signature verified against the claimed pubkey. */
  verified: boolean;
  /** Author is in the user's follow list. */
  followed: boolean;
  /** Already present locally before this image was opened. */
  duplicate: boolean;
}

interface Props {
  events: DetectedEvent[];
  /** Display name lookup; falls back to a shortened pubkey. */
  nameFor?: (pubkey: string) => string | undefined;
  onAccept: (ids: string[]) => void;
  onClose: () => void;
  /** Bytes recovered, for the summary line. */
  payloadBytes?: number;
  imageName?: string;
}

const short = (pk: string) => `${pk.slice(0, 8)}…${pk.slice(-4)}`;

function whenText(ts: number): string {
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function kindLabel(kind: number): string | null {
  if (kind === 0) return "profile";
  if (kind === 3) return "contacts";
  if (kind === 10002) return "relay list";
  if (kind === 4) return "message";
  if (kind === 5) return "deletion";
  if (kind === 6) return "repost";
  if (kind === 7) return "reaction";
  return kind === 1 ? null : `kind ${kind}`;
}

export default function DetectResultModal({
  events, nameFor, onAccept, onClose, payloadBytes, imageName,
}: Props) {
  const groups = useMemo(() => {
    const m = new Map<string, DetectedEvent[]>();
    for (const e of events) {
      const list = m.get(e.pubkey) ?? [];
      list.push(e);
      m.set(e.pubkey, list);
    }
    return [...m.entries()]
      .map(([pubkey, evs]) => ({
        pubkey,
        events: evs.sort((a, b) => b.created_at - a.created_at),
        followed: evs.some((e) => e.followed),
        anyNew: evs.some((e) => !e.duplicate && e.verified),
      }))
      // Followed authors first, then those with new content.
      .sort((a, b) =>
        Number(b.followed) - Number(a.followed) ||
        Number(b.anyNew) - Number(a.anyNew));
  }, [events]);

  // Followed authors are pre-selected; strangers are not. Opening an image
  // should not silently import a stranger's feed.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const e of events) if (e.verified && !e.duplicate && e.followed) s.add(e.id);
    return s;
  });

  const eligible = events.filter((e) => e.verified && !e.duplicate);
  const invalid = events.filter((e) => !e.verified);
  const dupes = events.filter((e) => e.duplicate && e.verified);

  const toggleAuthor = (pubkey: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const e of eligible) {
        if (e.pubkey !== pubkey) continue;
        if (on) next.add(e.id); else next.delete(e.id);
      }
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(eligible.map((e) => e.id)));
  const selectNone = () => setSelected(new Set());

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>Found in this image</h3>

        {/* Lead with what the image HELD, not with how much of it was new.
            "0 new items" was the first line on a perfectly good decode of your
            own feed, and reads as "found nothing" when it means "found
            everything, and you already have it". */}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "-0.5rem" }}>
          {eligible.length + dupes.length === 0
            ? "Nothing readable"
            : `Read ${eligible.length + dupes.length} item${eligible.length + dupes.length === 1 ? "" : "s"}`}
          {` · ${eligible.length} new`}
          {dupes.length > 0 && ` · ${dupes.length} already had`}
          {invalid.length > 0 && ` · ${invalid.length} failed signature check`}
          {payloadBytes ? ` · ${(payloadBytes / 1024).toFixed(1)} KB recovered` : ""}
          {imageName ? ` · ${imageName}` : ""}
        </p>

        {invalid.length > 0 && (
          <p
            className="muted"
            style={{ fontSize: "0.8rem", color: "#b23", marginTop: "0.25rem" }}
          >
            {invalid.length} {invalid.length === 1 ? "event" : "events"} could not be
            verified against the claimed author and {invalid.length === 1 ? "is" : "are"} not
            offered here.
          </p>
        )}

        {/* What the image held, by kind.
            A bare "5 already had" gives the reader no way to judge whether
            that number is reasonable. It usually is: an image carries the
            notes AND the profiles of the people you follow, because a
            recipient who gets your notes without your profile cannot identify
            or reach you. But the feed only displays notes, so "5 events" next
            to one visible message reads as a bug until the breakdown is
            shown. */}
        {events.length > 0 && (
          <p className="muted" style={{ fontSize: "0.8rem", margin: "0.25rem 0 0" }}>
            Contained: {[...events.reduce((m, e) => {
              const k = kindLabel(e.kind) ?? "note";
              return m.set(k, (m.get(k) ?? 0) + 1);
            }, new Map<string, number>())]
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`)
              .join(", ")}
          </p>
        )}

        {eligible.length === 0 ? (
          <p className="muted" style={{ margin: "1rem 0" }}>
            Nothing new to add — you already have everything this image contained.
          </p>
        ) : (
          <>
            <div style={{ display: "flex", gap: "0.5rem", margin: "0.5rem 0" }}>
              <button type="button" className="btn-small" onClick={selectAll}>
                Select all
              </button>
              <button type="button" className="btn-small" onClick={selectNone}>
                Select none
              </button>
            </div>

            <div style={{ maxHeight: 340, overflowY: "auto" }}>
              {groups.map((g) => {
                const items = g.events.filter((e) => e.verified && !e.duplicate);
                if (items.length === 0) return null;
                const allOn = items.every((e) => selected.has(e.id));
                const name = nameFor?.(g.pubkey) ?? short(g.pubkey);
                return (
                  <div
                    key={g.pubkey}
                    style={{
                      borderTop: "1px solid #eee",
                      padding: "0.6rem 0",
                    }}
                  >
                    <label
                      style={{
                        display: "flex", alignItems: "center", gap: "0.5rem",
                        fontWeight: 600, fontSize: "0.9rem", cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={allOn}
                        onChange={(e) => toggleAuthor(g.pubkey, e.target.checked)}
                      />
                      <span>{name}</span>
                      {g.followed ? (
                        <span className="muted" style={{ fontWeight: 400, fontSize: "0.75rem" }}>
                          following
                        </span>
                      ) : (
                        <span
                          style={{
                            fontWeight: 400, fontSize: "0.75rem",
                            color: "#a60", background: "#fff6e5",
                            padding: "0.05rem 0.35rem", borderRadius: 3,
                          }}
                        >
                          not following
                        </span>
                      )}
                      <span className="muted" style={{ fontWeight: 400, fontSize: "0.75rem" }}>
                        {items.length} {items.length === 1 ? "item" : "items"}
                      </span>
                    </label>

                    {items.slice(0, 6).map((e) => {
                      const label = kindLabel(e.kind);
                      return (
                        <label
                          key={e.id}
                          style={{
                            display: "flex", gap: "0.5rem", alignItems: "flex-start",
                            padding: "0.2rem 0 0.2rem 1.5rem", fontSize: "0.82rem",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(e.id)}
                            onChange={() => toggleOne(e.id)}
                            style={{ marginTop: "0.2rem" }}
                          />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            {label && (
                              <span className="muted" style={{ marginRight: "0.3rem" }}>
                                [{label}]
                              </span>
                            )}
                            <span
                              style={{
                                overflow: "hidden", textOverflow: "ellipsis",
                                display: "-webkit-box", WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical",
                              }}
                            >
                              {e.content?.trim() || <em className="muted">(no text)</em>}
                            </span>
                            <span className="muted" style={{ fontSize: "0.72rem" }}>
                              {whenText(e.created_at)}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                    {items.length > 6 && (
                      <p
                        className="muted"
                        style={{ fontSize: "0.75rem", paddingLeft: "1.5rem", margin: "0.2rem 0 0" }}
                      >
                        and {items.length - 6} more from this author
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="modal-actions" style={{ marginTop: "1rem" }}>
          <button type="button" onClick={onClose}>
            {eligible.length === 0 ? "Close" : "Discard all"}
          </button>
          {/* With nothing eligible there is nothing the button could do, and
              offering it anyway invites a click that silently does nothing --
              which reads as the app being broken rather than as "no new
              content". "Close" alone is the honest single choice. */}
          {eligible.length > 0 && (
            <button
              type="button"
              className="btn-primary"
              disabled={selected.size === 0}
              onClick={() => onAccept([...selected])}
            >
              Add {selected.size > 0 ? selected.size : ""} to my feed
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
