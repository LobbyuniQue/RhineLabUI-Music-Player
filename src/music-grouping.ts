// Music archive grouping (2.0): fold the local library into album / artist /
// initial-letter columns and present tracks as archive records.

import { buildView, type ArchiveView, type ArchiveRecord } from "./archive-view.ts";
import { formatDuration, formatLibrarySize } from "./music-search.ts";
import type { LibraryTrack } from "./music-library.ts";

export type MusicGrouping = "album" | "artist" | "letter";
export const MUSIC_GROUPINGS: [MusicGrouping, string][] = [
  ["album", "按专辑"],
  ["artist", "按歌手"],
  ["letter", "按歌名首字母"],
];

const UNKNOWN_ALBUM = "未标记专辑";
const UNKNOWN_ARTIST = "未知艺术家";
const LETTER_OTHER = "#";

const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

// Pinyin initial lookup through the zh-Hans-CN (pinyin) collation: every hanzi
// compares against the first character of each pinyin bucket. ICU orders hanzi
// by pinyin, so the last boundary not greater than the character gives its
// initial. Characters the collation cannot place keep the "#" fallback.
const INITIAL_BOUNDS: [string, string][] = [
  ["啊", "A"], ["芭", "B"], ["擦", "C"], ["搭", "D"], ["蛾", "E"], ["发", "F"],
  ["噶", "G"], ["哈", "H"], ["击", "J"], ["喀", "K"], ["垃", "L"], ["妈", "M"],
  ["拿", "N"], ["哦", "O"], ["啪", "P"], ["期", "Q"], ["然", "R"], ["撒", "S"],
  ["塌", "T"], ["挖", "W"], ["昔", "X"], ["压", "Y"], ["匝", "Z"],
];

export function nameInitial(name: string): string {
  const ch = [...name.trim()][0] ?? "";
  if (/[a-z]/i.test(ch)) return ch.toUpperCase();
  if (!/[一-鿿]/.test(ch)) return LETTER_OTHER;
  // Same-pinyin ties break by stroke count in ICU (阿 < 啊), so the first
  // bucket is the default until a boundary passes the character. Rare glyphs
  // the collation cannot place land in the nearest extreme bucket.
  let initial = "A";
  for (const [bound, letter] of INITIAL_BOUNDS) {
    if (collator.compare(ch, bound) >= 0) initial = letter;
    else break;
  }
  return initial;
}

function groupKey(track: LibraryTrack, grouping: MusicGrouping): string {
  if (grouping === "album") return track.album.trim() || UNKNOWN_ALBUM;
  if (grouping === "artist") return track.artist.trim() || UNKNOWN_ARTIST;
  return nameInitial(track.title);
}

function compareTracks(grouping: MusicGrouping, a: LibraryTrack, b: LibraryTrack): number {
  if (grouping === "artist") {
    return (
      collator.compare(a.album, b.album) ||
      (a.disc ?? 0) - (b.disc ?? 0) ||
      (a.track ?? 0) - (b.track ?? 0) ||
      collator.compare(a.title, b.title)
    );
  }
  if (grouping === "letter") {
    return collator.compare(a.title, b.title) || collator.compare(a.artist, b.artist) || collator.compare(a.album, b.album) || (a.track ?? 0) - (b.track ?? 0);
  }
  return (a.disc ?? 0) - (b.disc ?? 0) || (a.track ?? 0) - (b.track ?? 0) || collator.compare(a.title, b.title);
}

function compareColumns(grouping: MusicGrouping, a: string, b: string): number {
  const unknown = (name: string) => name === UNKNOWN_ALBUM || name === UNKNOWN_ARTIST;
  if (unknown(a) !== unknown(b)) return unknown(a) ? 1 : -1;
  if (grouping === "letter") {
    if ((a === LETTER_OTHER) !== (b === LETTER_OTHER)) return a === LETTER_OTHER ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return collator.compare(a, b);
}

function trackToRecord(track: LibraryTrack, order: number, group: string): ArchiveRecord {
  const format = (track.codec || "audio").toUpperCase();
  const duration = formatDuration(track.duration ?? 0);
  const artist = track.artist.trim() || UNKNOWN_ARTIST;
  const album = track.album.trim() || UNKNOWN_ALBUM;
  const year = track.year.trim();
  const size = track.size ? formatLibrarySize(track.size) : "";
  const discTrack = track.track
    ? `曲号：第 ${track.track} 首${track.disc ? ` · 第 ${track.disc} 碟` : ""}`
    : "";
  return {
    id: `M-${String(order).padStart(3, "0")}`,
    title: track.title,
    en: artist,
    department: album,
    category: group,
    date: year || "未标年份",
    lead: artist,
    clearance: format,
    abstract: `${track.title} — ${artist} · ${album}${year ? ` · ${year}` : ""} · ${duration} · ${format}`,
    findings: [
      `文件名：${track.name}`,
      `位置：${track.path}`,
      `规格：${format} · ${duration}${size ? ` · ${size}` : ""}`,
      discTrack,
      track.genre.trim() ? `流派：${track.genre.trim()}` : "",
    ].filter(Boolean),
    source: "",
  };
}

/** Music view carrying the flattened tracks behind its records (covers/playback). */
export interface MusicArchiveView extends ArchiveView {
  musicTracks: readonly LibraryTrack[];
}

/** Builds the music archive view: columns are groups, records their tracks. */
export function buildMusicView(tracks: readonly LibraryTrack[], grouping: MusicGrouping): MusicArchiveView {
  const groups = new Map<string, LibraryTrack[]>();
  for (const track of tracks) {
    const key = groupKey(track, grouping);
    const list = groups.get(key);
    if (list) list.push(track);
    else groups.set(key, [track]);
  }
  const columns = [...groups.keys()].sort((a, b) => compareColumns(grouping, a, b));
  const laneByGroup = new Map(columns.map((name, lane) => [name, lane]));
  const records: ArchiveRecord[] = [];
  const flat: LibraryTrack[] = [];
  for (const name of columns) {
    const list = groups.get(name)!.sort((a, b) => compareTracks(grouping, a, b));
    for (const track of list) {
      records.push(trackToRecord(track, records.length + 1, name));
      flat.push(track);
    }
  }
  const view = buildView("music", columns, undefined, records, (record) => laneByGroup.get(record.category) ?? 0, (index) => flat[index].id);
  return { ...view, musicTracks: flat };
}

/** Normalized group label reused by settings UI and HUD copy. */
export function groupingLabel(grouping: MusicGrouping): string {
  return MUSIC_GROUPINGS.find(([key]) => key === grouping)?.[1] ?? MUSIC_GROUPINGS[0][1];
}
