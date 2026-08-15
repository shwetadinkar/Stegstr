/** Extract image URLs from note content (plain URLs) and NIP-08 style url tags if we had them */
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)(\?|$)/i;
const URL_REGEX = /https?:\/\/[^\s<>"']+/g;

export function extractImageUrls(content: string): string[] {
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  while ((m = URL_REGEX.exec(content)) !== null) {
    const url = m[0];
    if (IMAGE_EXT.test(url)) urls.push(url);
  }
  return urls;
}

/** Get first image URL from note tags (NIP-08: url tag for images) */
export function imageUrlFromTags(tags: string[][]): string | null {
  for (const t of tags) {
    if (t[0] === "url" && t[1]) return t[1];
    if (t[0] === "im" && t[1]) return t[1]; // NIP-94 image
  }
  return null;
}

const VIDEO_EXT = /\.(mp4|webm|mov|ogv)(\?|$)/i;

/** Get all media URLs from note tags (im, url) for display */
export function mediaUrlsFromTags(tags: string[][]): string[] {
  const urls: string[] = [];
  for (const t of tags) {
    if ((t[0] === "url" || t[0] === "im") && t[1]) urls.push(t[1]);
  }
  return urls;
}

/** Check if URL is video (by extension or path) */
export function isVideoUrl(url: string): boolean {
  return VIDEO_EXT.test(url) || /\/v\//.test(url) || /video\//.test(url);
}

/** Base64-encode Uint8Array without hitting call stack limit (String.fromCharCode spread) */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

/** Content with image URLs stripped so we can show text + images separately */
export function contentWithoutImages(content: string): string {
  const t = content.replace(URL_REGEX, (url) => (IMAGE_EXT.test(url) ? " " : url)).replace(/\s{2,}/g, " ").trim();
  return t;
}

/**
 * Is this event held locally but hidden from the feed?
 *
 * The feed hides a note authored by one of your OWN identities unless you are
 * currently viewing as that identity, or the note arrived via Detect image
 * (importedEventIds). That exception exists so decoding your own feed back out
 * of an image does not require switching identities to see it.
 *
 * It matters for classification as well as display: an event that is present
 * but hidden must not be reported as a duplicate, or the user is told "you
 * already have everything" about something they cannot see and is offered no
 * way to surface it. Accepting it re-adds the id and makes it visible.
 */
export function isLocallyHidden(
  ev: { id: string; pubkey: string },
  ourPubkeys: ReadonlySet<string>,
  viewingPubkeys: ReadonlySet<string>,
  importedEventIds: ReadonlySet<string>,
): boolean {
  return ourPubkeys.has(ev.pubkey)
    && !viewingPubkeys.has(ev.pubkey)
    && !importedEventIds.has(ev.id);
}

/**
 * Take the picked files off a file input and reset it, in that order.
 *
 * `input.files` is a **live FileList bound to the element**, not a snapshot.
 * Resetting `input.value` -- which has to happen so that picking the same file
 * twice still fires `change` -- empties that FileList in place. Read it
 * afterwards and you get nothing.
 *
 * That is precisely how attaching broke: the length check passed with one
 * file, the input was cleared, and the upload loop then read a length of zero
 * and did nothing, reporting "Attached 0 file(s), 0 KB, encrypted" as a
 * success. The order of these two lines is the whole behaviour, so it lives in
 * one named place rather than being re-derived at each call site.
 *
 * Note: jsdom does NOT model the live FileList, so a test driving a real input
 * through jsdom passes either way. The test for this uses a double that
 * follows the browser's actual contract.
 */
export function takeFilesFromInput(input: HTMLInputElement): File[] {
  const files = Array.from(input.files ?? []);
  input.value = "";
  return files;
}
