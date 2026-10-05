// File names for saves (pure). 98 long file names: letters of any language, digits, spaces, dots, dashes and
// underscores; anything else becomes one underscore, and none are left dangling at the ends.

/** The extensions this app reads or writes (only these are taken off a typed name: "holiday.v2" stays). */
export const KNOWN_EXT = /\.(jpe?g|png|webp|gif|bmp|rfg|jpegit|json|zip|avi|mp4|img)$/i;

export function safeFileName(s: string, fallback = 'Untitled'): string {
  const t = s
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} ._-]+/gu, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_ .]+|[_ .]+$/g, '');
  return t || fallback;
}

export function stripKnownExt(s: string): string {
  return s.replace(KNOWN_EXT, '');
}
