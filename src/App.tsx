import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import * as Nostr from "./nostr-stub";
import { isWeb, decodeStegoFile, encodeStegoToBlob, saveBlob, fileFromPath, openImageFile } from "./platform-web";
import { getDotCapacityForFile } from "./stego-dot-web";
import { getTauri } from "./platform-desktop";
import { connectRelays, publishEvent, DEFAULT_RELAYS, getRelayUrls, fetchEventById, publishAndConfirm } from "./net-adapter";
import { buildPointer, parsePointer, resolvePointer } from "./pointer";
import { profileFor } from "./stego-adaptive";
import DetectResultModal, { type DetectedEvent } from "./DetectResultModal";
import { verifyEvent, packForCapacity } from "./sync-engine";
import { uint8ArrayToBase64, isLocallyHidden, takeFilesFromInput } from "./utils";
import {
  getDefaultFollowPubkeys,
  usingDefaultFollows,
  currentContactPubkeys,
  contactListTags,
} from "./follow-list";
import {
  decodeQimImageFile,
  encodeQimImageFile,
  resizeCoverForPlatform,
  qimSelfTest,
  getQimCapacityForFile,
} from "./stego-qim";
import { uploadEncrypted, attachmentToToken, type UploadedAttachment } from "./blossom";
import {
  embedCandidates as eligibleToCarry,
  selectableNotes,
  profilesToCarry,
  type CandidateContext,
} from "./embed-candidates";
import { ensureStegstrSuffix } from "./constants";
import * as stegoCrypto from "./stego-crypto";
import * as logger from "./logger";
import { useToast, ToastContainer } from "./Toast";
import type { NoteCardActions, NoteCardState } from "./NoteCard";
import { NotificationsView } from "./NotificationsView";
import { BookmarksView } from "./BookmarksView";
import { ExploreView } from "./ExploreView";
import { SettingsView } from "./SettingsView";
import { IdentityView } from "./IdentityView";
import { FollowingView } from "./FollowingView";
import { MessagesView } from "./MessagesView";
import { ProfileView } from "./ProfileView";
import { FeedView } from "./FeedView";
import type { FeedItem } from "./FeedView";
import { EmbedModal } from "./EmbedModal";
import type { StegoMethod } from "./EmbedModal";
import { EditProfileModal } from "./EditProfileModal";
import { LoginModal } from "./LoginModal";
import { NewMessageModal } from "./NewMessageModal";
import type { NostrEvent, NostrStateBundle, IdentityEntry, View, ProfileData } from "./types";
import "./App.css";

const STEGSTR_BUNDLE_VERSION = 1;

/**
 * Self-applied hashtags that reliably mark adult content on nostr. Structured
 * and author-set, so far fewer false positives than scanning prose.
 */
const SENSITIVE_HASHTAGS = new Set([
  "nsfw", "porn", "porno", "pornography", "xxx", "adult", "nude", "nudes",
  "nudity", "sex", "sexy", "onlyfans", "hentai", "erotica", "erotic", "boobs",
  "milf", "anal", "blowjob", "camgirl", "escort", "fetish",
]);

/**
 * Last-resort literal matches. Kept blunt and short on purpose: every entry
 * here also hides someone discussing the subject rather than posting it, so
 * the list is limited to terms that are near-unambiguous in a feed context.
 */
const SENSITIVE_WORDS = [
  "#nsfw", "#porn", "#xxx", "#hentai", "onlyfans.com", "pornhub.com",
];

/**
 * If a decrypted payload turns out to be a pointer rather than a bundle,
 * follow it and return what it names; otherwise return the payload unchanged.
 *
 * Both detect paths run this, so a pointer image and a self-contained image
 * converge on the same classification and review flow -- the difference is a
 * transport detail, and the user should not have to know which kind of image
 * they were handed.
 *
 * Errors from here are deliberately distinct from decode errors: the image was
 * read perfectly. Reporting "not a Stegstr image" when the truth is "the relay
 * has not got it yet" would send the user to re-shoot the photo, which cannot
 * possibly help.
 */
async function followPointerIfAny(
  jsonString: string,
  ourPrivKeyHex: string,
  log: (message: string) => void,
  networkEnabled: boolean,
  enableNetwork: () => void,
): Promise<string> {
  const pointer = parsePointer(jsonString);
  if (!pointer) return jsonString;
  // Turn the network on rather than refusing.
  //
  // Opening the image IS the intent to read it, and refusing left the user
  // with a dead end: flip a switch, find the image again, open it again. So
  // this now matches attaching and pointer-mode embedding, both of which
  // enable the network at the moment the user asks for something that needs
  // it.
  //
  // What must NOT be lost is the disclosure. This request names the exact
  // event id, so it tells relays which hidden payload someone just opened, in
  // an app whose premise is that nobody can tell. It used to ignore the toggle
  // entirely while the banner promised "nothing is sent" (§17.8) -- the fix
  // for that was to make the consequence visible, not to make the feature
  // unreachable. It is logged every time, and stays visible in the stego log.
  if (!networkEnabled) {
    enableNetwork();
    log(
      "Network turned on automatically: this image holds a link to content on a relay. " +
      "Fetching it tells the relay which image you are reading.",
    );
  }
  log(
    `Pointer payload: event ${pointer.i.slice(0, 12)}..., ` +
    `${pointer.r?.length ?? 0} relay hint(s), ${pointer.k ? "keyed" : "recipients-only"}`,
  );
  const ownRelays = await getRelayUrls();
  const resolved = await resolvePointer(pointer, fetchEventById, ourPrivKeyHex, ownRelays);
  log(`Pointer resolved: fetched ${resolved.length}B of content from a relay`);
  return resolved;
}
// Appended to a note whose content had to be cut to fit a cover image, so the
// reader can tell a shortened note from a complete one.
const TRUNCATE_MARKER = " […cut to fit image]";
// Shortest note worth carrying, and the granularity the truncation search
// converges to. Below this a "note" is barely more than the marker.
const TRUNCATE_MIN_CHARS = 120;
const BASE_ANON_KEY = "stegstr_anon_key";
const BASE_IDENTITIES = "stegstr_identities";
const BASE_ACTING = "stegstr_acting_identity";
const BASE_VIEWING = "stegstr_viewing_identities";
const BASE_MUTE_PUBKEYS = "stegstr_mute_pubkeys";
const BASE_IMPORTED_IDS = "stegstr_imported_event_ids";
const BASE_MUTE_WORDS = "stegstr_mute_words";
const BASE_RELAYS = "stegstr_relays";
const BASE_ZAP_QUEUE = "stegstr_zap_queue";
const BASE_DM_READ = "stegstr_dm_read_timestamps";
const BASE_NOTIF_READ = "stegstr_notification_read_at";

function getStorageProfileSync(): string | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search).get("profile");
  if (p) return p;
  try {
    return localStorage.getItem("stegstr_test_profile");
  } catch { return null; }
}
function getStorageKey(base: string, profile: string | null | undefined): string {
  const prefix = profile ? `stegstr_test_${profile}_` : "";
  return prefix + base;
}

function getOrCreateAnonKey(profile?: string | null): string {
  const key = getStorageKey(BASE_ANON_KEY, profile);
  try {
    const stored = localStorage.getItem(key);
    if (stored && /^[a-fA-F0-9]{64}$/.test(stored)) return stored;
  } catch (_) {}
  const sk = Nostr.generateSecretKey();
  const hex = Nostr.bytesToHex(sk);
  try {
    localStorage.setItem(getStorageKey(BASE_ANON_KEY, profile), hex);
  } catch (_) {}
  return hex;
}

type QueuedZap = {
  id: string;
  noteId: string;
  event: NostrEvent;
  createdAt: number;
  zapStreamUrl: string;
};

function loadQueuedZaps(profile: string | null): QueuedZap[] {
  try {
    const raw = localStorage.getItem(getStorageKey(BASE_ZAP_QUEUE, profile));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is QueuedZap => {
      if (typeof x !== "object" || x === null) return false;
      const z = x as QueuedZap;
      return (
        typeof z.id === "string" &&
        typeof z.noteId === "string" &&
        typeof z.zapStreamUrl === "string" &&
        typeof z.createdAt === "number" &&
        typeof z.event === "object" &&
        z.event !== null &&
        typeof (z.event as NostrEvent).id === "string"
      );
    });
  } catch (_) {
    return [];
  }
}

function loadIdentities(profile: string | null): IdentityEntry[] {
  try {
    const raw = localStorage.getItem(getStorageKey(BASE_IDENTITIES, profile));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x): x is IdentityEntry =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as IdentityEntry).id === "string" &&
          typeof (x as IdentityEntry).privKeyHex === "string" &&
          /^[a-fA-F0-9]{64}$/.test((x as IdentityEntry).privKeyHex)
      )
      .map((x) => {
        const ent = x as IdentityEntry;
        if (ent.category !== "local" && ent.category !== "nostr") {
          return { ...ent, category: ent.type === "nostr" ? "nostr" as const : "local" as const };
        }
        return ent;
      });
  } catch (_) {}
  return [];
}

function migrateToIdentities(profile: string | null): IdentityEntry[] {
  const existing = loadIdentities(profile);
  if (existing.length > 0) return existing;
  const migrated: IdentityEntry[] = [];
  try {
    const anonKey = localStorage.getItem(getStorageKey(BASE_ANON_KEY, profile));
    if (anonKey && /^[a-fA-F0-9]{64}$/.test(anonKey)) {
      const pubkey = Nostr.getPublicKey(Nostr.hexToBytes(anonKey));
      migrated.push({
        id: "anon-" + pubkey.slice(0, 12),
        privKeyHex: anonKey,
        label: "Local",
        type: "local",
        category: "local",
      });
    }
  } catch (_) {}
  if (migrated.length > 0) {
    try {
      localStorage.setItem(getStorageKey(BASE_IDENTITIES, profile), JSON.stringify(migrated));
    } catch (_) {}
  }
  return migrated;
}

export type { IdentityEntry } from "./types";

function App({ profile }: { profile: string | null }) {
  const toast = useToast();
  const [identities, setIdentities] = useState<IdentityEntry[]>(() => migrateToIdentities(profile));
  const [actingPubkey, setActingPubkey] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_ACTING, profile));
      if (raw && /^[a-fA-F0-9]{64}$/.test(raw)) return raw;
    } catch (_) {}
    return null;
  });
  const [viewingPubkeys, setViewingPubkeys] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_VIEWING, profile));
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === "string" && /^[a-fA-F0-9]{64}$/.test(x)));
      }
    } catch (_) {}
    return new Set();
  });
  const [nsec, setNsec] = useState("");
  const [loginFormOpen, setLoginFormOpen] = useState(false);
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [profiles, setProfiles] = useState<Record<string, ProfileData>>({});
  const [newPost, setNewPost] = useState("");
  // Attachments are encrypted before upload, so a note carries a token
  // (url + key) rather than a public URL. See blossom.ts.
  const [postAttachments, setPostAttachments] = useState<UploadedAttachment[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [status, setStatus] = useState<string>("");
  /**
   * The outcome of the last attach, shown next to the Attach button.
   *
   * setStatus renders inside the Steganography aside, next to the embed and
   * detect controls. Attaching happens in the compose box at the top of the
   * main column, so every refusal and every upload error was written to a
   * panel the user was not looking at -- and clicking Attach, choosing a file
   * and seeing nothing is indistinguishable from a dead button.
   *
   * Deliberately NOT also a toast. Toasts are fixed to the top right, beside
   * the Network switch, so reporting both put the same green message in two
   * places at once and drew the eye away from the control that caused it.
   */
  /** Bulk selection for deleting several of your own notes at once. */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedNoteIdsForDelete, setSelectedNoteIdsForDelete] = useState<Set<string>>(new Set());

  const [attachNotice, setAttachNotice] =
    useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const [decodeError, setDecodeError] = useState<string>("");
  const [relayStatus, setRelayStatus] = useState<string>("");
  const [view, setView] = useState<View>("feed");
  const [replyingTo, setReplyingTo] = useState<NostrEvent | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editAbout, setEditAbout] = useState("");
  const [editPicture, setEditPicture] = useState("");
  const [editBanner, setEditBanner] = useState("");
  const [dmDecrypted, setDmDecrypted] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [embedModalOpen, setEmbedModalOpen] = useState(false);
  const [embedMethod, setEmbedMethod] = useState<StegoMethod>("qim");
  const [targetPlatform, setTargetPlatform] = useState<string>("universal");
  const [embedCoverFile, setEmbedCoverFile] = useState<File | null>(null);
  const [embedRecipientMode, setEmbedRecipientMode] = useState<"open" | "recipients">("open");
  // Carry the feed itself, or carry a ~200-byte pointer to it on a relay
  // (§10.4). Off by default: self-contained is the property that makes an
  // image worth sending in the first place, and pointer mode trades it away
  // for quietness. The user opts in when the channel is tight.
  // Default ON. A ~260-byte pointer survives every channel regardless of cover
  // size, where a self-contained bundle is bounded by the photo. The cost is
  // real and stated in the dialog: it needs the network, the recipient must be
  // online, and their relay request is observable.
  const [embedPointerMode, setEmbedPointerMode] = useState(true);
  // Slot-ordering override for A/B comparison (§17.4). "profile" uses whatever
  // the platform profile declares; the other two force one ordering so the same
  // cover and payload can be shot both ways and judged by eye. Decode is
  // unaffected -- the blind sweep tries both orderings regardless.
  const [embedSlotOrder, setEmbedSlotOrder] = useState<"profile" | "ac-major" | "spread">("profile");
  // null = carry the feed and let packForCapacity choose. A list = carry
  // exactly these notes. "Back up my feed" and "send this one message to this
  // one person" are different jobs and only the first was possible before.
  const [embedNoteIds, setEmbedNoteIds] = useState<string[] | null>(null);
  const [embedRecipientInput, setEmbedRecipientInput] = useState("");
  const [embedRecipients, setEmbedRecipients] = useState<string[]>([]);
  const [selectedMessagePeer, setSelectedMessagePeer] = useState<string | null>(null);
  const [dmReplyContent, setDmReplyContent] = useState("");
  const [lastReadTimestamps, setLastReadTimestamps] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_DM_READ, profile));
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, number>;
        if (typeof obj === "object" && obj !== null) return obj;
      }
    } catch (_) {}
    return {};
  });
  const [lastNotifReadAt, setLastNotifReadAt] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_NOTIF_READ, profile));
      if (raw) return Number(raw) || 0;
    } catch (_) {}
    return 0;
  });
  const [newMessagePubkeyInput, setNewMessagePubkeyInput] = useState("");
  const [newMessageModalOpen, setNewMessageModalOpen] = useState(false);
  const [viewingProfilePubkey, setViewingProfilePubkey] = useState<string | null>(null);
  const [profileTab, setProfileTab] = useState<"notes" | "replies">("notes");
  const [showNsecFor, setShowNsecFor] = useState<string | null>(null);
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const [followingSearchInput, setFollowingSearchInput] = useState("");
  const [mutedPubkeys, setMutedPubkeys] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_MUTE_PUBKEYS, profile));
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (_) {}
    return new Set();
  });
  // Event IDs loaded via Detect image; show them even if author identity has
  // "view" off (shared with any Stegstr user).
  //
  // PERSISTED, and it has to be. `events` is saved to localStorage but this
  // set was rebuilt empty on every load, while the feed filter that depends
  // on it is permanent. So an imported self-authored note was visible until
  // the next reload and invisible afterwards -- still present in `events`,
  // so re-importing the same image reported "0 new, 1 already had" and
  // offered nothing to do. The note was in the user's data, unreachable.
  const [importedEventIds, setImportedEventIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_IMPORTED_IDS, profile));
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (_) {}
    return new Set();
  });
  const [mutedWords, setMutedWords] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_MUTE_WORDS, profile));
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) return arr;
      }
    } catch (_) {}
    return [];
  });
  const [muteInput, setMuteInput] = useState("");
  const [relayUrls, setRelayUrls] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_RELAYS, profile));
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr) && arr.length > 0) return arr;
      }
    } catch (_) {}
    return [...DEFAULT_RELAYS];
  });
  useEffect(() => {
    getRelayUrls().then((urls) => {
      setRelayUrls((prev) => {
        if (prev.length === DEFAULT_RELAYS.length && prev.every((u, i) => u === DEFAULT_RELAYS[i])) return urls;
        return prev;
      });
    });
  }, []);
  const [newRelayUrl, setNewRelayUrl] = useState("");
  const [feedFilter, setFeedFilter] = useState<"global" | "following">("global");
  // Default ON. An unfiltered Global feed is the first thing the app shows,
  // and it is not something most people can leave open on a shared screen.
  const [hideSensitive, setHideSensitive] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [embedding, setEmbedding] = useState(false);
  const [stegoProgress, setStegoProgress] = useState("");
  const [stegoLogs, setStegoLogs] = useState<string[]>([]);
  // Decoded-image review. Events are held here rather than merged on open: an
  // image can arrive from anyone via WhatsApp or a group chat, so opening one
  // must not silently write to the user's feed.
  const [detectReview, setDetectReview] = useState<{
    events: DetectedEvent[]; bytes: number; name: string;
  } | null>(null);
  const [dragOverStego, setDragOverStego] = useState(false);
  const [queuedZaps, setQueuedZaps] = useState<QueuedZap[]>(() => loadQueuedZaps(profile));
  const relayRef = useRef<ReturnType<typeof connectRelays> | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const postMediaInputRef = useRef<HTMLInputElement | null>(null);
  const loadingMoreRef = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const eventBufferRef = useRef<NostrEvent[]>([]);
  const FLUSH_MS = 120;

  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_RELAYS, profile), JSON.stringify(relayUrls));
    } catch (_) {}
  }, [relayUrls, profile]);

  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_MUTE_PUBKEYS, profile), JSON.stringify([...mutedPubkeys]));
    } catch (_) {}
  }, [mutedPubkeys, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_IMPORTED_IDS, profile), JSON.stringify([...importedEventIds]));
    } catch (_) {}
  }, [importedEventIds, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_MUTE_WORDS, profile), JSON.stringify(mutedWords));
    } catch (_) {}
  }, [mutedWords, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_ZAP_QUEUE, profile), JSON.stringify(queuedZaps));
    } catch (_) {}
  }, [queuedZaps, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_DM_READ, profile), JSON.stringify(lastReadTimestamps));
    } catch (_) {}
  }, [lastReadTimestamps, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_NOTIF_READ, profile), String(lastNotifReadAt));
    } catch (_) {}
  }, [lastNotifReadAt, profile]);

  useEffect(() => {
    if (searchQuery.trim()) setReplyingTo(null);
  }, [searchQuery]);
  useEffect(() => {
    if (view !== "feed") setFocusedNoteId(null);
  }, [view]);
  const prevViewRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevViewRef.current !== null && prevViewRef.current !== view) {
      logger.logAction("view_change", `View changed to ${view}`, { view });
    }
    prevViewRef.current = view;
  }, [view]);

  // Prevent browser from opening dropped images (global handler for web)
  useEffect(() => {
    if (!isWeb()) return;
    const preventDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("dragover", preventDrop);
    document.addEventListener("drop", preventDrop);
    return () => {
      document.removeEventListener("dragover", preventDrop);
      document.removeEventListener("drop", preventDrop);
    };
  }, []);

  const prevNetworkRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevNetworkRef.current !== null && prevNetworkRef.current !== networkEnabled) {
      logger.logAction("network_toggle", networkEnabled ? "Network enabled" : "Network disabled", { networkEnabled });
    }
    prevNetworkRef.current = networkEnabled;
  }, [networkEnabled]);
  const prevNetworkRefLegacy = useRef(false);
  const hasSyncedAnonRef = useRef(false);

  // Ensure at least one identity
  useEffect(() => {
    if (identities.length === 0) {
      const anon = getOrCreateAnonKey(profile);
      const pubkey = Nostr.getPublicKey(Nostr.hexToBytes(anon));
      setIdentities([{ id: "anon-" + pubkey.slice(0, 12), privKeyHex: anon, label: "Local", type: "local", category: "local" }]);
      setActingPubkey(pubkey);
      setViewingPubkeys(new Set([pubkey]));
    }
  }, [identities.length, profile]);

  useEffect(() => {
    if (identities.length === 0) return;
    try {
      localStorage.setItem(getStorageKey(BASE_IDENTITIES, profile), JSON.stringify(identities));
    } catch (e) {
      // Every other persisted value can be dropped silently and rebuilt from
      // the network. This one cannot: the private keys ARE the accounts. If
      // this write fails -- storage full, storage disabled, some private
      // browsing modes -- the user loses every identity the moment they
      // refresh, with nothing on screen to suggest anything went wrong. Say
      // so while they can still copy the key out.
      logger.logError("Identity save failed", e, { count: identities.length });
      setStatus(
        "WARNING: your keys could not be saved to this browser's storage. " +
        "Back up your nsec from the Identity tab before closing this tab, or you will lose this account.",
      );
    }
  }, [identities, profile]);
  useEffect(() => {
    if (actingPubkey) {
      try { localStorage.setItem(getStorageKey(BASE_ACTING, profile), actingPubkey); } catch (_) {}
    }
  }, [actingPubkey, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_VIEWING, profile), JSON.stringify([...viewingPubkeys]));
    } catch (_) {}
  }, [viewingPubkeys, profile]);

  // Sync viewing to include all identities if empty
  useEffect(() => {
    if (viewingPubkeys.size === 0 && identities.length > 0) {
      setViewingPubkeys(new Set(identities.map((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)))));
    }
  }, [identities, viewingPubkeys.size]);
  useEffect(() => {
    if (!actingPubkey && identities.length > 0) {
      const firstPk = Nostr.getPublicKey(Nostr.hexToBytes(identities[0].privKeyHex));
      setActingPubkey(firstPk);
    }
  }, [actingPubkey, identities]);

  const actingIdentity = identities.find((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === actingPubkey);
  const effectivePrivKey = actingIdentity?.privKeyHex ?? identities[0]?.privKeyHex ?? getOrCreateAnonKey(profile);
  const pubkey = Nostr.getPublicKey(Nostr.hexToBytes(effectivePrivKey));
  const selfPubkeys = Array.from(viewingPubkeys).length > 0 ? Array.from(viewingPubkeys) : [pubkey];
  const selfPubkeysKey = useMemo(() => selfPubkeys.join(","), [selfPubkeys.length, ...selfPubkeys]);
  const viewingPubkeysKey = useMemo(() => [...viewingPubkeys].join(","), [viewingPubkeys]);
  const relayUrlsKey = useMemo(() => relayUrls.join(","), [relayUrls]);
  /** Only publish to Nostr relays when identity category is "nostr". Local = steganographic only. */
  const canPublishToNetwork = actingIdentity?.category === "nostr";

  const getIdentityLabelsForPubkey = useCallback((pk: string): string[] => {
    return identities
      .filter((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === pk)
      .map((i) => profiles[pk]?.name || i.label || pk.slice(0, 8) + "…");
  }, [identities, profiles]);

  const isNostrLoggedIn = actingIdentity?.type === "nostr";
  // Use actingPubkey for profile display to avoid crossover with other identities (pubkey has fallback to identities[0])
  const profileDisplayKey = actingPubkey ?? pubkey;
  const myProfile = profileDisplayKey ? profiles[profileDisplayKey] : null;
  const myName = myProfile?.name ?? (profileDisplayKey ? `${profileDisplayKey.slice(0, 8)}…` : "");
  const myPicture = myProfile?.picture ?? null;
  const myAbout = myProfile?.about ?? "";
  const myBanner = myProfile?.banner ?? null;

  const ourPubkeysSet = new Set(identities.map((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex))));
  let contacts = Array.from(viewingPubkeys).flatMap((pk) => {
    const kind3 = events.find((e) => e.kind === 3 && e.pubkey === pk);
    return kind3 ? kind3.tags.filter((t) => t[0] === "p").map((t) => t[1]) : [];
  });
  // Same predicate the follow handlers use, so what is displayed and what an
  // edit starts from cannot drift apart.
  if (
    actingPubkey && viewingPubkeys.has(actingPubkey) &&
    usingDefaultFollows(events, actingPubkey, actingIdentity?.category)
  ) {
    contacts = [...contacts, ...getDefaultFollowPubkeys()];
  }
  const contactsSet = new Set(contacts);
  const dmEvents = events.filter(
    (e) =>
      e.kind === 4 &&
      (selfPubkeys.includes(e.pubkey) || e.tags.some((t) => t[0] === "p" && t[1] && selfPubkeys.includes(t[1])))
  );
  const recentDmPartners = (() => {
    const seen = new Set<string>();
    const list: { pubkey: string }[] = [];
    for (const ev of dmEvents.sort((a, b) => b.created_at - a.created_at)) {
      const other = selfPubkeys.includes(ev.pubkey) ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
      if (other && !seen.has(other)) {
        seen.add(other);
        list.push({ pubkey: other });
      }
    }
    return list;
  })();
  const notes = events.filter((e) => e.kind === 1);
  const noteIds = new Set(notes.map((n) => n.id));
  const deletedNoteIds = new Set(
    events.filter((e) => e.kind === 5 && selfPubkeys.includes(e.pubkey)).flatMap((e) => e.tags.filter((t) => t[0] === "e").map((t) => t[1]))
  );
  // What an image may carry. Shared by automatic packing and the note picker,
  // which used to disagree -- see embed-candidates.ts.
  const candidateCtx: CandidateContext = {
    ourPubkeys: ourPubkeysSet,
    contacts: contactsSet,
    deletedNoteIds,
  };
  const rootNotes = notes
    .filter((n) => {
      const eTag = n.tags.find((t) => t[0] === "e");
      // Deletion is decided solely by the kind-5 tombstones in `events`.
      //
      // This briefly also exempted anything in importedEventIds, to let a
      // deleted note be restored from an image -- but that set is populated
      // with EVERY event of EVERY decoded image, accepted or not, so any note
      // that had ever appeared in one became permanently undeletable. Restoring
      // is handled where it belongs instead: accepting a note in the decode
      // review drops its tombstone (see onAccept), which is a real un-delete
      // rather than a filter that argues with one.
      return (!eTag || !noteIds.has(eTag[1])) && !deletedNoteIds.has(n.id);
    });
  const getRepliesTo = (noteId: string) =>
    notes.filter((n) => n.tags.find((t) => t[0] === "e" && t[1] === noteId));

  const reposts = events.filter((e) => e.kind === 6);
  const getRepostedNote = (repost: NostrEvent): NostrEvent | null => {
    if (repost.content && repost.content.trim()) {
      try {
        const parsed = JSON.parse(repost.content) as NostrEvent;
        if (parsed.kind === 1 && parsed.id && parsed.pubkey) return parsed;
      } catch (_) {}
    }
    const eTag = repost.tags.find((t) => t[0] === "e");
    if (eTag) {
      const found = notes.find((n) => n.id === eTag[1]);
      if (found) return found;
    }
    return null;
  };

  const myNoteIds = new Set(notes.filter((n) => selfPubkeys.includes(n.pubkey)).map((n) => n.id));
  const noteContentMatchesMutedWord = (content: string) =>
    mutedWords.some((w) => w.trim() && content.toLowerCase().includes(w.trim().toLowerCase()));

  const notificationEventsRaw = selfPubkeys.length > 0
    ? events.filter(
        (e) =>
          (e.kind === 7 && e.tags.some((t) => t[0] === "p" && t[1] && selfPubkeys.includes(t[1]))) ||
          (e.kind === 1 && e.tags.some((t) => t[0] === "e" && myNoteIds.has(t[1]))) ||
          (e.kind === 6 && e.tags.some((t) => t[0] === "e" && myNoteIds.has(t[1]))) ||
          (e.kind === 9735 && e.tags.some((t) => t[0] === "e" && myNoteIds.has(t[1])))
      )
    : [];
  const notificationEvents = notificationEventsRaw
    .filter((e) => !mutedPubkeys.has(e.pubkey) && !noteContentMatchesMutedWord(e.kind === 1 ? e.content : ""))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 100);

  const reactions = events.filter((e) => e.kind === 7);
  const zapReceipts = events.filter((e) => e.kind === 9735);
  const getLikeCount = (noteId: string) =>
    reactions.filter((r) => r.tags.some((t) => t[0] === "e" && t[1] === noteId)).length;
  const getZapCount = (noteId: string) =>
    zapReceipts.filter((r) => r.tags.some((t) => t[0] === "e" && t[1] === noteId)).length;
  const hasLiked = (noteId: string) =>
    reactions.some((r) => selfPubkeys.includes(r.pubkey) && r.tags.some((t) => t[0] === "e" && t[1] === noteId));

  const bookmarksEvent = pubkey ? events.filter((e) => e.kind === 10003 && e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0] : null;
  const bookmarkIds = new Set(
    events
      .filter((e) => e.kind === 10003 && viewingPubkeys.has(e.pubkey))
      .flatMap((e) => e.tags.filter((t) => t[0] === "e").map((t) => t[1]))
  );
  const hasBookmarked = (noteId: string) => bookmarkIds.has(noteId);

  const profileViewPubkey = viewingProfilePubkey ?? profileDisplayKey;
  const profileRootNotes = rootNotes.filter((n) => n.pubkey === profileViewPubkey);
  // Profile's own replies (notes by this user that are replies to other notes)
  const profileReplies = notes.filter((n) => {
    if (n.pubkey !== profileViewPubkey) return false;
    const eTag = n.tags.find((t) => t[0] === "e");
    return eTag && noteIds.has(eTag[1]);
  }).sort((a, b) => b.created_at - a.created_at);
  // Helper to get parent note for a reply
  const getParentNote = (noteId: string) => notes.find((n) => n.id === noteId) ?? null;
  const profileFollowing = profileViewPubkey
    ? (events.find((e) => e.kind === 3 && e.pubkey === profileViewPubkey)?.tags?.filter((t) => t[0] === "p").map((t) => t[1]) ?? [])
    : [];
  const profileFollowers = profileViewPubkey
    ? [...new Set(events.filter((e) => e.kind === 3 && e.tags.some((t) => t[0] === "p" && t[1] === profileViewPubkey)).map((e) => e.pubkey))]
    : [];

  const searchTrim = searchQuery.trim();
  const searchLower = searchTrim.toLowerCase();
  const searchNoSpaces = searchTrim.replace(/\s/g, "");
  // Resolve npub to hex for author search (allow npub anywhere in query, strip spaces)
  let searchPubkeyHex: string | null = null;
  const npubMatch = searchNoSpaces.match(/npub1[a-zA-Z0-9]+/i);
  const npubStr = npubMatch ? npubMatch[0] : null;
  if (npubStr) {
    try {
      const decoded = Nostr.nip19.decode(npubStr);
      if (decoded.type === "npub") searchPubkeyHex = Nostr.bytesToHex(decoded.data);
    } catch (_) {}
  }
  if (!searchPubkeyHex && /^[a-fA-F0-9]{64}$/.test(searchNoSpaces)) {
    searchPubkeyHex = searchNoSpaces.toLowerCase();
  }
  const searchNoSpacesLower = searchNoSpaces.toLowerCase();
  const filteredRootNotes = searchTrim
    ? rootNotes.filter((n) => {
        if (searchPubkeyHex && n.pubkey.toLowerCase() === searchPubkeyHex) return true;
        // Partial hex match: only use no-spaces version for hex-like queries
        if (/^[a-f0-9]{8,64}$/.test(searchNoSpacesLower) && n.pubkey.toLowerCase().includes(searchNoSpacesLower)) return true;
        const authorName = profiles[n.pubkey]?.name?.toLowerCase() ?? "";
        if (authorName && searchLower && authorName.includes(searchLower)) return true;
        if (searchLower && n.content.toLowerCase().includes(searchLower)) return true;
        for (const t of n.tags) {
          if (t[0] === "t" && t[1]?.toLowerCase().includes(searchLower)) return true;
          if (t[1]?.toLowerCase().includes(searchLower)) return true;
        }
        return false;
      })
    : rootNotes;

  const noteMatchesSearch = (n: NostrEvent) => {
    if (!searchTrim) return true;
    if (searchPubkeyHex && n.pubkey.toLowerCase() === searchPubkeyHex) return true;
    const pkLower = n.pubkey.toLowerCase();
    if (searchLower && pkLower.includes(searchLower)) return true;
    const authorName = profiles[n.pubkey]?.name?.toLowerCase() ?? "";
    if (authorName && authorName.includes(searchLower)) return true;
    if (n.content.toLowerCase().includes(searchLower)) return true;
    for (const t of n.tags) {
      if (t[0] === "t" && t[1]?.toLowerCase().includes(searchLower)) return true;
      if (t[1]?.toLowerCase().includes(searchLower)) return true;
    }
    return false;
  };

  const isNoteMuted = (n: NostrEvent) => mutedPubkeys.has(n.pubkey) || noteContentMatchesMutedWord(n.content);

  /**
   * Adult / sensitive content, for the Global feed.
   *
   * Global shows notes from anyone on the relays, which in practice means it
   * shows porn. That is fine for a general nostr client where the user chose
   * to browse everything; it is a problem here, because Global is the first
   * screen this app presents and an unfiltered one makes it unshowable.
   *
   * Leads with NIP-36 -- the protocol's own signal, a `content-warning` tag
   * the author sets -- rather than guessing from words. Hashtags come second,
   * since `t` tags are structured and self-applied. The literal word list is
   * last and deliberately short: matching on words punishes people discussing
   * a subject as readily as people posting it, and a filter that hides
   * ordinary conversation is worse than one that misses a few posts.
   */
  const isSensitiveNote = (n: NostrEvent): boolean => {
    for (const t of n.tags) {
      // NIP-36: the author flagged it themselves.
      if (t[0] === "content-warning") return true;
      if (t[0] === "t" && SENSITIVE_HASHTAGS.has(String(t[1] ?? "").toLowerCase())) return true;
    }
    const lower = n.content.toLowerCase();
    return SENSITIVE_WORDS.some((w) => lower.includes(w));
  };

  const exploreNotes = rootNotes
    .filter((n) => !isNoteMuted(n))
    .sort((a, b) => {
      const la = getLikeCount(a.id);
      const lb = getLikeCount(b.id);
      if (lb !== la) return lb - la;
      return b.created_at - a.created_at;
    })
    .slice(0, 100);

  const feedItems: FeedItem[] = [
    ...filteredRootNotes.map((note) => ({ type: "note" as const, note, sortAt: note.created_at })),
    ...reposts
      .map((r) => ({ type: "repost" as const, repost: r, note: getRepostedNote(r), sortAt: r.created_at }))
      .filter((x): x is { type: "repost"; repost: NostrEvent; note: NostrEvent; sortAt: number } => x.note !== null && !deletedNoteIds.has(x.note.id) && noteMatchesSearch(x.note)),
  ]
    .filter((item) => {
      const note = item.type === "note" ? item.note : item.note;
      const reposter = item.type === "repost" ? item.repost.pubkey : null;
      if (mutedPubkeys.has(note.pubkey) || (reposter && mutedPubkeys.has(reposter))) return false;
      if (isNoteMuted(note)) return false;
      if (ourPubkeysSet.has(note.pubkey) && !viewingPubkeys.has(note.pubkey) && !importedEventIds.has(note.id)) return false;
      if (reposter && ourPubkeysSet.has(reposter) && !viewingPubkeys.has(reposter) && !importedEventIds.has(item.type === "repost" ? item.repost.id : note.id)) return false;
      // Global only: Following is a list the user curated themselves, and
      // second-guessing it would hide people they deliberately chose.
      if (feedFilter === "global" && hideSensitive && isSensitiveNote(note)) return false;
      if (feedFilter === "following") {
        const authorPk = item.type === "repost" ? item.repost.pubkey : item.note.pubkey;
        // You do not follow yourself, so a bare contactsSet test hides your
        // own notes -- including the ones you just chose to import from an
        // image. That made "Add to my feed" look like it did nothing
        // whenever the Following tab was active, which is the same missing
        // own-note exception that importedEventIds was added for.
        const mine = ourPubkeysSet.has(authorPk) || importedEventIds.has(item.note.id);
        if (!mine && !contactsSet.has(authorPk)) return false;
      }
      return true;
    })
    .sort((a, b) => b.sortAt - a.sortAt);

  const publishViaRelay = useCallback((ev: NostrEvent) => {
    if (relayRef.current) {
      relayRef.current.publish(ev);
    } else {
      publishEvent(ev, relayUrls);
    }
  }, [relayUrls]);

  useEffect(() => {
    const authors = Array.from(viewingPubkeys).filter((pk) => pk && /^[a-fA-F0-9]{64}$/.test(pk));
    if (!networkEnabled || authors.length === 0) {
      relayRef.current?.close();
      relayRef.current = null;
      eventBufferRef.current = [];
      setRelayStatus("");
      return;
    }
    setRelayStatus("Connecting…");
    eventBufferRef.current = [];
    relayRef.current = connectRelays(
      authors,
      (ev) => {
        try {
          if (typeof ev.id !== "string" || typeof ev.pubkey !== "string") return;
          const safe: NostrEvent = {
            id: ev.id,
            pubkey: ev.pubkey,
            created_at: typeof ev.created_at === "number" ? ev.created_at : 0,
            kind: typeof ev.kind === "number" ? ev.kind : 0,
            tags: Array.isArray(ev.tags) ? ev.tags : [],
            content: typeof ev.content === "string" ? ev.content : "",
            sig: typeof ev.sig === "string" ? ev.sig : "",
          };
          eventBufferRef.current.push(safe);
        } catch (_) {}
      },
      () => setRelayStatus("Synced"),
      (err) => setRelayStatus("Error: " + (err instanceof Error ? err.message : String(err))),
      relayUrls
    );
    const flush = () => {
      const batch = eventBufferRef.current;
      if (batch.length === 0) return;
      eventBufferRef.current = [];
      try {
        setEvents((prev) => {
          const byId = new Map(prev.map((e) => [e.id, e]));
          batch.forEach((e) => byId.set(e.id, e));
          let all = Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
          const MAX_EVENTS = 10000;
          if (all.length > MAX_EVENTS) {
            const ownPks = new Set(selfPubkeys);
            const own = all.filter((e) => ownPks.has(e.pubkey));
            const rest = all.filter((e) => !ownPks.has(e.pubkey)).slice(0, MAX_EVENTS - own.length);
            all = [...own, ...rest].sort((a, b) => b.created_at - a.created_at);
          }
          return all;
        });
        const profileUpdates: Record<string, ProfileData> = {};
        batch.filter((e) => e.kind === 0).forEach((e) => {
          try {
            const raw = JSON.parse(e.content) as { name?: string; display_name?: string; about?: string; picture?: string; banner?: string; nip05?: string };
            profileUpdates[e.pubkey] = {
              name: raw.name ?? raw.display_name,
              about: raw.about,
              picture: raw.picture,
              banner: raw.banner,
              nip05: raw.nip05,
            };
          } catch (_) {}
        });
        if (Object.keys(profileUpdates).length > 0) {
          setProfiles((p) => {
            const merged = { ...p, ...profileUpdates };
            const MAX_PROFILES = 1000;
            const keys = Object.keys(merged);
            if (keys.length <= MAX_PROFILES) return merged;
            const keepKeys = new Set<string>();
            selfPubkeys.forEach((pk) => keepKeys.add(pk));
            contacts.forEach((pk) => keepKeys.add(pk));
            for (const k of Object.keys(profileUpdates)) keepKeys.add(k);
            const evictable = keys.filter((k) => !keepKeys.has(k));
            const toRemove = evictable.slice(0, keys.length - MAX_PROFILES);
            for (const k of toRemove) delete merged[k];
            return merged;
          });
        }
      } catch (err) {
        console.error("[Stegstr] flush error", err);
      }
    };
    const interval = setInterval(flush, FLUSH_MS);
    return () => {
      clearInterval(interval);
      relayRef.current?.close();
      relayRef.current = null;
      eventBufferRef.current = [];
      setRelayStatus("");
    };
  }, [networkEnabled, viewingPubkeysKey, relayUrlsKey]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || !networkEnabled || !relayRef.current || view !== "feed") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting || loadingMoreRef.current) return;
        const notesForMin = events.filter((e) => e.kind === 1);
        if (notesForMin.length === 0) return;
        const oldest = Math.min(...notesForMin.map((n) => n.created_at));
        loadingMoreRef.current = true;
        setLoadingMore(true);
        relayRef.current?.requestMore(oldest);
        setTimeout(() => {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }, 2000);
      },
      { rootMargin: "200px", threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [networkEnabled, view, events.length]);

  const contactsKey = useMemo(() => [...contactsSet].join(","), [contactsSet.size]);
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const toFetch = new Set<string>(contacts);
    notes.forEach((n) => toFetch.add(n.pubkey));
    if (toFetch.size > 0) relayRef.current.requestProfiles([...toFetch].slice(0, 300));
  }, [networkEnabled, contactsKey, notes.length]);

  const rootNoteIdsKey = useMemo(() => rootNotes.map((n) => n.id).join(","), [rootNotes.length]);
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const ids = rootNotes.map((n) => n.id);
    if (ids.length > 0) relayRef.current.requestReplies(ids);
  }, [networkEnabled, rootNoteIdsKey]);

  useEffect(() => {
    if (relayStatus !== "Synced" || !relayRef.current) return;
    const toFetch = new Set<string>(contacts);
    notes.forEach((n) => toFetch.add(n.pubkey));
    if (toFetch.size > 0) relayRef.current.requestProfiles([...toFetch].slice(0, 300));
    const ids = rootNotes.map((n) => n.id);
    if (ids.length > 0) relayRef.current.requestReplies(ids);
  }, [relayStatus]);

  // When user searches by pubkey/npub, fetch that author's notes and profile from relays (debounced)
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const trimmed = searchQuery.trim().replace(/\s/g, "");
    let toFetch: string | null = null;
    const npubMatch = trimmed.match(/npub1[a-zA-Z0-9]+/i);
    if (npubMatch) {
      try {
        const decoded = Nostr.nip19.decode(npubMatch[0]);
        if (decoded.type === "npub") toFetch = Nostr.bytesToHex(decoded.data);
      } catch (_) {}
    } else if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
      toFetch = trimmed.toLowerCase();
    }
    if (!toFetch) return;
    const t = setTimeout(() => {
      relayRef.current?.requestAuthor(toFetch!);
    }, 400);
    return () => clearTimeout(t);
  }, [networkEnabled, searchQuery]);

  // When relay becomes Synced and search is a pubkey, fetch that author (in case first request ran too early)
  useEffect(() => {
    if (relayStatus !== "Synced" || !relayRef.current) return;
    const trimmed = searchQuery.trim().replace(/\s/g, "");
    let toFetch: string | null = null;
    const npubMatch = trimmed.match(/npub1[a-zA-Z0-9]+/i);
    if (npubMatch) {
      try {
        const decoded = Nostr.nip19.decode(npubMatch[0]);
        if (decoded.type === "npub") toFetch = Nostr.bytesToHex(decoded.data);
      } catch (_) {}
    } else if (/^[a-fA-F0-9]{64}$/.test(trimmed)) toFetch = trimmed.toLowerCase();
    if (toFetch) relayRef.current.requestAuthor(toFetch);
  }, [relayStatus, searchQuery]);

  // When viewing a profile (own or other), fetch profile, notes, and followers
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const pk = viewingProfilePubkey ?? pubkey;
    if (!pk) return;
    relayRef.current.requestProfiles([pk]);
    relayRef.current.requestAuthor(pk);
    relayRef.current.requestFollowers(pk);
  }, [networkEnabled, viewingProfilePubkey, pubkey]);

  // When Nostr is acting and we lack profile data, aggressively fetch after relay syncs
  const profileSyncRetryRef = useRef(0);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  useEffect(() => {
    if (!networkEnabled || !relayRef.current || relayStatus !== "Synced") return;
    if (!actingPubkey || actingIdentity?.type !== "nostr") return;
    const haveProfile = profilesRef.current[actingPubkey]?.name || profilesRef.current[actingPubkey]?.picture || profilesRef.current[actingPubkey]?.about;
    if (haveProfile) { profileSyncRetryRef.current = 0; return; }
    if (profileSyncRetryRef.current >= 5) {
      setStatus("Could not fetch profile from relays. Try toggling Network off/on.");
      return;
    }
    profileSyncRetryRef.current++;
    relayRef.current.requestProfiles([actingPubkey]);
    relayRef.current.requestAuthor(actingPubkey);
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    for (const delay of [1500, 3500, 7000]) {
      timeouts.push(
        setTimeout(() => {
          if (profilesRef.current[actingPubkey]?.name || profilesRef.current[actingPubkey]?.picture) return;
          relayRef.current?.requestProfiles([actingPubkey]);
          relayRef.current?.requestAuthor(actingPubkey);
        }, delay)
      );
    }
    return () => timeouts.forEach((t) => clearTimeout(t));
  }, [networkEnabled, relayStatus, actingPubkey, actingIdentity?.type]);

  // NIP-50: when user searches by text (not pubkey), ask relays for matching notes and profiles (debounced)
  useEffect(() => {
    try {
      if (!networkEnabled || !relayRef.current) return;
      const trimmed = searchQuery.trim();
      if (trimmed.length < 2) return;
      const isPubkey = /npub1[a-zA-Z0-9]+/i.test(trimmed.replace(/\s/g, "")) || /^[a-fA-F0-9]{64}$/.test(trimmed.replace(/\s/g, ""));
      if (isPubkey) return;
      const t = setTimeout(() => {
        try {
          relayRef.current?.requestSearch(trimmed);
          relayRef.current?.requestProfileSearch(trimmed);
          logger.logAction("search", "Search performed", { query: trimmed.slice(0, 50), networkEnabled });
        } catch (e) {
          console.error("[Stegstr] search request error", e);
        }
      }, 500);
      return () => clearTimeout(t);
    } catch (e) {
      console.error("[Stegstr] search effect error", e);
    }
  }, [networkEnabled, searchQuery]);

  // New message modal: fetch profiles by name from relays when user types (debounced)
  useEffect(() => {
    if (!newMessageModalOpen || !networkEnabled || !relayRef.current) return;
    const trimmed = newMessagePubkeyInput.trim();
    if (trimmed.length < 2) return;
    if (resolvePubkeyFromInput(newMessagePubkeyInput)) return;
    const t = setTimeout(() => {
      relayRef.current?.requestProfileSearch(trimmed);
    }, 400);
    return () => clearTimeout(t);
  }, [newMessageModalOpen, newMessagePubkeyInput, networkEnabled]);

  // Follow area: fetch profiles by name from relays when user types (debounced)
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const trimmed = followingSearchInput.trim();
    if (trimmed.length < 2) return;
    if (resolvePubkeyFromInput(followingSearchInput)) return;
    const t = setTimeout(() => {
      relayRef.current?.requestProfileSearch(trimmed);
    }, 400);
    return () => clearTimeout(t);
  }, [networkEnabled, followingSearchInput]);

  useEffect(() => {
    const justTurnedOn = networkEnabled && !prevNetworkRefLegacy.current;
    prevNetworkRefLegacy.current = networkEnabled;
    if (!justTurnedOn || !pubkey || !canPublishToNetwork) return;
    setEvents((prev) => {
      const myEvents = prev.filter((e) => e.pubkey === pubkey);
      const BATCH = 5;
      const DELAY_MS = 400;
      myEvents.forEach((ev, i) => {
        setTimeout(() => {
          try {
            publishViaRelay(ev);
          } catch (_) {}
        }, Math.floor(i / BATCH) * DELAY_MS);
      });
      return prev;
    });
  }, [networkEnabled, pubkey, relayUrls, canPublishToNetwork]);

  const dmCacheRef = useRef<Record<string, string>>({});
  const dmEventIds = dmEvents.map((e) => e.id).join(",");
  useEffect(() => {
    if (dmEvents.length === 0) {
      dmCacheRef.current = {};
      setDmDecrypted({});
      return;
    }
    let cancelled = false;
    const cached = dmCacheRef.current;
    const newEvents = dmEvents.filter((ev) => !(ev.id in cached));
    if (newEvents.length === 0) {
      setDmDecrypted({ ...cached });
      return;
    }
    (async () => {
      for (const ev of newEvents) {
        if (cancelled) return;
        const weAreSender = selfPubkeys.includes(ev.pubkey);
        const ourPk = weAreSender ? ev.pubkey : ev.tags.find((t) => t[0] === "p")?.[1];
        const otherPubkey = weAreSender ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
        if (!ourPk || !otherPubkey || !selfPubkeys.includes(ourPk)) {
          cached[ev.id] = "[No peer]";
          continue;
        }
        const identityForPk = identities.find((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === ourPk);
        const privToUse = identityForPk?.privKeyHex ?? effectivePrivKey;
        try {
          const plain = await Nostr.nip04Decrypt(ev.content, privToUse, otherPubkey);
          if (!cancelled) cached[ev.id] = plain;
        } catch {
          if (!cancelled) cached[ev.id] = "[Decryption failed]";
        }
      }
      if (!cancelled) {
        dmCacheRef.current = cached;
        setDmDecrypted({ ...cached });
      }
    })();
    return () => { cancelled = true; };
  }, [identities, effectivePrivKey, dmEventIds, selfPubkeysKey]);

  // Mark DM conversation as read when user opens it
  useEffect(() => {
    if (selectedMessagePeer) {
      setLastReadTimestamps((prev) => ({ ...prev, [selectedMessagePeer]: Math.floor(Date.now() / 1000) }));
    }
  }, [selectedMessagePeer]);

  // Compute total unread DM count across all peers
  const totalUnreadDmCount = useMemo(() => {
    let count = 0;
    for (const { pubkey: pk } of recentDmPartners) {
      const lastRead = lastReadTimestamps[pk] ?? 0;
      count += dmEvents.filter((ev) => {
        // Only count messages FROM them (not our own sent messages)
        if (selfPubkeys.includes(ev.pubkey)) return false;
        const other = ev.pubkey;
        return other === pk && ev.created_at > lastRead;
      }).length;
    }
    return count;
  }, [dmEvents, recentDmPartners, lastReadTimestamps, selfPubkeys]);

  const totalUnreadNotifCount = useMemo(() => {
    return notificationEvents.filter((ev) => ev.created_at > lastNotifReadAt).length;
  }, [notificationEvents, lastNotifReadAt]);

  // Mark notifications as read when viewing
  useEffect(() => {
    if (view === "notifications" && notificationEvents.length > 0) {
      const latest = notificationEvents[0].created_at;
      if (latest > lastNotifReadAt) {
        setLastNotifReadAt(latest);
      }
    }
  }, [view, notificationEvents, lastNotifReadAt]);

  const handleAddNostrIdentity = useCallback((hexOrNsec: string) => {
    const trimmed = hexOrNsec.trim();
    let privHex: string;
    if (trimmed.toLowerCase().startsWith("nsec")) {
      try {
        const decoded = Nostr.nip19.decode(trimmed);
        if (decoded.type === "nsec") privHex = Nostr.bytesToHex(decoded.data);
        else { setStatus("Invalid nsec"); return; }
      } catch (e) {
        setStatus("Invalid nsec: " + (e as Error).message);
        return;
      }
    } else if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
      privHex = trimmed;
    } else {
      setStatus("Enter valid nsec or 64-char hex key");
      return;
    }
    const pk = Nostr.getPublicKey(Nostr.hexToBytes(privHex));
    if (identities.some((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === pk)) {
      setStatus("Identity already added");
      return;
    }
    setIdentities((prev) => [...prev, { id: "nostr-" + pk.slice(0, 12), privKeyHex: privHex, label: pk.slice(0, 8) + "…", type: "nostr", category: "nostr" }]);
    setActingPubkey(pk);
    setViewingPubkeys((prev) => new Set(prev).add(pk));
    setLoginFormOpen(false);
    setNsec("");
    setStatus(networkEnabled ? "Nostr identity added. Fetching profile…" : "Nostr identity added. Turn Network ON to fetch your profile and posts.");
    if (networkEnabled) {
      const fetchProfile = () => {
        relayRef.current?.requestProfiles([pk]);
        relayRef.current?.requestAuthor(pk);
      };
      setTimeout(fetchProfile, 800);
      setTimeout(fetchProfile, 2500);
      setTimeout(fetchProfile, 5000);
    }
  }, [identities, networkEnabled]);

  const handleLogin = useCallback(() => {
    if (!nsec.trim()) {
      setStatus("Enter nsec or click Generate");
      return;
    }
    handleAddNostrIdentity(nsec.trim());
  }, [nsec, handleAddNostrIdentity]);

  const handleGenerate = useCallback(() => {
    const sk = Nostr.generateSecretKey();
    const hex = Nostr.bytesToHex(sk);
    const pk = Nostr.getPublicKey(sk);
    setIdentities((prev) => [...prev, { id: "local-" + pk.slice(0, 12), privKeyHex: hex, label: "Local " + (prev.length + 1), type: "local", category: "local" }]);
    setActingPubkey(pk);
    setViewingPubkeys((prev) => new Set(prev).add(pk));
    setNsec(Nostr.nip19.nsecEncode(sk));
    setStatus("New local identity created");
    setLoginFormOpen(false);
  }, []);

  // Helper to add stego log entries (visible in UI)
  const addStegoLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setStegoLogs(prev => [...prev.slice(-19), `[${ts}] ${msg}`]);
    console.log("[StegoLog]", msg);
  }, []);

  // Live view of the feed state the detect handler classifies against.
  //
  // handleLoadFromImage reads `events` (and the sets derived from it) about
  // thirty times, but none of them were in its dependency array -- only
  // viewingPubkeys was. So the handler captured whatever feed existed the last
  // time one of its listed deps changed, and kept classifying against that.
  //
  // The visible symptom: delete a note, decode an image containing it, and the
  // review says "you already have everything this image contained". Deleting
  // writes a kind-5 tombstone into `events`, which is exactly what tells the
  // classifier the note is no longer held -- and the stale closure could not
  // see it. It looked like a pointer-mode bug because toggling Network, which
  // IS a dep, silently refreshed the closure and made the next decode correct.
  //
  // A ref rather than fixing the dep list: `handleLoadFromImage` is the
  // identity a Tauri drag-drop listener is registered against, so adding
  // `events` would tear down and re-register that listener on every feed
  // change.
  const detectStateRef = useRef({
    events, importedEventIds, selfPubkeys, ourPubkeysSet, contactsSet,
  });
  detectStateRef.current = {
    events, importedEventIds, selfPubkeys, ourPubkeysSet, contactsSet,
  };

  const handleLoadFromImage = useCallback(async (providedPathOrFile?: string | File | null) => {
    // Shadow the stale closure copies for the whole handler.
    const { events, importedEventIds, selfPubkeys, ourPubkeysSet, contactsSet } =
      detectStateRef.current;
    setDecodeError("");
    setStegoLogs([]);
    {
      // ONE detect implementation, on every platform.
      //
      // There used to be two: this one for the browser, and a separate
      // path-based one for desktop. They drifted, and the desktop copy never
      // got the review dialog -- so on desktop, opening any image merged its
      // entire contents into the feed unreviewed and switched the view to
      // Global to make them visible. That is precisely the behaviour the review
      // dialog was built to prevent: anyone can send you a photo, and opening
      // one must not be enough to write to your feed.
      //
      // The input differs by platform, not the logic. Resolve to a File here
      // -- from a drop, a path, or a picker -- and everything downstream is
      // shared, so a fix can no longer reach one platform and miss the other.
      let file: File | null;
      if (providedPathOrFile instanceof File) {
        file = providedPathOrFile;
        addStegoLog(`Dropped file: ${file.name}`);
      } else if (typeof providedPathOrFile === "string" && providedPathOrFile) {
        setDetecting(true);
        try {
          file = await fileFromPath(providedPathOrFile);
          addStegoLog(`Selected: ${providedPathOrFile}`);
        } catch (e) {
          setDecodeError(`Could not read ${providedPathOrFile}: ${e instanceof Error ? e.message : String(e)}`);
          setDetecting(false);
          return;
        } finally {
          setDetecting(false);
        }
      } else {
        setDetecting(true);
        addStegoLog("Opening file picker...");
        try {
          file = await openImageFile();
        } finally {
          setDetecting(false);
        }
      }
      if (!file) {
        setStatus("Cancelled");
        addStegoLog("File picker cancelled");
        logger.logAction("detect_cancelled", "User cancelled file picker");
        return;
      }
      setDetecting(true);
      setStegoProgress("Reading image file...");
      addStegoLog(`Selected: ${file.name} (${file.size} bytes, type: ${file.type})`);
      logger.logAction("detect_started", "Decoding stego image (browser)", { name: file.name });
      try {
      // Try QIM first for JPEG files, then fall back to Dot
      let result: { ok: boolean; payload?: string; error?: string } = { ok: false };
      const isJpeg = file.type === "image/jpeg" || file.name.toLowerCase().endsWith(".jpg") || file.name.toLowerCase().endsWith(".jpeg");
      if (isJpeg) {
        setStegoProgress("Trying QIM decode (robust)...");
        addStegoLog("Trying QIM steganography decode...");
        try {
          result = await decodeQimImageFile(file, {
            onProgress: (label, attempt, total) => {
              setStegoProgress(`Trying QIM decode (${attempt}/${total}: ${label})...`);
            },
          });
          if (result.ok) {
            addStegoLog(`QIM decode OK! Payload: ${result.payload?.length ?? 0} chars`);
          } else {
            addStegoLog(`QIM decode failed: ${result.error ?? "unknown"}, falling back to Dot...`);
          }
        } catch (qimErr) {
          addStegoLog(`QIM decode error: ${qimErr instanceof Error ? qimErr.message : String(qimErr)}, falling back to Dot...`);
        }
      }
      if (!result.ok) {
        setStegoProgress("Extracting hidden data (Dot decode)...");
        addStegoLog("Running Dot steganography decode...");
        console.log("[App] Starting decodeStegoFile for:", file.name, "size:", file.size);
        result = await decodeStegoFile(file);
        console.log("[App] decodeStegoFile result:", result.ok, "error:", result.error, "payloadLen:", result.payload?.length);
      }
      if (!result.ok || !result.payload) {
        const err = result.error || "Decode failed";
        addStegoLog(`FAIL: ${err}`);
        setDecodeError(err);
        logger.logAction("detect_error", err, { name: file.name });
        return;
      }
      addStegoLog(`Decode OK! Payload: ${result.payload.length} chars`);
        const raw = result.payload;
        console.log("[App] Detected payload type:", raw.startsWith("base64:") ? "base64" : "json", "len:", raw.length);
        let jsonString: string;
        if (raw.startsWith("base64:")) {
          addStegoLog("Decoding base64 payload...");
          const bytes = Uint8Array.from(atob(raw.slice(7)), (c) => c.charCodeAt(0));
          addStegoLog(`Decoded: ${bytes.length} bytes, prefix: ${String.fromCharCode(...bytes.slice(0, 8))}`);
          console.log("[App] Decoded bytes len:", bytes.length, "first 16:", Array.from(bytes.slice(0, 16)));
          console.log("[App] First 8 as string:", String.fromCharCode(...bytes.slice(0, 8)));
          if (!stegoCrypto.isEncryptedPayload(bytes)) {
            addStegoLog("FAIL: Missing STEGSTR1 magic header!");
            console.log("[App] FAIL: bytes don't start with STEGSTR1. Expected:", Array.from(new TextEncoder().encode("STEGSTR1")));
            setDecodeError("Not a Stegstr encrypted image");
            logger.logAction("detect_error", "Not a Stegstr encrypted image", { name: file.name });
            return;
          }
          addStegoLog("STEGSTR1 header found! Decrypting...");
          let keysToTry = identities
            .filter((i) => viewingPubkeys.has(Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex))))
            .map((i) => i.privKeyHex);
          if (keysToTry.length === 0) keysToTry = [effectivePrivKey];
          addStegoLog(`Trying ${keysToTry.length} keys...`);
          let lastErr: Error | null = null;
          jsonString = "";
          for (let ki = 0; ki < keysToTry.length; ki++) {
            const key = keysToTry[ki];
            try {
              addStegoLog(`Trying key ${ki + 1}/${keysToTry.length}...`);
              jsonString = await stegoCrypto.decryptPayload(bytes, key);
              addStegoLog(`Key ${ki + 1} succeeded! JSON len: ${jsonString.length}`);
              lastErr = null;
              break;
            } catch (e) {
              lastErr = e instanceof Error ? e : new Error(String(e));
              addStegoLog(`Key ${ki + 1} failed: ${lastErr.message}`);
            }
          }
          if (!jsonString && lastErr) {
            addStegoLog("All keys failed, trying app-level decrypt...");
            try {
              jsonString = await stegoCrypto.decryptApp(bytes);
              addStegoLog(`App decrypt succeeded! JSON len: ${jsonString.length}`);
              const parsed = JSON.parse(jsonString);
              if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.events)) lastErr = null;
            } catch (e2) {
              addStegoLog(`App decrypt failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
            }
          }
          if (!jsonString) {
            addStegoLog(`FAIL: Decryption failed - ${lastErr?.message || "unknown error"}`);
            throw lastErr ?? new Error("Decryption failed");
          }
          addStegoLog(`Decryption complete, parsing JSON...`);
        } else if (raw.trimStart().startsWith("{")) {
          jsonString = raw;
        } else {
          setDecodeError("Invalid payload");
          return;
        }
        // A pointer image decrypts to a pointer, not a bundle; fetch what it
        // names before anything downstream can treat it as content.
        jsonString = await followPointerIfAny(
          jsonString, effectivePrivKey, addStegoLog, networkEnabled,
          () => setNetworkEnabled(true),
        );
        const bundle = JSON.parse(jsonString) as NostrStateBundle;
        if (!Array.isArray(bundle.events)) {
          setDecodeError("Invalid payload");
          return;
        }
        const normalized = bundle.events.map((e) => ({
          ...e,
          kind: typeof e.kind === "number" ? e.kind : parseInt(String(e.kind), 10) || 1,
          created_at: typeof e.created_at === "number" ? e.created_at : Math.floor(Date.now() / 1000),
        }));
        // Classify before showing anything: signature validity, whether the
        // author is followed, and whether it is already held locally. The
        // previous code merged everything unconditionally and reported only a
        // count, so the user never saw what an image actually contained.
        const knownIds = new Set(events.map((ev) => ev.id));
        // Derived from the same `events` snapshot as knownIds, so the two
        // always agree. A note you deleted is still physically present (delete
        // writes a kind-5 tombstone and keeps the note), but it is not one you
        // "already have" in any sense the user would recognise -- counting it
        // as a duplicate would hide it from the review and make restoring it
        // from an image impossible.
        const tombstonedIds = new Set(
          events
            .filter((e) => e.kind === 5 && selfPubkeys.includes(e.pubkey))
            .flatMap((e) => e.tags.filter((t) => t[0] === "e").map((t) => t[1])),
        );
        // Held locally but NOT currently displayable: a note authored by one
        // of your own identities is hidden by the feed filter unless you are
        // viewing as that identity or its id is in importedEventIds. Calling
        // such an event a duplicate tells the user "you already have
        // everything" about something they cannot see, and leaves them no way
        // to make it appear -- which is exactly what happened after
        // importedEventIds turned out not to survive a reload. Accepting it
        // re-adds the id and makes it visible, so it must be offered.
        const hiddenLocally = (ev: { id: string; pubkey: string }) =>
          isLocallyHidden(ev, ourPubkeysSet, viewingPubkeys, importedEventIds);
        const classified: DetectedEvent[] = normalized.map((ev) => ({
          ...ev,
          verified: verifyEvent(ev as never),
          // Own notes count as trusted: re-importing your own feed from an
          // image you made should not require ticking each item.
          followed: contactsSet.has(ev.pubkey) || viewingPubkeys.has(ev.pubkey),
          duplicate: knownIds.has(ev.id) && !tombstonedIds.has(ev.id) && !hiddenLocally(ev),
        }));
        const badCount = classified.filter((ev) => !ev.verified).length;
        if (badCount > 0) {
          addStegoLog(`WARNING: ${badCount} event(s) failed signature verification; withheld`);
        }
        setDetectReview({ events: classified, bytes: 0, name: file.name });
        const profileUpdates: Record<string, ProfileData> = {};
        bundle.events.filter((e) => e.kind === 0).forEach((e) => {
          try {
            const c = JSON.parse(e.content) as { name?: string; display_name?: string; about?: string; picture?: string; banner?: string; nip05?: string };
            profileUpdates[e.pubkey] = { name: c.name ?? c.display_name, about: c.about, picture: c.picture, banner: c.banner, nip05: c.nip05 };
          } catch (_) {}
        });
        if (Object.keys(profileUpdates).length > 0) setProfiles((p) => ({ ...p, ...profileUpdates }));
        setImportedEventIds((prev) => {
          const next = new Set(prev);
          bundle.events.forEach((e) => next.add(e.id));
          if (next.size > 2000) return new Set([...next].slice(-2000));
          return next;
        });
        setDecodeError("");
        setStatus(`Loaded ${bundle.events.length} events from image.`);
        addStegoLog(`SUCCESS - Loaded ${bundle.events.length} events!`);
        logger.logAction("detect_completed", `Loaded ${bundle.events.length} events`, { name: file.name, eventCount: bundle.events.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[App] Detect error:", e);
        setDecodeError(msg);
        logger.logAction("detect_error", msg, { name: file.name });
      } finally {
        setDetecting(false);
        setStegoProgress("");
      }
      return;
    }
  }, [effectivePrivKey, identities, viewingPubkeys, addStegoLog, networkEnabled]);

  useEffect(() => {
    if (isWeb()) return;
    let unlisten: (() => void) | null = null;
    getTauri()
      .then((t) => t.getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths?.length) {
          handleLoadFromImage(event.payload.paths[0]);
        }
      }))
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, [handleLoadFromImage]);

  const handleSaveToImage = useCallback(() => {
    setDecodeError("");
    setStegoLogs([]);
    setEmbedCoverFile(null);
    setEmbedModalOpen(true);
  }, []);

  const handleDetectFromExchange = useCallback(async () => {
    if (isWeb()) return;
    try {
      const tauri = await getTauri();
      const path = await tauri.invoke<string>("get_exchange_path");
      handleLoadFromImage(path);
    } catch (e) {
      setDecodeError(e instanceof Error ? e.message : String(e));
    }
  }, [handleLoadFromImage]);

  const handleEmbedToExchange = useCallback(async () => {
    if (isWeb() || !profile) return;
    setDecodeError("");
    setDetecting(true);
    logger.logAction("embed_started", "Embed to exchange (quick test)", { eventCount: events.length });
    try {
      const tauri = await getTauri();
      const coverPath = await tauri.openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (!coverPath || typeof coverPath !== "string") {
        setDetecting(false);
        return;
      }
      const outputPath = await tauri.invoke<string>("get_exchange_path");
      const bundle: NostrStateBundle = { version: STEGSTR_BUNDLE_VERSION, events };
      const jsonString = JSON.stringify(bundle);
      const encrypted = await stegoCrypto.encryptOpen(jsonString);
      const payloadToEmbed = "base64:" + uint8ArrayToBase64(encrypted);
      const cmd = "encode_stego_dot";
      const result = await tauri.invoke<{ ok: boolean; path?: string; error?: string }>(cmd, {
        coverPath,
        outputPath,
        payload: payloadToEmbed,
      });
      if (result.ok && result.path) {
        try {
          const isPng = await tauri.invoke<boolean>("check_png_signature", { path: result.path });
          addStegoLog(`PNG signature check: ${isPng ? "OK" : "FAIL"}`);
        } catch (e) {
          addStegoLog(`PNG signature check error: ${e instanceof Error ? e.message : String(e)}`);
        }
        addStegoLog(`Saved to: ${result.path}`);
        setStatus(`Saved to exchange. B can click Detect from exchange.`);
        logger.logAction("embed_completed", "Embed to exchange done", { path: result.path, eventCount: events.length });
      } else {
        setDecodeError(result.error || "Encode failed");
      }
    } catch (e) {
      setDecodeError(e instanceof Error ? e.message : String(e));
      logger.logError("Embed to exchange failed", e, {});
    } finally {
      setDetecting(false);
    }
  }, [profile, events, embedMethod]);

  const handleEmbedConfirm = useCallback(async () => {
    if (!embedModalOpen) return;
    setDecodeError("");
    setEmbedding(true);
    setStegoProgress("Preparing data...");
    addStegoLog("Starting embed flow...");
    logger.logAction("embed_started", "Starting embed flow", { eventCount: events.length });
    try {
      // One embed path for both platforms.
      //
      // The desktop branch removed here was the legacy Dot/PNG flow: it never
      // used QIM at all, so the desktop build could only produce images that
      // survive no chat app -- the exact failure this project exists to fix.
      // The QIM Rust command it would have needed shells out to a Python
      // script resolved through the BUILD machine's path, so that route could
      // not have worked either.
      //
      // The webview provides OffscreenCanvas, so the TypeScript encoder -- the
      // one every platform measurement was made against -- runs here unchanged.
      // Only saving differs, and platform-web handles that.
      {
        if (!embedCoverFile) {
          setDecodeError("Choose an image first.");
          setEmbedding(false);
          addStegoLog("Error: No image selected");
          return;
        }
        addStegoLog(`Cover image: ${embedCoverFile.name} (${embedCoverFile.size} bytes)`);
        const pubkeysInEmbed = new Set(events.flatMap((e) => [e.pubkey, ...e.tags.filter((t) => t[0] === "p").map((t) => t[1])]));
        const kind0InEvents = new Set(events.filter((e) => e.kind === 0).map((e) => e.pubkey));
        const syntheticKind0: NostrEvent[] = [];
        for (const pk of pubkeysInEmbed) {
          if (!pk || kind0InEvents.has(pk)) continue;
          const idForPk = identities.find((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === pk);
          if (!idForPk) continue;
          const prof = profiles[pk];
          if (!prof) continue;
          try {
            const content = JSON.stringify(prof);
            const ev = await Nostr.finishEventAsync(
              { kind: 0, content, tags: [], created_at: Math.floor(Date.now() / 1000) },
              Nostr.hexToBytes(idForPk.privKeyHex)
            );
            syntheticKind0.push(ev as NostrEvent);
          } catch (_) {}
        }
        const buildBundle = async (eventList: NostrEvent[]) => {
          // Who needs a profile, and whether we can sign one or must carry
          // theirs as-is. See profilesToCarry for the gap this closes.
          const ownPubkeys = new Set(
            identities.map((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex))),
          );
          const { synthesise, borrow } = profilesToCarry(eventList, events, ownPubkeys);

          const synthetic: NostrEvent[] = [];
          for (const pk of synthesise) {
            const idForPk = identities.find(
              (i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === pk,
            );
            const prof = idForPk && profiles[pk];
            if (!idForPk || !prof) continue;
            try {
              const ev = await Nostr.finishEventAsync(
                {
                  kind: 0,
                  content: JSON.stringify(prof),
                  tags: [],
                  created_at: Math.floor(Date.now() / 1000),
                },
                Nostr.hexToBytes(idForPk.privKeyHex),
              );
              synthetic.push(ev as NostrEvent);
            } catch (_) {}
          }
          return {
            version: STEGSTR_BUNDLE_VERSION,
            events: [...synthetic, ...borrow, ...eventList],
          } as NostrStateBundle;
        };
        // One eligibility rule, shared with the "Pick specific notes" list --
        // see embed-candidates.ts for why it lives there and what the two
        // divergent copies used to do.
        const embedCandidatesAll = eligibleToCarry(events, candidateCtx);
        // An explicit selection overrides priority packing entirely. Profiles
        // are still added by buildBundle -- including a followed author's own
        // kind-0, which it now carries rather than dropping -- so the recipient
        // can still tell whose words these are. What is dropped is everything
        // the user did not ask for.
        const embedCandidates = embedNoteIds
          ? embedCandidatesAll.filter((e) => embedNoteIds.includes(e.id))
          : embedCandidatesAll;
        if (embedNoteIds) {
          addStegoLog(`Carrying ${embedCandidates.length} selected note(s) only.`);
          // Distinct from "you have nothing to embed": the user chose an empty
          // set, so telling them to post a note first would be wrong.
          if (embedCandidates.length === 0) {
            setDecodeError("No notes selected — pick at least one, or switch to carrying your feed.");
            addStegoLog("Embed cancelled: explicit selection was empty.");
            setEmbedding(false);
            setStegoProgress("");
            return;
          }
        }

        // Helper: choose which events to carry, then encrypt to fit capacity.
        //
        // This previously took the whole event list, encrypted it, and on
        // overflow dropped the LAST event and re-encrypted -- looping one event
        // at a time. Two problems: "last in the array" is an arbitrary
        // selection rule, and a 500-event feed that fits 50 ran ~450 full
        // encryption passes.
        //
        // Now selection happens first, by usefulness per byte (own notes,
        // followed authors, profiles and relay lists weighted up; recency
        // decaying; replies whose parent did not fit are dropped so threads
        // stay readable). Any residual overflow is closed by binary search, so
        // the worst case is log n encryptions rather than n.
        const encryptEvents = async (list: NostrEvent[]) => {
          const bundle = await buildBundle(list);
          const jsonString = JSON.stringify(bundle);
          if (embedRecipientMode === "recipients" && embedRecipients.length > 0 && effectivePrivKey) {
            const selfPk = Nostr.getPublicKey(Nostr.hexToBytes(effectivePrivKey));
            const allRecipients = Array.from(new Set([selfPk, ...embedRecipients]));
            return stegoCrypto.encryptForRecipients(jsonString, effectivePrivKey, allRecipients);
          }
          return stegoCrypto.encryptOpen(jsonString);
        };

        const encryptAndFit = async (maxPayloadBytes: number): Promise<{ encrypted: Uint8Array; events: NostrEvent[] } | null> => {
          if (!maxPayloadBytes) {
            const enc = await encryptEvents(embedCandidates);
            addStegoLog(`Encrypted: ${enc.length} bytes (${embedCandidates.length} events, no cap)`);
            return { encrypted: enc, events: embedCandidates };
          }

          // The budget applies to the ENCRYPTED payload. stego-crypto does not
          // compress -- AES-GCM output tracks the plaintext size -- so the
          // packer must be told not to assume deflate. It defaults to 0.35,
          // which over-estimates capacity by ~3x and produced "payload too
          // large" failures on small covers.
          //
          // ratio 1.05 covers the JSON plus the encryption envelope (magic, IV,
          // GCM tag, and any per-recipient key wrapping). The binary search
          // below closes whatever this estimate gets wrong.
          const packed = packForCapacity(embedCandidates, {
            budget: Math.floor(maxPayloadBytes * 0.85),
            compressionRatio: 1.05,
            self: effectivePrivKey
              ? Nostr.getPublicKey(Nostr.hexToBytes(effectivePrivKey))
              : undefined,
            follows: contactsSet,
          });
          addStegoLog(
            `Selected ${packed.events.length}/${embedCandidates.length} events by priority` +
            (packed.droppedOrphans ? `, dropped ${packed.droppedOrphans} orphan replies` : "") +
            ` (~${packed.estimatedBytes}B est, ${maxPayloadBytes}B budget)`,
          );

          let best: Uint8Array | null = null;
          let bestCount = 0;
          let lo = 0;
          let hi = packed.events.length;
          const attempt = async (n: number) => {
            const enc = await encryptEvents(packed.events.slice(0, n));
            addStegoLog(`  try ${n} events -> ${enc.length}B ${enc.length <= maxPayloadBytes ? "fits" : "over"}`);
            return enc;
          };

          const full = await attempt(hi);
          if (full.length <= maxPayloadBytes) {
            best = full;
            bestCount = hi;
          } else {
            while (lo < hi) {
              const mid = Math.floor((lo + hi + 1) / 2);
              const enc = await attempt(mid);
              if (enc.length <= maxPayloadBytes) { best = enc; bestCount = mid; lo = mid; }
              else { hi = mid - 1; }
            }
          }

          if (!best) {
            // Even an empty bundle exceeds capacity: the encryption envelope
            // alone does not fit. Report the actual numbers rather than a bare
            // "payload too large" from deep inside the encoder.
            const empty = await encryptEvents([]);
            addStegoLog(
              `Cover too small: envelope alone is ${empty.length}B, ` +
              `capacity is ${maxPayloadBytes}B. Use a larger cover image.`,
            );
            // Point at the 4096 profile when they are not already on it.
            // "Try a larger photo" is only half the answer: the target
            // platform caps the size far below what X/Twitter and a WhatsApp
            // HD send actually carry, both verified end to end at ~25 KB
            // against 3.9 KB at 1600.
            const targetWidth = profileFor(targetPlatform).width;
            const canGoBigger = (targetWidth || Infinity) < 4096;
            setDecodeError(
              `This image is too small. It holds about ${Math.floor(maxPayloadBytes / 1024)} KB, ` +
              `but the encrypted bundle needs at least ${Math.ceil(empty.length / 1024)} KB. ` +
              (canGoBigger
                ? `Try a larger photo — or switch the target to "Large (4096px)", which carries ` +
                  `about 6x as much and is verified through X/Twitter and WhatsApp with HD on.`
                : `Try a larger photo, or turn on "Send a link instead" to carry a ~260-byte pointer.`),
            );
            return null;
          }
          if (bestCount < embedCandidates.length) {
            addStegoLog(`Carrying ${bestCount}/${embedCandidates.length} events (${best.length}B of ${maxPayloadBytes}B)`);
          }
          addStegoLog(`Encrypted: ${best.length} bytes`);
          return { encrypted: best, events: packed.events.slice(0, bestCount) };
        };

        if (embedMethod === "qim") {
          // ===== QIM BRANCH =====
          addStegoLog(`Using QIM method (target platform: ${targetPlatform})`);

          // Step 1: Pre-resize cover for platform
          setStegoProgress("Pre-resizing image for target platform...");
          const platformProfile = profileFor(targetPlatform);
          const platformWidth = platformProfile.width;
          let resizedCover: File;
          try {
            resizedCover = await resizeCoverForPlatform(
              embedCoverFile, platformWidth, platformProfile.square,
            );
            addStegoLog(
              `Resized cover: ${resizedCover.name} (${resizedCover.size} bytes)` +
              (platformProfile.square ? " [square: platform normalises to 1:1]" : ""),
            );
          } catch (e) {
            setDecodeError(`Resize failed: ${e instanceof Error ? e.message : String(e)}`);
            setEmbedding(false);
            return;
          }

          // Step 2: Check QIM capacity
          const { capacityBytes: maxPayloadBytes, width: resW, height: resH } = await getQimCapacityForFile(embedCoverFile, targetPlatform);
          addStegoLog(`QIM capacity: ${maxPayloadBytes} bytes (${resW}x${resH})`);

          // A cover smaller than the target keeps its own size, and that is a
          // silent failure waiting to happen.
          //
          // coverGeometry only ever DOWNSCALES -- the resize is gated on
          // `w > targetWidth` -- so aiming a 1024px photo at telegram_photo
          // ships it at 1024, and Telegram resamples every photo to 1280x960
          // on arrival. Resampling moves the 8x8 grid, which destroys the
          // payload (§3.1). The self-test cannot catch it: it verifies the
          // file as written, not as the platform hands it back, so everything
          // looks fine right up until the recipient sees nothing.
          if (platformWidth > 0) {
            const wantW = platformWidth;
            const wantH = platformProfile.square ? platformWidth : null;
            if (resW !== wantW || (wantH !== null && resH !== wantH)) {
              const want = wantH ? `${wantW}x${wantH}` : `${wantW}px wide`;
              addStegoLog(
                `WARNING: cover produced ${resW}x${resH}, but ${targetPlatform} expects ${want}. ` +
                `Photos are never enlarged, so a small cover keeps its own size and the platform ` +
                `may resize it on arrival — which destroys the hidden data.`,
              );
              setStatus(
                `Heads up: this photo is smaller than ${targetPlatform} expects (${resW}x${resH} ` +
                `vs ${want}). It may still work, but a photo at least ${wantW}px wide is much safer.`,
              );
            }
          }

          // ===== POINTER TIER (§10.4) =====
          //
          // Publish the feed to a relay as an encrypted blob and embed only a
          // ~200-byte pointer to it. The reason this exists: every channel
          // measurement says the artifact is driven by delta x payload, delta
          // is pinned from below by what the channel does to the image, so
          // payload is the only lever left -- and nothing beats not sending
          // the bytes.
          //
          // This runs before the fit machinery rather than through it, and
          // that is deliberate. The whole selection-and-binary-search
          // apparatus below exists to answer "how much of the feed fits in
          // this cover", and in pointer mode the answer is "all of it": the
          // embedded payload is a fixed size regardless of how many events the
          // blob holds. Worse, re-encrypting per search attempt would mint a
          // NEW blob event each time, so the image would end up pointing at an
          // event id that was never published.
          if (embedPointerMode) {
            // Checked before any work, because pointer mode is the one embed
            // path that cannot function offline -- the content goes to a relay
            // by definition. Reaching the publish step with the network toggle
            // off produces "no relay accepted the blob", which is true but
            // reads as a relay problem and sends the user to check their relay
            // list instead of the switch that is actually off.
            if (!networkEnabled) {
              setDecodeError(
                "Pointer mode sends your feed to a relay, so it needs the network — and Network is " +
                "currently off. Turn it on, or untick “Send a link instead of the content” to embed " +
                "everything in the image, which works offline.",
              );
              addStegoLog("Embed cancelled: pointer mode requires the network, which is disabled.");
              setEmbedding(false);
              setStegoProgress("");
              return;
            }
            if (!effectivePrivKey) {
              setDecodeError("Pointer mode needs a signing key — log in with an identity first.");
              setEmbedding(false);
              setStegoProgress("");
              return;
            }
            if (embedCandidates.length === 0) {
              setDecodeError("There is nothing to embed yet — post a note or follow someone first.");
              addStegoLog("Embed cancelled: no events to carry.");
              setEmbedding(false);
              setStegoProgress("");
              return;
            }

            // No capacity packing: the blob lives on a relay, not in the
            // image, so the cover's size stops being the constraint on how
            // much of the feed travels.
            setStegoProgress("Building pointer payload...");
            const bundle = await buildBundle(embedCandidates);
            const bundleJson = JSON.stringify(bundle);
            const relayUrls = await getRelayUrls();
            const built = await buildPointer({
              bundleJson,
              privKeyHex: effectivePrivKey,
              relays: relayUrls,
              recipients:
                embedRecipientMode === "recipients" && embedRecipients.length > 0
                  ? embedRecipients
                  : undefined,
            });
            addStegoLog(
              `Pointer mode: ${embedCandidates.length} events -> ${bundleJson.length}B bundle on relay, ` +
              `${built.pointerBytes.length}B in the image` +
              (built.droppedHints ? ` (${built.droppedHints} relay hint(s) trimmed to fit)` : ""),
            );

            // Publish BEFORE encoding. If the blob never lands, the image is
            // worthless, and finding that out after the user has already sent
            // it is the worst possible ordering -- every stego-side indicator
            // would read success.
            setStegoProgress("Publishing hidden content to relays...");
            const { accepted, failed } = await publishAndConfirm(built.event, relayUrls);
            if (accepted.length === 0) {
              const why = Object.entries(failed).map(([u, m]) => `${u}: ${m}`).join("; ");
              setDecodeError(
                "Pointer mode could not publish the hidden content to any relay, so the image " +
                "would have pointed at nothing. Check your connection or relay list and try again" +
                (why ? `. Relays said — ${why}` : "."),
              );
              addStegoLog(`Embed cancelled: no relay accepted the blob. ${why}`);
              setEmbedding(false);
              setStegoProgress("");
              return;
            }
            addStegoLog(`Blob accepted by ${accepted.length} relay(s): ${accepted.join(", ")}`);

            setStegoProgress("Embedding pointer into image...");
            let pointerBlob: Blob;
            try {
              pointerBlob = await encodeQimImageFile(resizedCover, built.pointerBytes, {
                platform: targetPlatform,
                ...(embedSlotOrder === "profile" ? {} : { slotOrder: embedSlotOrder }),
              });
            } catch (e) {
              setDecodeError(`Encode failed: ${e instanceof Error ? e.message : String(e)}`);
              setEmbedding(false);
              setStegoProgress("");
              return;
            }
            const st = await qimSelfTest(pointerBlob, built.pointerBytes);
            addStegoLog(`Pointer self-test ${st.ok ? "PASSED" : `FAILED (${st.error})`}`);
            if (!st.ok) {
              // There is no smaller payload to fall back to -- a pointer is
              // already the floor. So this is the cover or the platform step,
              // and saying so is more useful than a retry that cannot differ.
              setDecodeError(
                `Even a ${built.pointerBytes.length}-byte pointer does not survive read-back on this cover ` +
                `at the ${targetPlatform} settings${st.error ? ` (${st.error})` : ""}. A pointer is the smallest ` +
                `payload Stegstr can send, so this is the cover, not the amount of data: try a larger or more ` +
                `textured photo. Flat images (logos, screenshots, plain walls) have no texture to hide in.`,
              );
              addStegoLog("Embed cancelled: pointer does not survive self-test on this cover.");
              setEmbedding(false);
              setStegoProgress("");
              return;
            }

            const ptrName = embedCoverFile.name.replace(/\.[^.]+$/, "") || "image";
            // The ordering goes in the filename. Every platform renames
            // uploads, so with four variants in flight (2 platforms x 2
            // orderings) there is otherwise no way to tell which returned file
            // came from which setting -- the same problem §10.5 hit.
            const ptrOrderTag = embedSlotOrder === "profile" ? "" : `-${embedSlotOrder}`;
            const ptrOutName = `${ptrName}-stegstr-${targetPlatform}-ptr${ptrOrderTag}.jpg`;
            setStegoProgress("Downloading embedded image...");
            const ptrSaved = await saveBlob(pointerBlob, ptrOutName);
            if (ptrSaved === null && !isWeb()) {
              addStegoLog("Save cancelled.");
              setEmbedding(false);
              setStegoProgress("");
              return;
            }
            addStegoLog(ptrSaved ? `Saved to ${ptrSaved}` : `Triggering download: ${ptrOutName}`);
            setEmbedModalOpen(false);
            setEmbedCoverFile(null);
            setEmbedding(false);
            setStegoProgress("");
            setStatus(
              `Image downloaded. It carries a ${built.pointerBytes.length}-byte pointer to ` +
              `${embedCandidates.length} events held on ${accepted.length} relay(s) — the recipient needs to be online to read it.`,
            );
            logger.logAction("embed_completed", "QIM pointer embed saved", {
              eventCount: embedCandidates.length,
              platform: targetPlatform,
              pointerBytes: built.pointerBytes.length,
              relays: accepted.length,
            });
            return;
          }

          // Step 3: Encrypt and fit payload
          const fitted = await encryptAndFit(maxPayloadBytes);
          if (!fitted) {
            setDecodeError("Image too small for stego payload (try a larger image or fewer events)");
            setEmbedding(false);
            return;
          }
          const fittedEvents = fitted.events;

          // Step 4+5: Encode and self-test. The byte-capacity check above
          // only bounds theoretical bit capacity -- whether a given payload
          // actually survives QIM extraction (real texture, RS parity,
          // erasure margins) can only be answered by really encoding and
          // reading it back. When the full selection doesn't survive, binary
          // search down to the largest event count that does, instead of
          // just failing and telling the user to go guess a smaller size
          // themselves.
          type EncodeAttempt = {
            ok: boolean; n: number; blob?: Blob; error?: string;
            /** Set when the carried note's content was cut to make it fit. */
            truncatedTo?: number;
            /** Length of that note before it was cut, for the summary line. */
            originalChars?: number;
          };
          const encodeAndVerify = async (
            list: NostrEvent[], label: string, extra?: Partial<EncodeAttempt>,
          ): Promise<EncodeAttempt> => {
            const enc = await encryptEvents(list);
            setStegoProgress(`Embedding and verifying (${label})...`);
            let blob: Blob;
            try {
              blob = await encodeQimImageFile(resizedCover, enc, {
                platform: targetPlatform,
                ...(embedSlotOrder === "profile" ? {} : { slotOrder: embedSlotOrder }),
              });
            } catch (e) {
              const error = `encode failed: ${e instanceof Error ? e.message : String(e)}`;
              addStegoLog(`  ${label} -> ${error}`);
              return { ok: false, n: list.length, error, ...extra };
            }
            const st = await qimSelfTest(blob, enc);
            addStegoLog(`  ${label} -> self-test ${st.ok ? "PASSED" : `FAILED (${st.error})`}`);
            return st.ok
              ? { ok: true, n: list.length, blob, ...extra }
              : { ok: false, n: list.length, error: st.error, ...extra };
          };
          const tryEncode = (n: number) =>
            encodeAndVerify(fittedEvents.slice(0, n), `${n} event${n === 1 ? "" : "s"}`);

          // Only a genuinely empty candidate pool means "you have nothing to
          // embed". An empty packed selection means something quite different
          // -- your content did not FIT -- and reporting that as "post a note
          // first" while a note sits on screen is simply wrong. It became easy
          // to hit once §13.5 cut the capacity estimate ~4x: notes that used
          // to be packed no longer are.
          if (embedCandidates.length === 0) {
            setDecodeError("There is nothing to embed yet — post a note or follow someone first.");
            addStegoLog("Embed cancelled: no events to carry.");
            setEmbedding(false);
            setStegoProgress("");
            return;
          }

          addStegoLog("Running QIM steganography encode...");
          // NOTE: the search floor is 1, not 0. An empty bundle always passes
          // self-test (it is a bare encryption envelope, a few hundred bytes),
          // so including 0 in the search made "shrink until it survives"
          // silently succeed with an image carrying nothing -- it decoded
          // cleanly and reported "0 new items". An image with no content is a
          // failure, not a smaller success. Same reason the whole-event search
          // is skipped entirely when nothing was packed: tryEncode(0) would
          // "succeed" and ship an empty image.
          let best: EncodeAttempt | null = null;
          let lastError: string | undefined;
          if (fittedEvents.length > 0) {
            const fullAttempt = await tryEncode(fittedEvents.length);
            lastError = fullAttempt.error;
            if (fullAttempt.ok) {
              best = fullAttempt;
            } else if (fittedEvents.length > 1) {
              addStegoLog("Full selection did not survive self-test; searching for the largest count that does...");
              let lo = 1, hi = fittedEvents.length - 1;
              while (lo <= hi) {
                const mid = Math.floor((lo + hi) / 2);
                const attempt = await tryEncode(mid);
                if (attempt.ok) { best = attempt; lo = mid + 1; } else { hi = mid - 1; }
              }
            }
          } else {
            addStegoLog(
              `Nothing fit the ${maxPayloadBytes}B budget whole; trying a shortened copy of your latest note...`,
            );
          }

          // Fallback: a single note too long for the cover. Rather than
          // carrying nothing, carry as much of it as fits. Only for notes we
          // can re-sign -- content is covered by the event id and signature,
          // so a cut note has to be re-signed with the author's key or it
          // fails verifyEvent on the far side. That is fine for the user's own
          // notes and impossible for anyone else's; re-signing someone else's
          // altered words under a different key would attribute text to them
          // they never wrote, so those are left whole and simply dropped.
          if (!best) {
            // When packing produced nothing at all, fall back to the newest of
            // your own notes -- that is precisely the case this exists for: one
            // note too long for the cover, which would otherwise report failure
            // while sitting visible on screen.
            const head = fittedEvents[0] ?? [...embedCandidates]
              .filter((e) => e.kind === 1 && ourPubkeysSet.has(e.pubkey))
              .sort((a, b) => b.created_at - a.created_at)[0];
            const ownIdentity = head && identities.find(
              (i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === head.pubkey,
            );
            if (head && head.kind === 1 && ownIdentity && head.content.length > TRUNCATE_MIN_CHARS) {
              addStegoLog(`No whole-event count fits; trying to carry a shortened copy of your note (${head.content.length} chars)...`);
              const sk = Nostr.hexToBytes(ownIdentity.privKeyHex);
              const tryTruncated = async (chars: number): Promise<EncodeAttempt> => {
                const content = head.content.slice(0, chars).trimEnd() + TRUNCATE_MARKER;
                const ev = await Nostr.finishEventAsync(
                  { kind: head.kind, content, tags: head.tags, created_at: head.created_at },
                  sk,
                ) as NostrEvent;
                return encodeAndVerify([ev], `note cut to ${chars} chars`, {
                  truncatedTo: chars, originalChars: head.content.length,
                });
              };
              // `hi` is already known to fail (that was the whole-note
              // attempt), `lo` is the shortest worth carrying. Converging to
              // within TRUNCATE_MIN_CHARS keeps this to ~6 encodes rather
              // than one per character.
              let lo = TRUNCATE_MIN_CHARS, hi = head.content.length;
              const first = await tryTruncated(lo);
              if (first.ok) {
                best = first;
                while (hi - lo > TRUNCATE_MIN_CHARS) {
                  const mid = Math.floor((lo + hi) / 2);
                  const attempt = await tryTruncated(mid);
                  if (attempt.ok) { best = attempt; lo = mid; } else { hi = mid; }
                }
              }
            }
          }

          if (!best) {
            // Nothing survives read-back on this cover -- not the full
            // selection, not a single event, not even a shortened note. Size
            // is ruled out, so it is the cover (too flat to hide data in) or
            // the platform step size.
            setDecodeError(
              `This cover image cannot reliably carry your feed at the ${targetPlatform} settings ` +
              `(holds about ${maxPayloadBytes} bytes${lastError ? `; ${lastError}` : ""}). Try a larger or ` +
              `more textured photo, a platform with a bigger canvas (Facebook 2048px, or Telegram sent ` +
              `as a file), or the Dot method.`,
            );
            addStegoLog("Embed cancelled: nothing survives self-test on this cover.");
            setEmbedding(false);
            setStegoProgress("");
            return;
          }
          const blob = best.blob!;
          addStegoLog(`QIM encode complete! Output: ${blob.size} bytes JPEG`);
          if (best.truncatedTo !== undefined) {
            addStegoLog(`Carrying 1 note, shortened to ${best.truncatedTo} of ${best.originalChars ?? "?"} characters to fit.`);
            setStatus(`Note was too long for this image — carried the first ${best.truncatedTo} characters.`);
          } else if (best.n < fittedEvents.length) {
            addStegoLog(`Self-test required trimming to ${best.n}/${fittedEvents.length} events to survive reliably.`);
          } else {
            addStegoLog("Self-test PASSED! Payload survives encode/decode round-trip.");
          }

          // Step 6: Download
          const name = embedCoverFile.name.replace(/\.[^.]+$/, "") || "image";
          setStegoProgress("Downloading embedded image...");
          // Include the target platform in the filename. Every platform renames
          // uploads on the way out, so without this there is no way to tell
          // which settings produced a returned image -- which matters whenever
          // more than one configuration is being compared.
          const orderTag = embedSlotOrder === "profile" ? "" : `-${embedSlotOrder}`;
          const outName = `${name}-stegstr-${targetPlatform}${orderTag}.jpg`;
          const savedPath = await saveBlob(blob, outName);
          if (savedPath === null && !isWeb()) {
            addStegoLog("Save cancelled.");
            setEmbedding(false);
            setStegoProgress("");
            return;
          }
          addStegoLog(savedPath ? `Saved to ${savedPath}` : `Triggering download: ${outName}`);
          setEmbedModalOpen(false);
          setEmbedCoverFile(null);
          setEmbedding(false);
          setStegoProgress("");
          setStatus(isWeb() ? "Image downloaded. Save it from your Downloads folder." : "Image saved.");
          logger.logAction("embed_completed", "QIM embed saved (browser download)", { eventCount: events.length, platform: targetPlatform });
          return;
        }

        // ===== DOT BRANCH (legacy) =====
        const maxPayloadBytes = await getDotCapacityForFile(embedCoverFile);
        addStegoLog(`Dot capacity: ${maxPayloadBytes} bytes`);
        const fitted = await encryptAndFit(maxPayloadBytes);
        if (!fitted) {
          setDecodeError("Image too small for stego payload");
          setEmbedding(false);
          return;
        }
        const payloadToEmbed = "base64:" + uint8ArrayToBase64(fitted.encrypted);
        setStegoProgress("Embedding data into image (Dot encode)...");
        addStegoLog("Running Dot steganography encode...");
        const blob = await encodeStegoToBlob(embedCoverFile, payloadToEmbed);
        addStegoLog(`Dot encode complete! Output: ${blob.size} bytes PNG`);
        const name = embedCoverFile.name.replace(/\.[^.]+$/, "") || "image";
        setStegoProgress("Downloading embedded image...");
        const dotSaved = await saveBlob(blob, `${name}-stegstr.png`);
        if (dotSaved === null && !isWeb()) {
          addStegoLog("Save cancelled.");
          setEmbedding(false);
          setStegoProgress("");
          return;
        }
        addStegoLog(dotSaved ? `Saved to ${dotSaved}` : "Download started");
        setEmbedModalOpen(false);
        setEmbedCoverFile(null);
        setEmbedding(false);
        setStegoProgress("");
        setStatus(isWeb() ? "Image downloaded. Save it from your Downloads folder." : "Image saved.");
        logger.logAction("embed_completed", "Dot embed saved (browser download)", { eventCount: events.length });
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[App] Embed error:", e);
      setDecodeError(msg);
      logger.logError("Embed failed", e, {});
      setEmbedModalOpen(false);
    } finally {
      setEmbedding(false);
      setStegoProgress("");
    }
  }, [embedModalOpen, embedCoverFile, events, profiles, identities, addStegoLog, embedRecipientMode, embedRecipients, embedPointerMode, embedSlotOrder, embedNoteIds, networkEnabled, effectivePrivKey, embedMethod, targetPlatform]);

  const resolvePubkeyFromInput = useCallback((input: string): string | null => {
    const s = input.trim().replace(/\s/g, "");
    const npubMatch = s.match(/npub1[a-zA-Z0-9]+/i);
    if (npubMatch) {
      try {
        const decoded = Nostr.nip19.decode(npubMatch[0]);
        if (decoded.type === "npub") return Nostr.bytesToHex(decoded.data);
      } catch (_) {}
    }
    if (/^[a-fA-F0-9]{64}$/.test(s)) return s.toLowerCase();
    return null;
  }, []);

  const handleSendDm = useCallback(
    async (theirPubkeyHex: string, content: string) => {
      if (!effectivePrivKey || !content.trim()) return;
      try {
        const encrypted = await Nostr.nip04Encrypt(content.trim(), effectivePrivKey, theirPubkeyHex);
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const ev = await Nostr.finishEventAsync(
          {
            kind: 4,
            content: encrypted,
            tags: [["p", theirPubkeyHex]],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        setDmReplyContent("");
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Message sent");
        logger.logAction("dm_send", "DM sent", { to: theirPubkeyHex.slice(0, 8) + "…", networkEnabled });
      } catch (e) {
        setStatus("Send failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("DM send failed", e, { to: theirPubkeyHex.slice(0, 8) + "…" });
      }
    },
    [effectivePrivKey, networkEnabled, canPublishToNetwork]
  );

  const handlePost = useCallback(async () => {
    if (!effectivePrivKey) return;
    const textPart = newPost.trim();
    // Each attachment becomes one token carrying its URL and key. The key
    // never reaches the host, and the note itself is encrypted inside the
    // stego image, so the token is only readable by whoever you send it to.
    const mediaPart = postAttachments.length
      ? "\n" + postAttachments.map(attachmentToToken).join("\n")
      : "";
    if (!textPart && !postAttachments.length) return;
    const sk = Nostr.hexToBytes(effectivePrivKey);
    const content = ensureStegstrSuffix((textPart || " ") + mediaPart);
    // No "im" tags: those advertise a public image URL to other clients, and
    // these blobs are encrypted -- a client that fetched one would render
    // noise, and it would leak which server holds it.
    const tags: string[][] = [];
    const ev = await Nostr.finishEventAsync(
      {
        kind: 1,
        content,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      },
      sk
    );
    setEvents((prev) => [ev as NostrEvent, ...prev]);
    setNewPost("");
    setPostAttachments([]);
    if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
    setStatus("Posted");
    logger.logAction("post", "Posted note", { networkEnabled, contentLength: content.length, mediaCount: postAttachments.length });
  }, [effectivePrivKey, newPost, postAttachments, networkEnabled, canPublishToNetwork]);

  const handleLike = useCallback(
    async (note: NostrEvent) => {
      if (!effectivePrivKey) return;
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const ev = await Nostr.finishEventAsync(
          {
            kind: 7,
            content: "+",
            tags: [
              ["e", note.id],
              ["p", note.pubkey],
            ],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Liked");
        logger.logAction("like", "Liked note", { noteId: note.id.slice(0, 8) + "…", networkEnabled });
      } catch (e) {
        setStatus("Like failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("Like failed", e, { noteId: note.id.slice(0, 8) + "…" });
      }
    },
    [effectivePrivKey, networkEnabled, canPublishToNetwork]
  );

  const handleRepost = useCallback(
    async (note: NostrEvent) => {
      if (!effectivePrivKey) return;
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const ev = await Nostr.finishEventAsync(
          {
            kind: 6,
            content: JSON.stringify(note),
            tags: [
              ["e", note.id],
              ["p", note.pubkey],
            ],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Reposted");
      } catch (e) {
        setStatus("Repost failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, networkEnabled, canPublishToNetwork]
  );

  /**
   * Hide everything from an account, from this client only.
   *
   * The muted-pubkeys list and its unmute UI in Settings already existed. The
   * only way to add to it was to paste a pubkey into Settings by hand, so a
   * feed filled by one account looked like something with no remedy at all --
   * Delete renders only on your own notes, and correctly so.
   *
   * Nothing is published and the author is not told. The toast offers the
   * action straight back, because muting the wrong person on a mis-click is
   * otherwise only undoable in a settings screen they would have to go and
   * find.
   */
  const handleMuteAuthor = useCallback(
    (note: NostrEvent) => {
      if (selfPubkeys.includes(note.pubkey)) return;
      const pk = note.pubkey;
      setMutedPubkeys((prev) => new Set(prev).add(pk));
      const name = profiles[pk]?.name ?? `${pk.slice(0, 8)}…`;
      toast.info(`Muted ${name}. Their notes are hidden on this device only — nothing was published.`);
      setStatus(`Muted ${name}. Undo in Settings › Muted users.`);
    },
    [selfPubkeys, profiles, toast],
  );

  const toggleNoteSelected = useCallback((note: NostrEvent) => {
    setSelectedNoteIdsForDelete((prev) => {
      const next = new Set(prev);
      if (next.has(note.id)) next.delete(note.id); else next.add(note.id);
      return next;
    });
  }, []);

  /**
   * Delete every selected note in one pass.
   *
   * One kind-5 tombstone per note is the protocol's own shape -- a tombstone
   * names the events it deletes, and batching them into a single event would
   * be a private convention no other client understands. What is batched is
   * the user's decision, not the wire format.
   *
   * All tombstones are added to local state together so the feed updates once
   * rather than jumping N times.
   */
  const handleDeleteSelected = useCallback(async () => {
    const ids = Array.from(selectedNoteIdsForDelete);
    const mine = events.filter((e) => ids.includes(e.id) && selfPubkeys.includes(e.pubkey));
    if (mine.length === 0) return;

    const tombstones: NostrEvent[] = [];
    for (const note of mine) {
      const identityForNote = identities.find(
        (i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === note.pubkey,
      );
      const privToUse = identityForNote?.privKeyHex ?? effectivePrivKey;
      try {
        const ev = await Nostr.finishEventAsync(
          { kind: 5, content: "", tags: [["e", note.id]], created_at: Math.floor(Date.now() / 1000) },
          Nostr.hexToBytes(privToUse),
        );
        tombstones.push(ev as NostrEvent);
      } catch (_) { /* skip this one, report the shortfall below */ }
    }
    if (tombstones.length) setEvents((prev) => [...tombstones, ...prev]);
    if (networkEnabled && canPublishToNetwork) for (const t of tombstones) publishViaRelay(t);

    setSelectedNoteIdsForDelete(new Set());
    setSelectMode(false);
    // Report the number actually deleted, not the number asked for.
    const msg = tombstones.length === mine.length
      ? `Deleted ${tombstones.length} note${tombstones.length === 1 ? "" : "s"}.`
      : `Deleted ${tombstones.length} of ${mine.length} — the rest could not be signed.`;
    setStatus(msg);
    toast.success(msg);
  }, [selectedNoteIdsForDelete, events, selfPubkeys, identities, effectivePrivKey, networkEnabled, canPublishToNetwork, toast]);

  const handleDelete = useCallback(
    async (note: NostrEvent) => {
      if (!selfPubkeys.includes(note.pubkey)) return;
      const identityForNote = identities.find((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === note.pubkey);
      const privToUse = identityForNote?.privKeyHex ?? effectivePrivKey;
      try {
        const sk = Nostr.hexToBytes(privToUse);
        const ev = await Nostr.finishEventAsync(
          {
            kind: 5,
            content: "",
            tags: [["e", note.id]],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Note deleted");
      } catch (e) {
        setStatus("Delete failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, identities, selfPubkeys, networkEnabled, canPublishToNetwork]
  );

  const handleBookmark = useCallback(
    async (note: NostrEvent) => {
      if (!effectivePrivKey || !pubkey) return;
      const existing = bookmarksEvent?.tags.filter((t) => t[0] === "e").map((t) => t[1]) ?? [];
      if (existing.includes(note.id)) return;
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const newTags = [...existing.map((id) => ["e", id] as [string, string]), ["e", note.id]];
        const ev = await Nostr.finishEventAsync(
          { kind: 10003, content: "", tags: newTags, created_at: Math.floor(Date.now() / 1000) },
          sk
        );
        setEvents((prev) => prev.filter((e) => !(e.kind === 10003 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Bookmarked");
      } catch (e) {
        setStatus("Bookmark failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, pubkey, networkEnabled, canPublishToNetwork, bookmarksEvent]
  );

  const handleUnbookmark = useCallback(
    async (note: NostrEvent) => {
      if (!effectivePrivKey || !pubkey) return;
      const existing = bookmarksEvent?.tags.filter((t) => t[0] === "e").map((t) => t[1]) ?? [];
      if (!existing.includes(note.id)) return;
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const newTags = existing.filter((id) => id !== note.id).map((id) => ["e", id] as [string, string]);
        const ev = await Nostr.finishEventAsync(
          { kind: 10003, content: "", tags: newTags, created_at: Math.floor(Date.now() / 1000) },
          sk
        );
        setEvents((prev) => prev.filter((e) => !(e.kind === 10003 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Removed from bookmarks");
      } catch (e) {
        setStatus("Unbookmark failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, pubkey, networkEnabled, canPublishToNetwork, bookmarksEvent]
  );

  const getRootId = useCallback((note: NostrEvent): string => {
    const eTag = note.tags.find((t) => t[0] === "e");
    return eTag ? eTag[1] : note.id;
  }, []);

  const handleReply = useCallback(
    async () => {
      if (!effectivePrivKey || !replyingTo || !replyContent.trim()) return;
      const rootId = getRootId(replyingTo);
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const tags: string[][] = [["e", rootId], ["e", replyingTo.id], ["p", replyingTo.pubkey]];
        const ev = await Nostr.finishEventAsync(
          {
            kind: 1,
            content: ensureStegstrSuffix(replyContent.trim()),
            tags,
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        setReplyingTo(null);
        setReplyContent("");
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Replied");
        logger.logAction("reply", "Replied to note", { rootId, networkEnabled });
      } catch (e) {
        setStatus("Reply failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("Reply failed", e, { rootId });
      }
    },
    [effectivePrivKey, replyingTo, replyContent, networkEnabled, canPublishToNetwork, getRootId]
  );

  const openZapUrl = useCallback((url: string) => {
    try {
      window.open(url, "_blank", "noopener");
    } catch (_) {}
  }, []);

  const flushQueuedZaps = useCallback(() => {
    if (!networkEnabled || !canPublishToNetwork || queuedZaps.length === 0) return;
    const pending = [...queuedZaps];
    setQueuedZaps([]);
    pending.forEach((zap) => {
      try {
        publishViaRelay(zap.event as NostrEvent);
      } catch (_) {}
      openZapUrl(zap.zapStreamUrl);
    });
    setStatus(pending.length === 1 ? "Queued zap sent" : `Queued zaps sent (${pending.length})`);
  }, [networkEnabled, canPublishToNetwork, queuedZaps, relayUrls, openZapUrl]);

  useEffect(() => {
    if (!networkEnabled || !canPublishToNetwork || relayStatus !== "Synced") return;
    if (queuedZaps.length === 0) return;
    flushQueuedZaps();
  }, [networkEnabled, canPublishToNetwork, relayStatus, queuedZaps.length, flushQueuedZaps]);

  const handleZap = useCallback(
    async (note: NostrEvent) => {
      if (!effectivePrivKey) return;
      if (!canPublishToNetwork) {
        setStatus("Zaps require a Nostr identity");
        return;
      }
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const zapRequest = await Nostr.finishEventAsync(
          {
            kind: 9734,
            content: "Zap request",
            tags: [
              ["e", note.id],
              ["p", note.pubkey],
              ["relays", ...relayUrls],
            ],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        const zapStreamUrl = `https://zap.stream/e/${note.id}`;
        if (networkEnabled) {
          publishViaRelay(zapRequest as NostrEvent);
          openZapUrl(zapStreamUrl);
          setStatus("Zap sent");
        } else {
          const queued: QueuedZap = {
            id: zapRequest.id,
            noteId: note.id,
            event: zapRequest as NostrEvent,
            createdAt: Date.now(),
            zapStreamUrl,
          };
          setQueuedZaps((prev) => [...prev, queued]);
          setStatus("Zap queued. Turn Network ON to send.");
        }
      } catch (e) {
        setStatus("Zap failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, networkEnabled, canPublishToNetwork, relayUrls, openZapUrl]
  );

  const handleEditProfileOpen = useCallback(() => {
    setEditName(myName);
    setEditAbout(myAbout);
    setEditPicture(myPicture ?? "");
    setEditBanner(myBanner ?? "");
    setEditProfileOpen(true);
  }, [myName, myAbout, myPicture, myBanner]);

  const handleEditProfileSave = useCallback(async () => {
    if (!effectivePrivKey || !pubkey) return;
    const sk = Nostr.hexToBytes(effectivePrivKey);
    const content = JSON.stringify({
      name: editName.trim() || undefined,
      about: editAbout.trim() || undefined,
      picture: editPicture.trim() || undefined,
      banner: editBanner.trim() || undefined,
    });
    const ev = await Nostr.finishEventAsync(
      {
        kind: 0,
        content,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk
    );
    setEvents((prev) => {
      const byId = new Map(prev.map((e) => [e.id, e]));
      byId.set(ev.id, ev as NostrEvent);
      return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
    });
    setProfiles((p) => ({
      ...p,
      [(ev as NostrEvent).pubkey]: {
        name: editName.trim() || undefined,
        about: editAbout.trim() || undefined,
        picture: editPicture.trim() || undefined,
        banner: editBanner.trim() || undefined,
      },
    }));
    setEditProfileOpen(false);
    // Never publish kind 0 for Nostr identities—their profile lives on Nostr; publishing would overwrite it
    const isNostr = actingIdentity?.type === "nostr";
    if (networkEnabled && canPublishToNetwork && !isNostr) publishViaRelay(ev as NostrEvent);
    setStatus(isNostr ? "Profile updated (local only)" : "Profile updated");
    logger.logAction("profile_edit", isNostr ? "Profile updated (local only)" : "Profile updated", { networkEnabled, isNostr });
  }, [effectivePrivKey, pubkey, editName, editAbout, editPicture, editBanner, networkEnabled, canPublishToNetwork, actingIdentity?.type]);

  const handlePostMediaUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Snapshot before reset -- the order matters, see takeFilesFromInput.
    const files = takeFilesFromInput(e.target);
    if (!files.length) return;

    // Attaching uploads the file to a third-party host, so it cannot happen
    // while the app is telling the user nothing is sent. This path ignored the
    // switch entirely, which is the same failure as the pointer-resolution
    // leak.
    // Attaching needs the network, so turn it on rather than refusing.
    //
    // Choosing a file IS the intent to upload it, and the note is still not
    // posted until Post is pressed -- so refusing here made the user toggle a
    // switch and repeat themselves to reach the outcome they had already asked
    // for. This mirrors pointer mode, which has enabled the network on
    // selection since §17.8 for exactly the same reason: make the dependency
    // visible at the moment of choosing rather than as a refusal afterwards.
    //
    // It is said plainly, because the app promises that nothing is sent while
    // Network is off and this is the moment that stops being true.
    let turnedOn = false;
    if (!networkEnabled) {
      setNetworkEnabled(true);
      turnedOn = true;
      addStegoLog("Network turned on automatically: attaching uploads the file to a Blossom server.");
    }
    if (!effectivePrivKey) {
      const msg = "Attaching needs an identity to sign the upload. Log in first.";
      setStatus(msg);
      setAttachNotice({ text: msg, kind: "error" });
      return;
    }

    setUploadingMedia(true);
    setAttachNotice(null);
    try {
      const added: UploadedAttachment[] = [];
      for (const [i, file] of files.entries()) {
        setStatus(`Encrypting and uploading ${file.name} (${i + 1}/${files.length})…`);
        added.push(await uploadEncrypted(file, effectivePrivKey));
      }
      setPostAttachments((prev) => [...prev, ...added]);
      const bytes = added.reduce((n, a) => n + a.size, 0);
      const names = added.map((a) => a.name).join(", ");
      const ok =
        `Attached ${names} (${(bytes / 1024).toFixed(0)} KB), encrypted. ` +
        `The server holds ciphertext. Press Post to publish the note.` +
        (turnedOn ? " Network was turned on to upload." : "");
      setStatus(ok);
      setAttachNotice({ text: ok, kind: "ok" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(msg);
      // Kept until dismissed: an upload failure names which servers refused
      // and why, which is the one thing worth reading here.
      setAttachNotice({ text: msg, kind: "error" });
    } finally {
      setUploadingMedia(false);
    }
  }, [networkEnabled, effectivePrivKey, addStegoLog]);

  const handleFollow = useCallback(
    async (theirPk: string) => {
      if (!effectivePrivKey || !pubkey) return;
      const kind3 = events.find((e) => e.kind === 3 && e.pubkey === pubkey);
      // The effective list, not just the stored one: on a new local identity
      // the defaults are being followed without any kind 3 to hold them, and
      // starting from [] here silently dropped every one of them.
      const existing = currentContactPubkeys(
        events, pubkey, usingDefaultFollows(events, pubkey, actingIdentity?.category),
      );
      if (existing.includes(theirPk)) {
        setStatus("Already following");
        return;
      }
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const newTags = contactListTags(kind3, [...existing, theirPk]);
        const ev = await Nostr.finishEventAsync(
          { kind: 3, content: kind3?.content ?? "", tags: newTags, created_at: Math.floor(Date.now() / 1000) },
          sk
        );
        setEvents((prev) => prev.filter((e) => !(e.kind === 3 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Following");
        logger.logAction("follow", "Followed pubkey", { theirPk: theirPk.slice(0, 8) + "…", networkEnabled });
      } catch (e) {
        setStatus("Follow failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("Follow failed", e, { theirPk: theirPk.slice(0, 8) + "…" });
      }
    },
    [effectivePrivKey, pubkey, events, networkEnabled, canPublishToNetwork, actingIdentity?.category]
  );

  const handleUnfollow = useCallback(
    async (theirPk: string) => {
      if (!effectivePrivKey || !pubkey) return;
      const kind3 = events.find((e) => e.kind === 3 && e.pubkey === pubkey);
      // `if (!kind3) return` used to sit here, which is why Unfollow did
      // nothing on a new local identity: the defaults are followed without any
      // kind 3 to remove them from. Materialise the effective list, minus this
      // person, so the first unfollow writes the contact list the UI has been
      // showing all along.
      const existing = currentContactPubkeys(
        events, pubkey, usingDefaultFollows(events, pubkey, actingIdentity?.category),
      );
      if (!existing.includes(theirPk)) {
        setStatus("Not following that account");
        return;
      }
      const newTags = contactListTags(kind3, existing.filter((pk) => pk !== theirPk));
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const ev = await Nostr.finishEventAsync(
          { kind: 3, content: kind3?.content ?? "", tags: newTags, created_at: Math.floor(Date.now() / 1000) },
          sk
        );
        setEvents((prev) => prev.filter((e) => !(e.kind === 3 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Unfollowed");
      } catch (e) {
        setStatus("Unfollow failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, pubkey, events, networkEnabled, canPublishToNetwork, actingIdentity?.category]
  );

  useEffect(() => {
    if (!actingIdentity || actingIdentity.type !== "nostr" || actingIdentity.category !== "nostr" || hasSyncedAnonRef.current) return;
    hasSyncedAnonRef.current = true;
    const sk = Nostr.hexToBytes(actingIdentity.privKeyHex);
    const anonPubkey = Nostr.getPublicKey(Nostr.hexToBytes(getOrCreateAnonKey(profile)));
    let cancelled = false;
    (async () => {
      const anonEvents = events.filter((e) => e.pubkey === anonPubkey);
      if (anonEvents.length === 0) return;
      const newEvents: NostrEvent[] = [];
      for (const ev of anonEvents) {
        if (cancelled) return;
        try {
          const content = ev.kind === 1 ? ensureStegstrSuffix(ev.content) : ev.content;
          const newEv = await Nostr.finishEventAsync(
            { kind: ev.kind, content, tags: ev.tags, created_at: ev.created_at },
            sk
          );
          publishViaRelay(newEv as NostrEvent);
          newEvents.push(newEv as NostrEvent);
        } catch (_) {}
      }
      if (!cancelled && newEvents.length > 0) {
        setEvents((prev) => {
          const withoutAnon = prev.filter((e) => e.pubkey !== anonPubkey);
          return [...withoutAnon, ...newEvents].sort((a, b) => b.created_at - a.created_at);
        });
        setStatus("Synced previous posts to Nostr");
      }
    })();
    return () => { cancelled = true; };
  }, [actingIdentity, events, profile]);

  // --- Shared NoteCard state & actions ---
  const noteCardState: NoteCardState = useMemo(() => ({
    selectMode,
    isSelected: (id: string) => selectedNoteIdsForDelete.has(id),
    profiles,
    selfPubkeys,
    getIdentityLabels: getIdentityLabelsForPubkey,
    hasLiked,
    hasBookmarked,
    getLikeCount,
    getZapCount,
  }), [profiles, selfPubkeys, getIdentityLabelsForPubkey, hasLiked, hasBookmarked, getLikeCount, getZapCount]);

  const navigateToProfile = useCallback((pk: string) => {
    setViewingProfilePubkey(pk);
    setView("profile");
  }, []);

  const noteCardActions: NoteCardActions = useMemo(() => ({
    onNavigateProfile: navigateToProfile,
    onReply: (ev: NostrEvent) => { setReplyingTo(ev); setReplyContent(""); },
    onLike: handleLike,
    onRepost: handleRepost,
    onZap: handleZap,
    onBookmark: handleBookmark,
    onUnbookmark: handleUnbookmark,
    onDelete: handleDelete,
    onMuteAuthor: handleMuteAuthor,
    onToggleSelect: toggleNoteSelected,
  }), [navigateToProfile, handleLike, handleRepost, handleZap, handleBookmark, handleUnbookmark, handleDelete, handleMuteAuthor, toggleNoteSelected]);

  /** Actions for views that redirect reply to the feed. */
  const noteCardActionsRedirectReply: NoteCardActions = useMemo(() => ({
    ...noteCardActions,
    onReply: (ev: NostrEvent) => { setReplyingTo(ev); setReplyContent(""); setView("feed"); },
  }), [noteCardActions]);

  const handleReplyCancel = useCallback(() => { setReplyingTo(null); setReplyContent(""); }, []);

  return (
    <main className="app-root primal-layout">
      <header className="top-header">
        <h1 className="app-title">
          <img src={`${import.meta.env.BASE_URL}LOGO.png`} alt="" className="app-logo" />
          Stegstr
        </h1>
        <div className="header-actions">
          <div className="network-toggle-wrap">
            <span className="network-label">Network</span>
            <button
              type="button"
              role="switch"
              aria-checked={networkEnabled}
              className={`network-toggle ${networkEnabled ? "on" : "off"}`}
              onClick={() => setNetworkEnabled((v) => !v)}
            >
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span className="toggle-state off">OFF</span>
              <span className="toggle-state on">ON</span>
            </button>

          </div>
          {actingIdentity && (
            <span className="acting-identity" title={`Acting as ${profiles[actingPubkey ?? ""]?.name || actingIdentity.label} (${(actingIdentity.category ?? (actingIdentity.type === "nostr" ? "nostr" : "local")) === "nostr" ? "Nostr" : "Local"})`}>
              as {profiles[actingPubkey ?? ""]?.name || actingIdentity.label} ({(actingIdentity.category ?? (actingIdentity.type === "nostr" ? "nostr" : "local")) === "nostr" ? "Nostr" : "Local"})
            </span>
          )}
          {queuedZaps.length > 0 && (
            <button
              type="button"
              className="queued-zaps"
              onClick={flushQueuedZaps}
              disabled={!networkEnabled || !canPublishToNetwork}
              title={networkEnabled ? "Send queued zaps now" : "Queued zaps will send when Network is ON"}
            >
              Queued zaps <span className="queued-zaps-count">{queuedZaps.length}</span>
              <span className="queued-zaps-label">{networkEnabled ? "Send now" : "Waiting"}</span>
            </button>
          )}
          {relayStatus && <span className="relay-status">{relayStatus}</span>}
        </div>
      </header>

      {/* Offline notice as its own row rather than inside the header.
          Inside it, this text either moved the network switch when it appeared
          (it occupied a full-width line, so mounting it reflowed the header) or,
          once positioned absolutely to stop that, got clipped by the header's
          bounds. A row of its own has neither problem. */}
      {!networkEnabled && (
        <div className="network-off-bar" title="Detect and Embed run entirely on this machine.">
          No internet — local only. Detect &amp; Embed run {isWeb() ? "in your browser" : "on this machine"}; nothing is sent.
        </div>
      )}

      {view === "feed" && (
        <div className="search-bar-wrap">
          <input
            type="search"
            placeholder="Search by text, hashtags, npub or hex pubkey, or name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && networkEnabled && relayRef.current && searchQuery.trim().length >= 2) {
                try {
                  relayRef.current.requestSearch(searchQuery.trim());
                  relayRef.current.requestProfileSearch(searchQuery.trim());
                } catch (err) {
                  console.error("[Stegstr] search on enter error", err);
                }
              }
            }}
            className="search-input"
          />
          {searchQuery.trim() && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearchQuery("")}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      )}

      <div className="body-wrap">
        <aside className="sidebar left">
          <div className="profile-card">
            {myPicture ? (
              <img src={myPicture} alt="" className="profile-avatar" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
            ) : (
              <div className="profile-avatar placeholder">{myName.slice(0, 1)}</div>
            )}
            <strong className="profile-name">{myName}</strong>
            {myAbout && <p className="profile-about">{myAbout.slice(0, 120)}{myAbout.length > 120 ? "…" : ""}</p>}
            {isNostrLoggedIn ? (
              !myProfile?.name && !myProfile?.picture && !myProfile?.about ? (
                <>
                  <p className="profile-note muted">{networkEnabled ? "Fetching profile from relays…" : "Turn Network ON to fetch profile"}</p>
                  {networkEnabled && actingPubkey && (
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ marginTop: "0.5rem" }}
                      onClick={() => {
                        relayRef.current?.requestProfiles([actingPubkey]);
                        relayRef.current?.requestAuthor(actingPubkey);
                        setStatus("Refreshing profile…");
                      }}
                    >
                      Refresh profile
                    </button>
                  )}
                </>
              ) : (
                <p className="profile-note muted">From Nostr</p>
              )
            ) : (
              <p className="profile-note muted">Local identity · Add Nostr to sync</p>
            )}
            {isNostrLoggedIn ? (
              <p className="profile-note muted">Nostr profile is from relays. Update via a Nostr client.</p>
            ) : (
              <button type="button" className="btn-secondary" onClick={handleEditProfileOpen}>Edit profile</button>
            )}
          </div>
          <nav className="side-nav">
            <button type="button" className={view === "feed" ? "active" : ""} onClick={() => setView("feed")}>Home</button>
            <button type="button" className={view === "identity" ? "active" : ""} onClick={() => setView("identity")}>Identity</button>
            <button type="button" className={view === "notifications" ? "active" : ""} onClick={() => setView("notifications")}>Notifications{totalUnreadNotifCount > 0 && <span className="nav-badge">{totalUnreadNotifCount}</span>}</button>
            <button type="button" className={view === "messages" ? "active" : ""} onClick={() => setView("messages")}>Messages{totalUnreadDmCount > 0 && <span className="nav-badge">{totalUnreadDmCount}</span>}</button>
            <button type="button" className={view === "profile" ? "active" : ""} onClick={() => { setViewingProfilePubkey(null); setView("profile"); }}>Profile</button>
            <button type="button" className={view === "followers" ? "active" : ""} onClick={() => setView("followers")}>Following ({contactsSet.size})</button>
            <button type="button" className={view === "bookmarks" ? "active" : ""} onClick={() => setView("bookmarks")}>Bookmarks</button>
            <button type="button" className={view === "explore" ? "active" : ""} onClick={() => setView("explore")}>Explore</button>
            <button type="button" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Settings</button>
          </nav>
        </aside>

        <div className="main-content">
          {view === "feed" && (
            <FeedView
              myPicture={myPicture}
              myName={myName}
              newPost={newPost}
              setNewPost={setNewPost}
              postAttachments={postAttachments}
              setPostAttachments={setPostAttachments}
              uploadingMedia={uploadingMedia}
              selectMode={selectMode}
              selectedCount={selectedNoteIdsForDelete.size}
              onToggleSelectMode={() => {
                setSelectMode((on) => !on);
                setSelectedNoteIdsForDelete(new Set());
              }}
              onDeleteSelected={handleDeleteSelected}
              attachNotice={attachNotice}
              onDismissAttachNotice={() => setAttachNotice(null)}
              postMediaInputRef={postMediaInputRef}
              handlePostMediaUpload={handlePostMediaUpload}
              handlePost={handlePost}
              feedFilter={feedFilter}
              setFeedFilter={setFeedFilter}
              hideSensitive={hideSensitive}
              setHideSensitive={setHideSensitive}
              notesEmpty={notes.length === 0}
              feedItems={feedItems}
              searchTrim={searchTrim}
              searchLower={searchLower}
              searchNoSpaces={searchNoSpaces}
              searchPubkeyHex={searchPubkeyHex}
              npubStr={npubStr}
              networkEnabled={networkEnabled}
              profiles={profiles}
              pubkey={pubkey}
              focusedNoteId={focusedNoteId}
              notes={notes}
              getRepliesTo={getRepliesTo}
              noteCardState={noteCardState}
              noteCardActions={noteCardActions}
              replyingTo={replyingTo}
              replyContent={replyContent}
              onReplyContentChange={setReplyContent}
              handleReply={handleReply}
              handleReplyCancel={handleReplyCancel}
              loadingMore={loadingMore}
              loadMoreSentinelRef={loadMoreSentinelRef}
              setViewingProfilePubkey={setViewingProfilePubkey}
              setView={setView}
            />
          )}

          {view === "messages" && (
            <MessagesView
              dmEvents={dmEvents}
              selfPubkeys={selfPubkeys}
              dmDecrypted={dmDecrypted}
              profiles={profiles}
              lastReadTimestamps={lastReadTimestamps}
              recentDmPartners={recentDmPartners}
              selectedMessagePeer={selectedMessagePeer}
              setSelectedMessagePeer={setSelectedMessagePeer}
              myName={myName}
              dmReplyContent={dmReplyContent}
              setDmReplyContent={setDmReplyContent}
              handleSendDm={handleSendDm}
              onNewMessage={() => setNewMessageModalOpen(true)}
            />
          )}

          {view === "followers" && (
            <FollowingView
              followingSearchInput={followingSearchInput}
              setFollowingSearchInput={setFollowingSearchInput}
              contactsSet={contactsSet}
              profiles={profiles}
              pubkey={pubkey}
              resolvePubkeyFromInput={resolvePubkeyFromInput}
              handleFollow={handleFollow}
              handleUnfollow={handleUnfollow}
              relayRef={relayRef}
              onStatus={setStatus}
              onNavigateProfile={(pk) => setViewingProfilePubkey(pk)}
              setView={setView}
            />
          )}

          {view === "explore" && (
            <ExploreView
              notes={exploreNotes}
              getRepliesTo={getRepliesTo}
              getLikeCount={getLikeCount}
              state={noteCardState}
              actions={noteCardActionsRedirectReply}
            />
          )}

          {view === "bookmarks" && (
            <BookmarksView
              notes={notes}
              bookmarkIds={bookmarkIds}
              deletedNoteIds={deletedNoteIds}
              getRepliesTo={getRepliesTo}
              state={noteCardState}
              actions={noteCardActionsRedirectReply}
            />
          )}

          {view === "notifications" && (
            <NotificationsView
              events={notificationEvents}
              profiles={profiles}
              onNavigateProfile={navigateToProfile}
              onViewPost={(noteId) => { setFocusedNoteId(noteId); setView("feed"); }}
            />
          )}

          {view === "profile" && pubkey && (
            <ProfileView
              viewingProfilePubkey={viewingProfilePubkey}
              setViewingProfilePubkey={setViewingProfilePubkey}
              profileViewPubkey={profileViewPubkey}
              profileDisplayKey={profileDisplayKey}
              profiles={profiles}
              myName={myName}
              myPicture={myPicture}
              myAbout={myAbout}
              myBanner={myBanner}
              myProfile={myProfile}
              isNostrLoggedIn={isNostrLoggedIn}
              contactsSet={contactsSet}
              profileRootNotes={profileRootNotes}
              profileReplies={profileReplies}
              profileFollowing={profileFollowing}
              profileFollowers={profileFollowers}
              profileTab={profileTab}
              setProfileTab={setProfileTab}
              getRepliesTo={getRepliesTo}
              getParentNote={getParentNote}
              noteCardState={noteCardState}
              noteCardActionsRedirectReply={noteCardActionsRedirectReply}
              navigateToProfile={navigateToProfile}
              handleFollow={handleFollow}
              handleUnfollow={handleUnfollow}
              handleEditProfileOpen={handleEditProfileOpen}
              onStatus={setStatus}
              setView={setView}
            />
          )}

          {view === "identity" && (
            <IdentityView
              identities={identities}
              setIdentities={setIdentities}
              profiles={profiles}
              viewingPubkeys={viewingPubkeys}
              setViewingPubkeys={setViewingPubkeys}
              actingPubkey={actingPubkey}
              setActingPubkey={setActingPubkey}
              showNsecFor={showNsecFor}
              setShowNsecFor={setShowNsecFor}
              networkEnabled={networkEnabled}
              relayRef={relayRef}
              onGenerate={handleGenerate}
              onLoginOpen={() => setLoginFormOpen(true)}
              onStatus={setStatus}
            />
          )}

          {view === "settings" && (
            <SettingsView
              identities={identities}
              profiles={profiles}
              relayUrls={relayUrls}
              setRelayUrls={setRelayUrls}
              newRelayUrl={newRelayUrl}
              setNewRelayUrl={setNewRelayUrl}
              muteInput={muteInput}
              setMuteInput={setMuteInput}
              mutedPubkeys={mutedPubkeys}
              setMutedPubkeys={setMutedPubkeys}
              mutedWords={mutedWords}
              setMutedWords={setMutedWords}
              resolvePubkeyFromInput={resolvePubkeyFromInput}
              onStatus={setStatus}
            />
          )}
        </div>

        <aside className="sidebar right">
          <div className="widget steganography-widget">
            <h3>Steganography</h3>
            <p className="muted">Detect image: load an image to extract data. Embed image: save your feed and messages to an image to share.</p>
            <p className="muted" style={{ fontSize: "0.78rem", lineHeight: 1.4 }}>
              Best covers are detailed photos — foliage, fabric, crowds, brickwork.
              Avoid sky, plain walls, screenshots and logos.
            </p>
            {/* The drop zone IS the detect control.
                It used to say "or click Detect image below", pointing at a
                separate button for the same job -- two targets for one action,
                and the instruction only made sense if you had already found
                the button. Clicking the zone now opens the picker. */}
            <div
              role="button"
              tabIndex={0}
              className={`stego-drop-zone stego-drop-zone-clickable${dragOverStego ? " drag-active" : ""}`}
              aria-label="Drop an image here, or click to choose one, to detect hidden data"
              onClick={() => { if (!detecting && !embedding) handleLoadFromImage(); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!detecting && !embedding) handleLoadFromImage();
                }
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverStego(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverStego(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverStego(false);
                if (detecting) return;
                const file = e.dataTransfer.files?.[0];
                if (!file || !file.type.startsWith("image/")) {
                  setDecodeError("Please drop an image file (e.g. PNG).");
                  return;
                }
                // Both platforms: the handler takes a File and resolves
                // paths itself, so there is nothing platform-specific to do.
                handleLoadFromImage(file);
              }}
            >
              <strong>{detecting ? "Reading image…" : "Drop an image here to detect"}</strong>
              <br /><span style={{ fontSize: "0.85rem", color: "#555", fontWeight: 600 }}>or click to choose one</span>
            </div>
            {(detecting || embedding) && (
              <div className="stego-progress">
                <p className="muted detect-status">{stegoProgress || (detecting ? "Processing..." : "Embedding...")}</p>
                <div className="progress-bar"><div className="progress-bar-indeterminate"></div></div>
              </div>
            )}
            <div className="stego-actions">
              <button type="button" className="btn-stego btn-primary" onClick={handleSaveToImage} disabled={detecting || embedding}>Embed image</button>
              {profile != null && !isWeb() && (
                <>
                  <button type="button" className="btn-stego btn-quick-test" onClick={handleDetectFromExchange} disabled={detecting} title="1-click: detect from /tmp/stegstr-test-exchange/exchange.png">Detect from exchange</button>
                  <button type="button" className="btn-stego btn-quick-test" onClick={handleEmbedToExchange} disabled={detecting} title="2-click: pick cover → save to exchange path">Embed to exchange</button>
                </>
              )}
            </div>
            {stegoLogs.length > 0 && (
              <div className="stego-log">
                <details>
                  <summary>Stego Log ({stegoLogs.length} entries)</summary>
                  <pre className="stego-log-content">{stegoLogs.join("\n")}</pre>
                </details>
              </div>
            )}
            {/* Result of the last detect/embed, next to the controls that
                caused it. It used to render at the bottom of <main>, far from
                the image area the user is looking at and below the fold on a
                short window -- so a failure could go unseen while the user
                waited for something to happen. */}
            {(status || decodeError) && (
              <p className={`stego-result ${decodeError ? "error" : "status"}`}>
                {decodeError || status}
              </p>
            )}
          </div>
        </aside>
      </div>

      {newMessageModalOpen && (
        <NewMessageModal
          onClose={() => setNewMessageModalOpen(false)}
          input={newMessagePubkeyInput}
          onInputChange={setNewMessagePubkeyInput}
          profiles={profiles}
          selfPubkeys={selfPubkeys}
          resolvePubkey={resolvePubkeyFromInput}
          onSelectPeer={setSelectedMessagePeer}
          onStatus={setStatus}
        />
      )}

      {loginFormOpen && (
        <LoginModal
          onClose={() => setLoginFormOpen(false)}
          nsec={nsec}
          onNsecChange={setNsec}
          onLogin={handleLogin}
          onGenerate={handleGenerate}
        />
      )}

      {/*
        Progress overlay.

        The stego panel already renders a progress bar, but it lives in a
        right-hand aside that is out of eyeline (and off-screen on narrow
        windows) while the user is looking at the image area. Embedding a large
        feed into a large cover runs for many seconds -- encrypt, fit, DCT,
        re-encode -- with no visible sign of life, which reads as a hang.

        This is a fixed overlay so the state is visible wherever the user is
        looking. It shows the last log line as well as the phase, because
        "Encrypting..." for eight seconds is far less reassuring than watching
        the fit search count down.
      */}
      {(detecting || embedding) && (
        <div
          style={{
            position: "fixed", left: "50%", bottom: "1.5rem",
            transform: "translateX(-50%)", zIndex: 1200,
            background: "#1c1c1c", color: "#fff", borderRadius: 8,
            padding: "0.7rem 1rem", minWidth: 300, maxWidth: "90vw",
            boxShadow: "0 4px 20px rgba(0,0,0,0.28)", fontSize: "0.85rem",
          }}
          role="status"
          aria-live="polite"
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <span
              style={{
                width: 12, height: 12, borderRadius: "50%",
                border: "2px solid rgba(255,255,255,0.35)",
                borderTopColor: "#fff", display: "inline-block",
                animation: "stegspin 0.8s linear infinite", flexShrink: 0,
              }}
            />
            <strong style={{ fontWeight: 600 }}>
              {detecting ? "Reading image" : "Building image"}
            </strong>
            <span style={{ opacity: 0.75, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {stegoProgress}
            </span>
          </div>
          {stegoLogs.length > 0 && (
            <div
              style={{
                marginTop: "0.4rem", opacity: 0.6, fontSize: "0.75rem",
                fontFamily: "monospace", overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >
              {stegoLogs[stegoLogs.length - 1]}
            </div>
          )}
          <style>{"@keyframes stegspin{to{transform:rotate(360deg)}}"}</style>
        </div>
      )}

      {detectReview && (
        <DetectResultModal
          events={detectReview.events}
          imageName={detectReview.name}
          nameFor={(pk) => profiles[pk]?.name}
          onClose={() => {
            addStegoLog("Discarded all content from this image");
            setDetectReview(null);
          }}
          onAccept={(ids) => {
            const chosen = new Set(ids);
            const accepted = detectReview.events.filter((e) => chosen.has(e.id));
            setEvents((prev) => {
              // Accepting a note you had previously deleted is an explicit
              // "put this back", so drop your own kind-5 tombstone for it.
              // Removing the tombstone genuinely un-deletes the note and
              // leaves Delete working normally afterwards -- an exception in
              // the display filter instead would have to argue with the
              // tombstone forever, and would make the note undeletable.
              const acceptedIds = new Set(accepted.map((e) => e.id));
              const withoutTombstones = prev.filter(
                (e) => !(
                  e.kind === 5 &&
                  selfPubkeys.includes(e.pubkey) &&
                  e.tags.some((t) => t[0] === "e" && acceptedIds.has(t[1]))
                ),
              );
              const byId = new Map(withoutTombstones.map((e) => [e.id, e]));
              accepted.forEach((e) => byId.set(e.id, e as NostrEvent));
              return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
            });
            // The feed filter hides a note authored by one of your OWN
            // identities unless you're currently viewing-as that identity,
            // or its id is in importedEventIds -- otherwise embedding your
            // own feed into an image and decoding it back would require
            // switching identities just to see what you just imported.
            // importedEventIds was declared and read for exactly this, but
            // never written anywhere, so the exception could never fire and
            // a just-decoded self-authored note would silently vanish from
            // the feed despite "Added N item(s)" reporting success.
            setImportedEventIds((prev) => {
              const next = new Set(prev);
              accepted.forEach((e) => next.add(e.id));
              return next;
            });
            addStegoLog(`Added ${accepted.length} item(s) to feed`);
            // Say why an accepted item will or will not appear in the Home
            // feed. "Added N item(s)" on its own has now been misleading
            // three separate times -- it reports the merge, which always
            // succeeds, not the display, which is where every one of those
            // bugs actually lived.
            accepted.forEach((e) => {
              const eTag = e.tags?.find((t) => t[0] === "e");
              const reasons = [
                e.kind !== 1 ? `kind ${e.kind}, not a feed note` : null,
                eTag && noteIds.has(eTag[1]) ? `reply — shows under its parent, not top level` : null,
                deletedNoteIds.has(e.id) ? "was previously deleted, now un-deleted" : null,
              ].filter(Boolean);
              addStegoLog(
                `  ${e.id.slice(0, 8)}… ${reasons.length ? reasons.join("; ") : "will show in the feed"}`,
              );
            });
            setDetectReview(null);
          }}
        />
      )}
      {embedModalOpen && (
        <EmbedModal
          onClose={() => setEmbedModalOpen(false)}
          onConfirm={handleEmbedConfirm}
          embedding={embedding}
          stegoProgress={stegoProgress}
          embedCoverFile={embedCoverFile}
          onCoverFileChange={setEmbedCoverFile}
          recipientMode={embedRecipientMode}
          onRecipientModeChange={setEmbedRecipientMode}
          recipientInput={embedRecipientInput}
          onRecipientInputChange={setEmbedRecipientInput}
          recipients={embedRecipients}
          onRecipientsChange={setEmbedRecipients}
          profiles={profiles}
          stegoMethod={embedMethod}
          onStegoMethodChange={setEmbedMethod}
          targetPlatform={targetPlatform}
          onTargetPlatformChange={setTargetPlatform}
          pointerMode={embedPointerMode}
          networkEnabled={networkEnabled}
          onPointerModeChange={(on) => {
            setEmbedPointerMode(on);
            // Pointer mode publishes to a relay, so it cannot work offline.
            // Turning it on with Network off used to get as far as the publish
            // step and then abort (§17.8). Enabling the network here makes the
            // dependency visible at the moment of choosing, rather than as a
            // failure two steps later.
            if (on && !networkEnabled) {
              setNetworkEnabled(true);
              addStegoLog("Network turned on automatically: pointer mode publishes to a relay.");
            }
          }}
          slotOrder={embedSlotOrder}
          onSlotOrderChange={setEmbedSlotOrder}
          selectableNotes={selectableNotes(events, candidateCtx)}
          selectedNoteIds={embedNoteIds}
          onSelectedNoteIdsChange={setEmbedNoteIds}
        />
      )}

      {editProfileOpen && (
        <EditProfileModal
          onClose={() => setEditProfileOpen(false)}
          onSave={handleEditProfileSave}
          editName={editName}
          onEditNameChange={setEditName}
          editAbout={editAbout}
          onEditAboutChange={setEditAbout}
          editPicture={editPicture}
          onEditPictureChange={setEditPicture}
          editBanner={editBanner}
          onEditBannerChange={setEditBanner}
          privKeyHex={effectivePrivKey}
          networkEnabled={networkEnabled}
        />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </main>
  );
}

function AppBootstrap() {
  const [profile, setProfile] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const sync = getStorageProfileSync();
    if (sync != null) {
      setProfile(sync);
      return;
    }
    if (isWeb()) {
      setProfile(null);
      return;
    }
    getTauri()
      .then((t) => t.invoke<string | null>("get_test_profile"))
      .then((p) => setProfile(p ?? null))
      .catch(() => setProfile(null));
  }, []);
  if (profile === undefined) return <p className="muted" style={{ padding: "2rem" }}>Loading…</p>;
  return <App profile={profile} />;
}

export default AppBootstrap;
