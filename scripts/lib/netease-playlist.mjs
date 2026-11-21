// Read only the song links that NetEase publishes on its visitor-facing page.
// Keep request construction here so callers never fetch a pasted URL directly.
const musicOrigin = "https://music.163.com";
const decimalId = /^[1-9]\d{0,19}$/;
const maxPageBytes = 6 * 1024 * 1024;
const invalidSource = "请输入网易云音乐歌单 ID、歌单链接或分享文本。";
const unavailable = "网易云未提供该歌单的公开曲目列表，请检查歌单是否公开。";

export class NeteasePlaylistError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseUrl(value, base) {
  try { return new URL(value, base); }
  catch { return null; }
}

function playlistId(url) {
  if (!url || !["http:", "https:"].includes(url.protocol) || url.hostname !== "music.163.com" ||
      url.username || url.password || url.port) return null;
  // The browser's hash route contains the actual path and query.
  const route = url.pathname === "/" && url.hash.startsWith("#/")
    ? parseUrl(url.hash.slice(1), url.origin) : url;
  if (!route || route.origin !== url.origin ||
      !/^\/(?:m\/)?playlist\/?$/.test(route.pathname)) return null;
  const ids = route.searchParams.getAll("id");
  return ids.length === 1 && decimalId.test(ids[0]) ? ids[0] : null;
}

function sourceReference(source) {
  if (typeof source !== "string" || source.length > 2048) throw new NeteasePlaylistError(400, invalidSource);
  const input = source.trim();
  if (decimalId.test(input)) return { id: input };
  const link = input.match(/https?:\/\/[^\s<>"'，。！？（）《》【】]+/i)?.[0].replace(/[.,;)!\]]+$/, "");
  const url = link && parseUrl(link);
  const id = playlistId(url);
  if (id) return { id };
  if (url?.hostname === "163cn.tv" && !url.port && !url.username && !url.password &&
      /^\/[a-z\d]{1,32}\/?$/i.test(url.pathname)) {
    return { shortUrl: "https://163cn.tv" + url.pathname };
  }
  throw new NeteasePlaylistError(400, invalidSource);
}

function decodeText(text) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key[0] !== "#") return entities[key];
    const code = key[1] === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}

function attribute(tag, name) {
  for (const pair of tag.matchAll(/\s+([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/g)) {
    if (pair[1].toLowerCase() === name) return decodeText(pair[2] ?? pair[3] ?? pair[4]);
  }
  return null;
}

function publicListSection(html, id) {
  const tags = /<\/?div\b[^>]*>/gi;
  for (const tag of html.matchAll(tags)) {
    if (attribute(tag[0], "id") !== "song-list-pre-cache") continue;
    const key = attribute(tag[0], "data-key");
    if (key !== `track_playlist-${id}`) break;
    const start = tag.index + tag[0].length;
    tags.lastIndex = start;
    let depth = 1, next;
    while ((next = tags.exec(html))) {
      depth += next[0][1] === "/" ? -1 : 1;
      if (!depth) return html.slice(start, next.index);
    }
    break;
  }
  throw new NeteasePlaylistError(422, unavailable);
}

function parsePlaylist(html, id) {
  const headEnd = html.search(/<\/head\s*>/i);
  if (headEnd < 0) throw new NeteasePlaylistError(422, unavailable);
  const head = html.slice(0, headEnd);
  for (const tag of head.matchAll(/<(?:meta|link)\b[^>]*>/gi)) {
    const canonical = attribute(tag[0], "rel") === "canonical" ? attribute(tag[0], "href")
      : attribute(tag[0], "property") === "og:url" ? attribute(tag[0], "content") : null;
    if (canonical && playlistId(parseUrl(canonical, musicOrigin)) !== id) {
      throw new NeteasePlaylistError(422, unavailable);
    }
  }
  const title = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  const name = title && decodeText(title).replace(/\s*-\s*歌单\s*-\s*网易云音乐\s*$/, "").trim();
  if (!name) throw new NeteasePlaylistError(422, unavailable);
  const count = html.match(/<span\s+[^>]*\bid=["']playlist-track-count["'][^>]*>\s*(\d+)\s*<\/span>/i);
  const total = count && Number.isSafeInteger(Number(count[1])) ? Number(count[1]) : null;
  const section = publicListSection(html, id);
  const list = Array.from(section.matchAll(/(<ul\b[^>]*>)([\s\S]*?)<\/ul\s*>/gi))
    .find(match => attribute(match[1], "class")?.split(/\s+/).includes("f-hide"));
  if (!list) throw new NeteasePlaylistError(422, unavailable);

  const tracks = [];
  for (const entry of list[2].matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a\s*>/gi)) {
    const href = attribute(entry[1], "href");
    const song = href && parseUrl(href, musicOrigin);
    if (!song || song.origin !== musicOrigin || song.pathname !== "/song") continue;
    const songId = song.searchParams.get("id");
    const songName = decodeText(entry[2].replace(/<[^>]+>/g, "")).trim();
    if (!decimalId.test(songId ?? "") || !songName) continue;
    tracks.push({ id: songId, name: songName, artists: [], album: "" });
  }
  if ((!tracks.length && total !== 0) || (total !== null && tracks.length > total)) {
    throw new NeteasePlaylistError(422, unavailable);
  }
  return { id, name, total, tracks, partial: total === null || tracks.length < total };
}

async function readHtml(response) {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/html") || !response.body) {
    await response.body?.cancel();
    throw new NeteasePlaylistError(502, "网易云返回了无法识别的歌单页面，请稍后再试。");
  }
  const reader = response.body.getReader();
  const text = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxPageBytes) {
        await reader.cancel();
        throw new NeteasePlaylistError(502, "网易云歌单页面过大，请在官方页面查看。");
      }
      chunks.push(text.decode(value, { stream: true }));
    }
    chunks.push(text.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export async function readNeteasePlaylist(source, { fetchImpl = fetch, signal } = {}) {
  const reference = sourceReference(source);
  if (signal?.aborted) throw new NeteasePlaylistError(499, "歌单读取已取消。");
  const request = new AbortController();
  const abort = () => request.abort();
  const timer = setTimeout(abort, 12000);
  signal?.addEventListener("abort", abort, { once: true });
  const options = { redirect: "manual", credentials: "omit", headers: { Accept: "text/html" },
    signal: request.signal };
  try {
    let id = reference.id;
    if (!id) {
      const response = await fetchImpl(reference.shortUrl, options);
      await response.body?.cancel();
      const destination = response.headers.get("location");
      id = destination && response.status >= 300 && response.status < 400 && playlistId(parseUrl(destination));
      if (!id) throw new NeteasePlaylistError(422, "短链接未指向可识别的网易云歌单，请粘贴展开后的歌单链接。");
    }
    const response = await fetchImpl(`${musicOrigin}/playlist?id=${id}`, options);
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) throw new NeteasePlaylistError(429, "网易云请求过于频繁，请稍后再试。");
      if ([401, 403, 404, 410, 451].includes(response.status)) throw new NeteasePlaylistError(422, unavailable);
      throw new NeteasePlaylistError(502, "网易云暂时无法提供歌单页面，请稍后再试。");
    }
    return parsePlaylist(await readHtml(response), id);
  } catch (error) {
    if (error instanceof NeteasePlaylistError) throw error;
    if (signal?.aborted) throw new NeteasePlaylistError(499, "歌单读取已取消。");
    if (request.signal.aborted) throw new NeteasePlaylistError(504, "网易云响应超时，请稍后再试。");
    throw new NeteasePlaylistError(502, "无法连接网易云音乐，请检查网络后重试。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
