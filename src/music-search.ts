// Local music search: normalization, scoring and ranking.
//
// Pure functions plus a reusable index. The index normalizes every searchable
// field once, so typing in the library panel only rescans prepared strings
// instead of re-normalizing a 10k track catalogue on each keystroke.

export type SearchField = "all" | "title" | "artist" | "album";

export type SearchableTrack = {
  title: string;
  artist: string;
  album: string;
  name: string;
  path: string;
  track: number | null;
};

type Entry<T> = {
  track: T;
  title: string;
  artist: string;
  album: string;
  name: string;
  path: string;
  number: number | null;
};

const FIELD_WEIGHT: Record<"title" | "artist" | "album" | "name", number> = {
  title: 1,
  artist: 0.86,
  album: 0.72,
  name: 0.6,
};

/** NFKC folds full-width text; lowercasing makes matching case insensitive. */
export function normalizeSearchText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

export function tokenize(query: string) {
  const normalized = normalizeSearchText(query);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
}

/** 0 = no match, 1 = inside, 2 = word start, 3 = prefix, 4 = whole field. */
function matchQuality(haystack: string, term: string) {
  const at = haystack.indexOf(term);
  if (at < 0) return 0;
  if (haystack === term) return 4;
  if (at === 0) return 3;
  const before = haystack.charCodeAt(at - 1);
  const separator =
    before === 32 ||
    before === 45 || // -
    before === 46 || // .
    before === 95 || // _
    before === 47 || // /
    before === 40 || // (
    before === 91; // [
  return separator ? 2 : 1;
}

export class MusicSearchIndex<T extends SearchableTrack> {
  private entries: Entry<T>[];

  constructor(tracks: readonly T[]) {
    this.entries = tracks.map((track) => ({
      track,
      title: normalizeSearchText(track.title),
      artist: normalizeSearchText(track.artist),
      album: normalizeSearchText(track.album),
      name: normalizeSearchText(track.name),
      path: normalizeSearchText(track.path),
      number: track.track ?? null,
    }));
  }

  search(query: string, field: SearchField = "all", limit = Infinity): T[] {
    const terms = tokenize(query);
    if (!terms.length) return this.entries.slice(0, limit).map((entry) => entry.track);
    const scored: { track: T; score: number }[] = [];
    for (const entry of this.entries) {
      const score = this.scoreEntry(entry, terms, field);
      if (score > 0) scored.push({ track: entry.track, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.track.title.localeCompare(b.track.title, "zh-Hans-CN") ||
        a.track.path.localeCompare(b.track.path),
    );
    return scored.slice(0, limit).map((item) => item.track);
  }

  private scoreEntry(entry: Entry<T>, terms: string[], field: SearchField) {
    let total = 0;
    for (const term of terms) {
      let best = 0;
      if (field === "all" || field === "title") best = Math.max(best, matchQuality(entry.title, term) * FIELD_WEIGHT.title);
      if (field === "all" || field === "artist") best = Math.max(best, matchQuality(entry.artist, term) * FIELD_WEIGHT.artist);
      if (field === "all" || field === "album") best = Math.max(best, matchQuality(entry.album, term) * FIELD_WEIGHT.album);
      if (field === "all") {
        best = Math.max(best, matchQuality(entry.name, term) * FIELD_WEIGHT.name);
        best = Math.max(best, matchQuality(entry.path, term) * 0.42);
      }
      // A bare number also matches the track number, so "07" finds track 7.
      if (/^\d{1,3}$/.test(term) && entry.number === Number(term)) best = Math.max(best, 2.2);
      if (!best) return 0;
      total += best;
    }
    return total;
  }
}

export type Segment = { text: string; hit: boolean };

/** Splits text into highlighted/plain segments for the result rows. */
export function matchSegments(text: string, terms: string[]): Segment[] {
  if (!terms.length || !text) return [{ text, hit: false }];
  // Only highlight when normalization preserves the character count, otherwise
  // the marked ranges would drift away from the visible text.
  const haystack = text.normalize("NFKC").toLowerCase();
  if (haystack.length !== text.length) return [{ text, hit: false }];
  const marks = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(term, from);
      if (at < 0) break;
      for (let i = at; i < Math.min(at + term.length, marks.length); i++) marks[i] = true;
      from = at + term.length;
    }
  }
  const segments: Segment[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marks[i] !== marks[start]) {
      segments.push({ text: text.slice(start, i), hit: marks[start] });
      start = i;
    }
  }
  return segments;
}

export function formatDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "--:--";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function formatLibrarySize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}
