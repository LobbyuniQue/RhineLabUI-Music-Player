import { isIP } from "node:net";
import { createNeteaseAccount, NeteaseAccountError } from "./netease-account.mjs";

const actions = new Set(["status", "login", "playlists", "tracks", "quality", "logout"]);
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const loopback = address => address === "::1" || address === "::ffff:127.0.0.1" ||
  (isIP(address ?? "") === 4 && address.startsWith("127."));

// Private account operations belong to this machine. A Pages deployment only
// exposes the separate public-playlist route; it has no shared user session.
export function createAccountMiddleware(service = createNeteaseAccount()) {
  return async (req, res, next) => {
    const prefix = "/api/netease/account/";
    const path = req.url?.split("?", 1)[0] ?? "";
    if (!path.startsWith(prefix)) return next();
    function send(status, value) {
      if (!res.destroyed) res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", ...(status === 405 ? { Allow: "POST" } : {}),
      }).end(JSON.stringify(value));
    }
    if (req.method !== "POST") return send(405, { error: "账号操作需要通过本地音乐面板提交。" });
    let origin;
    try { origin = new URL(req.headers.origin); } catch { /* Missing browser origin. */ }
    if (!origin || !localHosts.has(origin.hostname) || !["http:", "https:"].includes(origin.protocol) ||
        origin.host !== req.headers.host || !loopback(req.socket.remoteAddress) ||
        req.headers["x-rhine-account"] !== "1" || req.headers["sec-fetch-site"] === "cross-site")
      return send(403, { error: "请在本机打开播放器并从音乐面板连接网易云账号。" });
    const action = path.slice(prefix.length);
    if (!actions.has(action)) return send(404, { error: "未知的账号操作。" });
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
      return send(415, { error: "账号请求需要使用 JSON。" });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once("close", cancel);
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2048) return send(413, { error: "请求内容过长。" });
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
      catch { return send(400, { error: "账号请求格式无效。" }); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return send(400, { error: "账号请求格式无效。" });
      const args = { signal: controller.signal };
      if (action === "quality") {
        if (typeof payload.id !== "string" || !/^[a-f\d]{32}$/i.test(payload.id))
          return send(400, { error: "缺少网易云的音质查询曲目标识。" });
        Object.assign(args, { id: payload.id });
        if (payload.level !== undefined) {
          if (typeof payload.level !== "string" || !/^[a-zA-Z0-9_-]{0,32}$/.test(payload.level))
            return send(400, { error: "音质档位无效。" });
          Object.assign(args, { level: payload.level });
        }
      } else if (action === "tracks") {
        if (typeof payload.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.id) ||
            !Number.isSafeInteger(payload.offset ?? 0) || (payload.offset ?? 0) < 0)
          return send(400, { error: "歌单编号或翻页位置无效。" });
        Object.assign(args, { id: payload.id, offset: payload.offset ?? 0 });
      }
      send(200, await service[action](args));
    } catch (error) {
      // Only adapter-generated user-facing errors may leave the host.
      if (error instanceof NeteaseAccountError && Number.isInteger(error.status))
        send(error.status, { error: error.message });
      else send(502, { error: "网易云账号请求失败，请检查本机配置和授权后重试。" });
    } finally {
      res.off("close", cancel);
    }
  };
}
