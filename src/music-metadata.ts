// Local music metadata reader.
//
// Tags are read with random access, so a 60 MB lossless file is never held in
// memory: only the ID3v2 tag, the container header and the trailing 128 bytes
// for ID3v1 are touched. Containers: mp3 (ID3v2.2/2.3/2.4 + ID3v1), flac,
// mp4/m4a, ogg (vorbis/opus), wav. Anything unreadable falls back to the file
// name instead of throwing, so one broken file never stops a library scan.

export type TrackPicture = { mime: string; data: Uint8Array };

export type TrackMeta = {
  title: string;
  artist: string;
  album: string;
  track: number | null;
  disc: number | null;
  year: string;
  genre: string;
  /** Seconds, or null when the container does not expose it cheaply. */
  duration: number | null;
  /** Container id used for the library chip: mp3 / flac / m4a / ogg ... */
  codec: string;
  picture: TrackPicture | null;
  /** True when at least one real tag field was found (not just the file name). */
  tagged: boolean;
};

export const AUDIO_EXTENSIONS = [
  "mp3",
  "flac",
  "m4a",
  "mp4",
  "aac",
  "ogg",
  "oga",
  "opus",
  "wav",
  "wave",
] as const;

const MAX_TAG_BYTES = 16 * 1024 * 1024;
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;

export const emptyMeta = (): TrackMeta => ({
  title: "",
  artist: "",
  album: "",
  track: null,
  disc: null,
  year: "",
  genre: "",
  duration: null,
  codec: "",
  picture: null,
  tagged: false,
});

export function extensionOf(name: string) {
  const match = /\.([A-Za-z0-9]+)$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

export function isAudioFile(name: string) {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/** Splits "01 - Artist - Title.mp3" style names into fallback fields. */
export function metaFromFileName(name: string) {
  const base = name.replace(/\.[A-Za-z0-9]+$/, "").trim();
  let track: number | null = null;
  let rest = base;
  const numbered = /^(\d{1,3})\s*[-._、)\]]\s*(.+)$/.exec(base);
  if (numbered) {
    track = Number(numbered[1]);
    rest = numbered[2].trim();
  }
  const parts = rest.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const title = parts[parts.length - 1].trim();
    const artist = parts.slice(0, -1).join(" - ").trim();
    return { title: title || rest, artist, album: "", track };
  }
  return { title: rest || name, artist: "", album: "", track };
}

/** TextDecoder is missing some legacy labels on a few hosts; guard the lookup. */
function decoder(label: string) {
  try {
    return new TextDecoder(label, { fatal: false });
  } catch {
    return null;
  }
}

const utf8 = decoder("utf-8")!;
const utf16le = decoder("utf-16le");
const utf16be = decoder("utf-16be");
const gbk = decoder("gbk") ?? decoder("gb18030") ?? decoder("big5");

/**
 * Latin-1 tags written by older Chinese rippers are really GBK bytes. Decoding
 * them as west-european yields a run of U+0080..U+00FF characters, which is a
 * reliable signal to retry with GBK.
 */
function decodeLegacy(bytes: Uint8Array) {
  const latin = new TextDecoder("latin1").decode(bytes).replace(/\0+$/, "");
  let suspicious = 0;
  for (const char of latin) if (char.charCodeAt(0) >= 0x80) suspicious++;
  if (suspicious >= 2 && gbk) {
    const retry = gbk.decode(bytes).replace(/\0+$/, " ").trim();
    if (retry && !retry.includes("\uFFFD")) return retry;
  }
  return latin.trim();
}

function decodeWithEncoding(payload: Uint8Array, encoding: number) {
  switch (encoding) {
    case 0:
      return decodeLegacy(payload);
    case 1:
      return (utf16le?.decode(payload) ?? "").replace(/\0+$/, "").trim();
    case 2:
      return (utf16be?.decode(payload) ?? "").replace(/\0+$/, "").trim();
    default:
      return utf8.decode(payload).replace(/\0+$/, "").trim();
  }
}

/** ID3v2 text frames carry [encoding][text]. */
const decodeId3Text = (payload: Uint8Array) =>
  payload.length ? decodeWithEncoding(payload.subarray(1), payload[0]) : "";

/** Byte length of the string terminator for the given ID3 encoding. */
function terminatorLength(bytes: Uint8Array, encoding: number) {
  if (encoding === 1 || encoding === 2) {
    for (let i = 0; i + 1 < bytes.length; i += 2)
      if (bytes[i] === 0 && bytes[i + 1] === 0) return i + 2;
    return bytes.length;
  }
  const end = bytes.indexOf(0);
  return end < 0 ? bytes.length : end + 1;
}

class ByteReader {
  private head?: Uint8Array;
  private readonly blob: Blob;

  constructor(blob: Blob) {
    this.blob = blob;
  }

  get size() {
    return this.blob.size;
  }

  /** First bytes, cached: every parser inspects them. */
  async prefix(length = HEAD_BYTES) {
    const wanted = Math.min(length, this.size);
    if (!this.head || this.head.length < wanted) this.head = await this.bytes(0, wanted);
    return this.head;
  }

  async bytes(offset: number, length: number) {
    const start = Math.max(0, Math.min(offset, this.size));
    const end = Math.max(start, Math.min(offset + length, this.size));
    if (end <= start) return new Uint8Array(0);
    return new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
  }
}

const ascii = (bytes: Uint8Array, offset: number, length: number) => {
  let text = "";
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[offset + i] ?? 0);
  return text;
};

const indexOfAscii = (bytes: Uint8Array, text: string, from = 0) => {
  const first = text.charCodeAt(0);
  for (let i = Math.max(0, from); i + text.length <= bytes.length; i++) {
    if (bytes[i] !== first) continue;
    let hit = true;
    for (let j = 1; j < text.length; j++)
      if (bytes[i + j] !== text.charCodeAt(j)) {
        hit = false;
        break;
      }
    if (hit) return i;
  }
  return -1;
};

const syncSafe = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] & 0x7f) << 21) |
  ((bytes[offset + 1] & 0x7f) << 14) |
  ((bytes[offset + 2] & 0x7f) << 7) |
  (bytes[offset + 3] & 0x7f);

const u32be = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;

const u32le = (bytes: Uint8Array, offset: number) =>
  (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;

const u64le = (bytes: Uint8Array, offset: number) =>
  u32le(bytes, offset) + u32le(bytes, offset + 4) * 4294967296;

/** "3/12" → 3, "1" → 1, junk → null. */
function leadingNumber(value: string): number | null {
  const match = /^\s*(\d{1,4})/.exec(value);
  return match ? Number(match[1]) : null;
}

// ------------------------------------------------------------------ ID3 tags

const LEGACY_FRAME_IDS: Record<string, string> = {
  TT2: "TIT2",
  TP1: "TPE1",
  TAL: "TALB",
  TRK: "TRCK",
  TPA: "TPOS",
  TCO: "TCON",
  TYE: "TYER",
  PIC: "APIC",
};

function parseId3v2(bytes: Uint8Array, meta: TrackMeta) {
  const major = bytes[3];
  const flags = bytes[5];
  const tagSize = syncSafe(bytes, 6);
  const end = Math.min(bytes.length, 10 + tagSize);
  const total = 10 + tagSize + (major === 4 && flags & 0x10 ? 10 : 0);
  let offset = 10;
  if (major >= 3 && flags & 0x40) {
    if (offset + 4 > end) return { total };
    // v2.3 excludes its four size bytes; v2.4 includes them.
    const length = major === 3 ? 4 + u32be(bytes, offset) : syncSafe(bytes, offset);
    if (length < (major === 3 ? 10 : 6) || offset + length > end) return { total };
    offset += length;
  }

  if (major === 2) {
    while (offset + 6 <= end) {
      const id = ascii(bytes, offset, 3);
      if (!/^[A-Z0-9]{3}$/.test(id)) break;
      const size = (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5];
      if (size <= 0 || offset + 6 + size > end) break;
      applyId3Frame(LEGACY_FRAME_IDS[id] ?? id, bytes.subarray(offset + 6, offset + 6 + size), meta, id === "PIC");
      offset += 6 + size;
    }
  } else {
    const syncsafeSizes = major >= 4;
    while (offset + 10 <= end) {
      const id = ascii(bytes, offset, 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = syncsafeSizes ? syncSafe(bytes, offset + 4) : u32be(bytes, offset + 4);
      if (size <= 0 || offset + 10 + size > end) break;
      applyId3Frame(id, bytes.subarray(offset + 10, offset + 10 + size), meta, false);
      offset += 10 + size;
    }
  }
  return { total };
}

function applyId3Frame(id: string, payload: Uint8Array, meta: TrackMeta, legacyPicture: boolean) {
  const text = () => decodeId3Text(payload);
  switch (id) {
    case "TIT2":
      meta.title = meta.title || text();
      meta.tagged = true;
      break;
    case "TPE1":
      meta.artist = meta.artist || text();
      meta.tagged = true;
      break;
    case "TALB":
      meta.album = meta.album || text();
      meta.tagged = true;
      break;
    case "TRCK":
      meta.track = meta.track ?? leadingNumber(text());
      break;
    case "TPOS":
      meta.disc = meta.disc ?? leadingNumber(text());
      break;
    case "TCON":
      meta.genre = meta.genre || text().replace(/^\(\d+\)/, "").trim();
      break;
    case "TYER":
    case "TDRC":
      meta.year = meta.year || text().slice(0, 4);
      break;
    case "APIC": {
      if (meta.picture) break;
      const encoding = payload[0];
      let cursor = 1;
      let mime = "image/jpeg";
      if (legacyPicture) {
        const format = ascii(payload, cursor, 3).toUpperCase();
        mime = format === "PNG" ? "image/png" : "image/jpeg";
        cursor += 3;
      } else {
        const end = payload.indexOf(0, cursor);
        mime = ascii(payload, cursor, (end < 0 ? payload.length : end) - cursor) || mime;
        cursor = end < 0 ? payload.length : end + 1;
      }
      cursor += 1; // picture type
      cursor += terminatorLength(payload.subarray(cursor), encoding);
      const data = payload.subarray(cursor);
      if (data.length > 64 && data.length <= MAX_PICTURE_BYTES)
        meta.picture = { mime, data: new Uint8Array(data) };
      break;
    }
    default:
      break;
  }
}

function parseId3v1(bytes: Uint8Array, meta: TrackMeta) {
  const field = (offset: number, length: number) => {
    const slice = bytes.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return decodeLegacy(end < 0 ? slice : slice.subarray(0, end));
  };
  meta.title = meta.title || field(3, 30);
  meta.artist = meta.artist || field(33, 30);
  meta.album = meta.album || field(63, 30);
  meta.year = meta.year || field(93, 4);
  meta.track = meta.track ?? (bytes[125] === 0 ? leadingNumber(String(bytes[126])) : null);
  meta.genre = meta.genre || field(127, 30);
  if (meta.title || meta.artist || meta.album) meta.tagged = true;
}

// ---------------------------------------------------------------- mp3 frames

const MPEG1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const MPEG1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const MPEG2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

type Mp3Frame = { bitrate: number; sampleRate: number; samplesPerFrame: number };

function readMp3Frame(bytes: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > bytes.length) return null;
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (bytes[offset + 1] >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layerBits = (bytes[offset + 1] >> 1) & 0x03; // 3 = L1, 2 = L2, 1 = L3
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
  const rateIndex = (bytes[offset + 2] >> 2) & 0x03;
  if (versionBits === 1 || layerBits === 0 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3)
    return null;
  const layer = 4 - layerBits;
  const table =
    versionBits === 3
      ? layer === 1
        ? MPEG1_L1
        : layer === 2
          ? MPEG1_L2
          : MPEG1_L3
      : layer === 1
        ? MPEG2_L1
        : MPEG2_L23;
  const bitrate = table[bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[versionBits][rateIndex];
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : versionBits === 3 ? 1152 : 576;
  if (!bitrate || !sampleRate) return null;
  return { bitrate, sampleRate, samplesPerFrame };
}

function parseMp3(bytes: Uint8Array, fileSize: number, audioOffset: number, meta: TrackMeta, name: string) {
  for (let offset = audioOffset; offset + 4 <= bytes.length && offset < audioOffset + 4096; offset++) {
    const frame = readMp3Frame(bytes, offset);
    if (!frame) continue;
    meta.codec = "mp3";
    // Xing/Info lives at a layer dependent offset inside the first frame.
    const sideInfo = frame.sampleRate >= 32000 ? 32 : 17;
    const markerAt = offset + 4 + sideInfo;
    const marker = ascii(bytes, markerAt, 4);
    if (marker === "Xing" || marker === "Info") {
      const flags = u32be(bytes, markerAt + 4);
      if (flags & 0x01) {
        const frames = u32be(bytes, markerAt + 8);
        if (frames > 0) meta.duration = (frames * frame.samplesPerFrame) / frame.sampleRate;
      }
    }
    if (meta.duration === null) meta.duration = ((fileSize - offset) * 8) / frame.bitrate;
    return;
  }
  // No audio frame at all (truncated or unrecognized): trust the extension.
  meta.codec = meta.codec || extensionOf(name) || "mp3";
}

// --------------------------------------------------------------------- flac

function parseFlac(bytes: Uint8Array, meta: TrackMeta) {
  meta.codec = "flac";
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const start = offset + 4;
    const block = bytes.subarray(start, Math.min(start + length, bytes.length));

    if (type === 0 && block.length >= 18) {
      const sampleRate = (block[10] << 12) | (block[11] << 4) | (block[12] >> 4);
      const totalSamples =
        (block[13] & 0x0f) * 4294967296 +
        u32be(block, 14);
      if (sampleRate > 0 && totalSamples > 0) meta.duration = totalSamples / sampleRate;
    } else if (type === 4) {
      parseVorbisComment(block, meta);
    } else if (type === 6 && !meta.picture) {
      let cursor = 4;
      const mimeLength = u32be(block, cursor);
      cursor += 4;
      const mime = ascii(block, cursor, mimeLength) || "image/jpeg";
      cursor += mimeLength;
      const descriptionLength = u32be(block, cursor);
      cursor += 4 + descriptionLength + 16;
      const dataLength = u32be(block, cursor);
      cursor += 4;
      if (dataLength > 64 && dataLength <= MAX_PICTURE_BYTES && cursor + dataLength <= block.length)
        meta.picture = { mime, data: new Uint8Array(block.subarray(cursor, cursor + dataLength)) };
    }
    if (last || length <= 0) break;
    offset = start + length;
  }
}

function parseVorbisComment(block: Uint8Array, meta: TrackMeta) {
  let cursor = 0;
  const vendorLength = u32le(block, cursor);
  cursor += 4 + vendorLength;
  if (cursor + 4 > block.length) return;
  const count = u32le(block, cursor);
  cursor += 4;
  for (let i = 0; i < count && cursor + 4 <= block.length; i++) {
    const length = u32le(block, cursor);
    cursor += 4;
    if (cursor + length > block.length) return;
    const entry = utf8.decode(block.subarray(cursor, cursor + length));
    cursor += length;
    const split = entry.indexOf("=");
    if (split <= 0) continue;
    const key = entry.slice(0, split).toUpperCase();
    const value = entry.slice(split + 1).trim();
    if (!value) continue;
    switch (key) {
      case "TITLE":
        meta.title = meta.title || value;
        meta.tagged = true;
        break;
      case "ARTIST":
        meta.artist = meta.artist || value;
        meta.tagged = true;
        break;
      case "ALBUMARTIST":
        meta.artist = meta.artist || value;
        break;
      case "ALBUM":
        meta.album = meta.album || value;
        meta.tagged = true;
        break;
      case "TRACKNUMBER":
        meta.track = meta.track ?? leadingNumber(value);
        break;
      case "DISCNUMBER":
        meta.disc = meta.disc ?? leadingNumber(value);
        break;
      case "DATE":
      case "YEAR":
        meta.year = meta.year || value.slice(0, 4);
        break;
      case "GENRE":
        meta.genre = meta.genre || value;
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------- mp4

const MP4_CONTAINERS = new Set(["moov", "udta", "meta", "ilst", "trak", "mdia", "minf", "stbl"]);
const MP4_ITEM_KEYS = new Set(["©nam", "©ART", "aART", "©alb", "©day", "©gen", "trkn", "disk", "covr"]);

type Mp4Atoms = {
  values: Map<string, Uint8Array>;
  duration: number | null;
};

/** Walks an in-memory moov body; ilst items hold one "data" atom each. */
function walkMp4(bytes: Uint8Array, start: number, end: number, depth: number, out: Mp4Atoms) {
  if (depth > 6) return;
  let offset = start;
  while (offset + 8 <= end) {
    const size = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let payload = offset + 8;
    let total = size;
    if (size === 1) {
      if (offset + 16 > end) return;
      total = u32be(bytes, offset + 8) * 4294967296 + u32be(bytes, offset + 12);
      payload = offset + 16;
    } else if (size === 0) {
      total = end - offset;
    }
    if (total < 8 || offset + total > end) return;

    if (type === "mvhd") {
      const version = bytes[payload];
      const timescale = version === 1 ? u32be(bytes, payload + 20) : u32be(bytes, payload + 12);
      const raw = version === 1 ? u32be(bytes, payload + 24) : u32be(bytes, payload + 16);
      if (timescale > 0 && raw > 0) out.duration = raw / timescale;
    } else if (MP4_CONTAINERS.has(type)) {
      walkMp4(bytes, payload + (type === "meta" ? 4 : 0), offset + total, depth + 1, out);
    } else if (MP4_ITEM_KEYS.has(type)) {
      collectMp4Item(bytes, payload, offset + total, type, out);
    }
    offset += total;
  }
}

/** An ilst item is a shallow container holding exactly one "data" atom. */
function collectMp4Item(bytes: Uint8Array, start: number, end: number, key: string, out: Mp4Atoms) {
  let offset = start;
  while (offset + 8 <= end) {
    const size = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let total = size;
    let payload = offset + 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      total = u32be(bytes, offset + 8) * 4294967296 + u32be(bytes, offset + 12);
      payload = offset + 16;
    } else if (size === 0) {
      total = end - offset;
    }
    if (total < 8 || offset + total > end) return;
    if (type === "data") {
      out.values.set(key, bytes.subarray(payload + 8, offset + total));
      return;
    }
    offset += total;
  }
}

function parseMp4(reader: ByteReader, head: Uint8Array, meta: TrackMeta) {
  return (async () => {
    meta.codec = "m4a";
    let offset = 0;
    const limit = reader.size;
    while (offset + 8 <= limit) {
      const header = offset === 0 ? head : await reader.bytes(offset, 16);
      if (header.length < 8) break;
      const size = u32be(header, 0);
      const type = ascii(header, 4, 4);
      let total = size;
      if (size === 1) {
        if (header.length < 16) break;
        total = u32be(header, 8) * 4294967296 + u32be(header, 12);
      } else if (size === 0) {
        total = limit - offset;
      }
      if (total < 8) break;
      if (type === "moov") {
        const body = await reader.bytes(offset + 8, Math.min(total - 8, MAX_TAG_BYTES));
        const atoms: Mp4Atoms = { values: new Map(), duration: null };
        walkMp4(body, 0, body.length, 0, atoms);
        const text = (key: string) => {
          const raw = atoms.values.get(key);
          return raw ? utf8.decode(raw).replace(/\0+$/, "").trim() : "";
        };
        meta.title = meta.title || text("©nam");
        meta.artist = meta.artist || text("©ART") || text("aART");
        meta.album = meta.album || text("©alb");
        meta.year = meta.year || text("©day").slice(0, 4);
        meta.genre = meta.genre || text("©gen");
        const track = atoms.values.get("trkn");
        if (track && track.length >= 4) meta.track = meta.track ?? ((track[2] << 8) | track[3]);
        const disc = atoms.values.get("disk");
        if (disc && disc.length >= 4) meta.disc = meta.disc ?? ((disc[2] << 8) | disc[3]);
        const cover = atoms.values.get("covr");
        if (cover && cover.length > 64 && cover.length <= MAX_PICTURE_BYTES && !meta.picture) {
          const jpeg = cover[0] === 0xff && cover[1] === 0xd8;
          meta.picture = { mime: jpeg ? "image/jpeg" : "image/png", data: new Uint8Array(cover) };
        }
        if (meta.title || meta.artist || meta.album) meta.tagged = true;
        if (meta.duration === null && atoms.duration !== null) meta.duration = atoms.duration;
        break;
      }
      offset += total;
    }
  })();
}

// ---------------------------------------------------------------------- ogg

function parseOgg(reader: ByteReader, head: Uint8Array, meta: TrackMeta) {
  return (async () => {
    meta.codec = "ogg";
    let sampleRate = 0;
    let preSkip = 0;

    const opusHead = indexOfAscii(head, "OpusHead");
    const vorbisHead = indexOfAscii(head, "vorbis");
    if (opusHead >= 0) {
      meta.codec = "opus";
      preSkip = head[opusHead + 10] | (head[opusHead + 11] << 8);
      sampleRate = 48000;
    } else if (vorbisHead > 0) {
      // \x01vorbis → version(4) channels(1) sampleRate(4)
      sampleRate = u32le(head, vorbisHead + 6 + 4 + 1);
    }

    const opusTags = indexOfAscii(head, "OpusTags");
    const vorbisTags = indexOfAscii(head, "\u0003vorbis");
    if (opusTags >= 0) parseVorbisComment(head.subarray(opusTags + 8), meta);
    else if (vorbisTags >= 0) parseVorbisComment(head.subarray(vorbisTags + 7), meta);

    if (reader.size > 0 && sampleRate > 0) {
      const tail = await reader.bytes(Math.max(0, reader.size - TAIL_BYTES), TAIL_BYTES);
      for (let i = tail.length - 27; i >= 0; i--) {
        if (ascii(tail, i, 4) !== "OggS") continue;
        const granules = u64le(tail, i + 6);
        if (granules > 0) meta.duration = Math.max(0, granules - preSkip) / sampleRate;
        break;
      }
    }
    if (meta.title || meta.artist || meta.album) meta.tagged = true;
  })();
}

// ---------------------------------------------------------------------- wav

function parseWav(reader: ByteReader, head: Uint8Array, meta: TrackMeta) {
  return (async () => {
    meta.codec = "wav";
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= head.length) {
      const type = ascii(head, offset, 4);
      const size = u32le(head, offset + 4);
      if (type === "fmt ") byteRate = u32le(head, offset + 16);
      else if (type === "data") dataSize = size;
      if (byteRate && dataSize) break;
      offset += 8 + size + (size % 2);
    }
    if (!dataSize) dataSize = Math.max(0, reader.size - 44);
    if (byteRate > 0) meta.duration = dataSize / byteRate;
  })();
}

// -------------------------------------------------------------------- entry

export async function readTrackMeta(blob: Blob, name: string): Promise<TrackMeta> {
  const meta = emptyMeta();
  const fallback = metaFromFileName(name);
  try {
    const reader = new ByteReader(blob);
    const head = await reader.prefix();
    let audioOffset = 0;

    if (head.length >= 10 && ascii(head, 0, 3) === "ID3") {
      audioOffset = parseId3v2(head, meta).total;
      const declared = 10 + syncSafe(head, 6);
      if (declared > head.length) {
        // A large embedded cover is cut off by the cached head.
        parseId3v2(await reader.bytes(0, Math.min(declared, MAX_TAG_BYTES)), meta);
      }
    }

    if (head.length >= 4 && ascii(head, 0, 4) === "fLaC") parseFlac(head, meta);
    else if (head.length >= 12 && ascii(head, 4, 4) === "ftyp") await parseMp4(reader, head, meta);
    else if (head.length >= 4 && ascii(head, 0, 4) === "OggS") await parseOgg(reader, head, meta);
    else if (head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE")
      await parseWav(reader, head, meta);
    else parseMp3(head, blob.size, audioOffset, meta, name);

    if (blob.size >= 128) {
      const tail = await reader.bytes(blob.size - 128, 128);
      if (ascii(tail, 0, 3) === "TAG") parseId3v1(tail, meta);
    }
  } catch {
    // Malformed file: keep whatever was parsed and fall through to the name.
  }

  if (!meta.codec) meta.codec = extensionOf(name) || "audio";
  meta.title = meta.title.trim() || fallback.title;
  meta.artist = meta.artist.trim() || fallback.artist;
  meta.album = meta.album.trim() || fallback.album;
  meta.track = meta.track ?? fallback.track;
  return meta;
}
