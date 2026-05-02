import type { Track } from "../types";

/**
 * Filtra tracks por substring match en title/artist/album. La query se
 * tokeniza por espacios; cada token tiene que aparecer (case-insensitive)
 * en algún campo. AND entre tokens, no OR.
 *
 * Ejemplos:
 *   "avic"        → matchea "Avicii — The Nights"
 *   "rock 2020"   → matchea tracks que tengan ambos en title/artist/album
 *   "" (vacío)    → devuelve todos los tracks
 */
export function filterTracks(tracks: Track[], query: string): Track[] {
  const trimmed = query.trim();
  if (!trimmed) return tracks;
  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return tracks;
  return tracks.filter((t) => {
    const haystack = [t.title, t.artist, t.album]
      .filter((s): s is string => Boolean(s))
      .join(" ")
      .toLowerCase();
    return tokens.every((tok) => haystack.includes(tok));
  });
}
