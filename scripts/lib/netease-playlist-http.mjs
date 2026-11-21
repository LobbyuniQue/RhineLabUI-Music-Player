import { NeteasePlaylistError, readNeteasePlaylist } from "./netease-playlist.mjs";

const endpoint = "/api/netease/playlist";

// The Vite server, local build preview and Pages Function share one response format.
export async function playlistResponse({ method, url, signal }) {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (method !== "GET") {
    return Response.json({ error: "请使用 GET 读取歌单。" }, {
      status: 405, headers: { ...headers, Allow: "GET" },
    });
  }
  const source = new URL(url).searchParams.get("source") ?? "";
  try {
    const playlist = await readNeteasePlaylist(source, { signal });
    return Response.json(playlist, { headers });
  } catch (error) {
    if (error instanceof NeteasePlaylistError)
      return Response.json({ error: error.message }, { status: error.status, headers });
    return Response.json({ error: "暂时无法连接网易云音乐，请稍后重试。" }, { status: 502, headers });
  }
}

export async function neteasePlaylistMiddleware(req, res, next) {
  if (req.url?.split("?", 1)[0] !== endpoint) return next();
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  res.once("close", disconnect);
  try {
    const response = await playlistResponse({
      method: req.method, url: "http://localhost" + req.url, signal: controller.signal,
    });
    const body = await response.text();
    if (!res.destroyed) res.writeHead(response.status, Object.fromEntries(response.headers)).end(body);
  } catch (error) {
    next(error);
  } finally {
    res.off("close", disconnect);
  }
}
