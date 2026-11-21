import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT } from "./workspace-paths.mjs";
import { normalizeNeteaseMembership, normalizeNeteaseTrackQualities } from "./netease-entitlements.mjs";

const cliDirectory = join(PROJECT_ROOT, ".tools", "netease-cli", "node_modules", "@music163", "ncm-cli");
const installHint = "请先在本机安装并配置网易云官方 CLI。";
const configureHint = "请在本机终端配置网易云开放平台的 App ID 与私钥。";
const loginHint = "请使用网易云音乐 App 完成官方扫码授权，再刷新账户状态。";

export class NeteaseAccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Run only the project's pinned copy. Configuration and authorization remain
// with the official CLI under the Windows user's account. Never forward raw
// output (it may contain authorization material) or accept command text.
async function runLocal(args, signal) {
  let pkg;
  try { pkg = JSON.parse(await readFile(join(cliDirectory, "package.json"), "utf8")); }
  catch { throw new NeteaseAccountError(503, installHint); }
  if (pkg.name !== "@music163/ncm-cli" || pkg.version !== "0.1.7") {
    throw new NeteaseAccountError(503, installHint);
  }
  if (signal?.aborted) throw new NeteaseAccountError(499, "账户请求已取消。");
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [join(cliDirectory, "dist", "index.js"), ...args], {
      cwd: PROJECT_ROOT, shell: false, windowsHide: true, encoding: "utf8", signal,
      timeout: 25000, maxBuffer: 3 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (signal?.aborted) return reject(new NeteaseAccountError(499, "账户请求已取消。"));
      if (error?.killed) return reject(new NeteaseAccountError(504, "网易云账户服务超时，请稍后重试。"));
      if (error && typeof error.code !== "number") return reject(new NeteaseAccountError(502, "本机网易云 CLI 未能完成请求。"));
      resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin?.end();
  });
}

const signedOut = "请先连接本机网易云账号。";
const badReply = "网易云 CLI 的返回格式无法确认，请检查 CLI 版本及应用权限。";
const identifier = value => typeof value === "string" ? value :
  Number.isSafeInteger(value) ? String(value) : "";
const title = value => typeof value === "string" ? value.trim().slice(0, 512) : "";
const setupRequired = text => /API\s*key\s*(未设置|未配置)|请先配置.{0,16}(appId|privateKey|API\s*key)/i.test(text);
const expired = text => /登录.{0,3}(已过期|失效)|token.{0,3}(已过期|失效)|重新登录|授权已过期/i.test(text);
const needsLogin = text => /未登录|尚未登录|请先登录|没有登录|未授权|未找到登录|未检测到.{0,4}登录/i.test(text) || expired(text);
const combinedText = result => result.stderr + "\n" + result.stdout;

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function readLoginState(result) {
  const raw = combinedText(result);
  if (setupRequired(raw)) return { state: "unconfigured", message: configureHint };
  if (needsLogin(raw)) return { state: "signed-out", message: expired(raw) ? "网易云授权已过期，请重新登录。" : signedOut };
  const parsed = parseJson(result.stdout);
  if (parsed?.loggedIn === false) return { state: "signed-out", message: signedOut };
  if (result.ok && (parsed?.loggedIn === true || /(?:当前|用户|账号)?已登录|登录状态[：:\s]+有效|登录成功/.test(raw))) {
    return { state: "signed-in", membership: null };
  }
  throw new NeteaseAccountError(502, "无法确认网易云登录状态，请在本机运行官方 CLI 检查授权。");
}

function resultData(result) {
  const resultJson = parseJson(result.stdout);
  // Classify command errors from the envelope, not text inside private songs.
  const diagnostic = resultJson ? title(resultJson.message) : combinedText(result);
  if (setupRequired(diagnostic)) throw new NeteaseAccountError(503, configureHint);
  if (needsLogin(diagnostic) || Number(resultJson?.code) === 401) throw new NeteaseAccountError(401, signedOut);
  if (Number(resultJson?.code) === 403) throw new NeteaseAccountError(403, "当前应用或账号缺少该查询的权限。");
  if (!result.ok) {
    throw new NeteaseAccountError(502, "网易云未完成此次查询，请核对网络、应用权限与剩余配额。");
  }
  if (!resultJson || ![200, "200"].includes(resultJson.code) || resultJson.data == null) {
    throw new NeteaseAccountError(502, badReply);
  }
  return resultJson.data;
}

function checkedLink(text) {
  for (const candidate of text.match(/https:\/\/[^\s<>"']+/g) ?? []) {
    let url;
    try { url = new URL(candidate); } catch { continue; }
    if (url.origin === "https://music.163.com" && !url.username && !url.password &&
        /(?:^|\/)(?:login|authorize|oauth2?|qrlogin)(?:\/|$)/i.test(url.pathname)) return url.href;
  }
}

const encryptedId = value => typeof value === "string" && /^[a-f\d]{32}$/i.test(value);
const pageSize = 30;
const recordLimit = 1000;
const qualityLifetime = 5 * 60 * 1000;

function keepRecent(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > recordLimit) map.delete(map.keys().next().value);
}

function playlistEntry(row, liked = false) {
  const id = row?.id;
  const name = title(row?.name);
  if (!encryptedId(id) || !name) throw new NeteaseAccountError(502, badReply);
  return { id, name, kind: liked ? "liked" : "created", total: Number.isSafeInteger(row.trackCount) ? row.trackCount : null };
}

function songRow(row) {
  const id = identifier(row?.originalId);
  const name = title(row?.name);
  if (!/^[1-9]\d{0,19}$/.test(id) || !name || !encryptedId(row.id)) throw new NeteaseAccountError(502, badReply);
  const artists = (Array.isArray(row.artists) ? row.artists : []).map(a => title(a?.name)).filter(Boolean);
  return { id, encryptedId: row.id, name, artists, album: title(row.album?.name) };
}

export function createNeteaseAccount({ run = runLocal, now = Date.now } = {}) {
  let subject = "", generation = 0, pendingLogin = null, loggingIn = false, loggingOut = false;
  const qualities = new Map(), preferences = new Map();
  function reset() {
    generation++;
    subject = "";
    pendingLogin = null;
    qualities.clear();
    preferences.clear();
  }
  function current(version) {
    if (version !== generation || loggingOut) throw new NeteaseAccountError(409, "账户连接已改变，请重新读取。");
  }
  async function query(args, signal) {
    const version = generation;
    const reply = await run(args, signal);
    current(version);
    try { return resultData(reply); }
    catch (error) {
      if (error.status === 401) reset();
      throw error;
    }
  }
  async function account(signal) {
    const version = generation;
    current(version);
    const profile = await query(["user", "info", "--userInput", "查看我的账号与会员状态"], signal);
    current(version);
    if (!encryptedId(profile.id)) throw new NeteaseAccountError(502, badReply);
    if (subject && subject !== profile.id) reset();
    subject = profile.id;
    return profile;
  }
  async function status({ signal } = {}) {
    const version = generation;
    current(version);
    let result;
    try { result = await run(["login", "--check"], signal); }
    catch (error) {
      if (error instanceof NeteaseAccountError && error.status === 503) return { state: "unconfigured", message: error.message };
      throw error;
    }
    current(version);
    const state = readLoginState(result);
    if (state.state !== "signed-in") {
      if (subject) reset();
      if (state.state === "signed-out" && pendingLogin?.expires > now()) {
        return { state: "pending", message: loginHint, loginUrl: pendingLogin.url };
      }
      return state;
    }
    const profile = await account(signal);
    pendingLogin = null;
    return { state: "signed-in", userName: title(profile.nickname), membership: normalizeNeteaseMembership(profile) };
  }
  async function favorite(signal) {
    return playlistEntry(await query(["user", "favorite", "--userInput", "查看我的红心歌单"], signal), true);
  }
  async function created(signal) {
    const result = new Map();
    const limit = 500;
    for (let offset = 0; ; offset += limit) {
      const data = await query(["playlist", "created", "--limit", String(limit), "--offset", String(offset),
        "--userInput", "查看我创建的歌单"], signal);
      if (!Array.isArray(data.records) || !Number.isSafeInteger(data.recordCount) || data.recordCount < 0) {
        throw new NeteaseAccountError(502, badReply);
      }
      const previous = result.size;
      for (const record of data.records) {
        const entry = playlistEntry(record);
        result.set(entry.id, entry);
      }
      if (offset + limit >= data.recordCount) return result;
      if (result.size === previous) throw new NeteaseAccountError(502, badReply);
    }
  }
  return {
    status,
    async login({ signal } = {}) {
      if (loggingIn || loggingOut) throw new NeteaseAccountError(409, "正在处理本机网易云账号，请稍候刷新。");
      loggingIn = true;
      const version = generation;
      try {
        const state = await status({ signal });
        if (state.state !== "signed-out") return state;
        const result = await run(["login", "--background"], signal);
        current(version);
        if (setupRequired(combinedText(result))) return { state: "unconfigured", message: configureHint };
        const loginUrl = result.ok ? checkedLink(result.stdout) : undefined;
        if (!loginUrl) return { state: "signed-out", message: "请在本机项目终端执行 npm run netease:login，用网易云音乐 App 扫码后返回这里刷新。" };
        pendingLogin = { url: loginUrl, expires: now() + 120000 };
        return { state: "pending", message: loginHint, loginUrl };
      } finally { loggingIn = false; }
    },
    async playlists({ signal } = {}) {
      await account(signal);
      const version = generation;
      const liked = await favorite(signal);
      const entries = await created(signal);
      current(version);
      entries.delete(liked.id);
      return { playlists: [liked, ...entries.values()].map(({ id, name, kind }) => ({ id, name, kind })) };
    },
    async tracks({ id, offset = 0, signal } = {}) {
      if (!encryptedId(id) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
        throw new NeteaseAccountError(400, "歌单或分页参数无效。");
      }
      await account(signal);
      const version = generation;
      const liked = await favorite(signal);
      const selected = liked.id === id ? liked : (await created(signal)).get(id);
      if (!selected) throw new NeteaseAccountError(404, "当前账号中未找到该歌单。");
      const rows = await query(["playlist", "tracks", "--playlistId", id, "--limit", String(pageSize),
        "--offset", String(offset), "--userInput", "查看我的歌单曲目"], signal);
      current(version);
      if (!Array.isArray(rows) || rows.length > pageSize) throw new NeteaseAccountError(502, badReply);
      const tracks = rows.map(songRow);
      rows.forEach((row, index) => {
        const levels = normalizeNeteaseTrackQualities(row);
        const availability = levels.length ? "available" :
          row.playFlag === false || row.visible === false ? "unavailable" : "unknown";
        keepRecent(qualities, tracks[index].encryptedId, { levels, availability, expires: now() + qualityLifetime });
        const key = tracks[index].encryptedId;
        if (!levels.some(l => l.id === preferences.get(key) && l.playable === true)) preferences.delete(key);
      });
      const hasMore = rows.length === pageSize && (selected.total === null || offset + rows.length < selected.total);
      return { tracks, hasMore };
    },
    async quality({ id, level, signal } = {}) {
      if (!encryptedId(id) || (level !== undefined && typeof level !== "string")) {
        throw new NeteaseAccountError(400, "音质请求参数无效。");
      }
      await account(signal);
      const record = qualities.get(id);
      if (!record || record.expires <= now()) throw new NeteaseAccountError(409, "请刷新当前歌单，再查看本曲的最新音质权限。");
      if (level !== undefined) {
        if (level && !record.levels.some(item => item.id === level && item.playable === true)) {
          throw new NeteaseAccountError(400, "当前账号没有获得该歌曲在此音质下的可播确认。");
        }
        if (level) keepRecent(preferences, id, level);
        else preferences.delete(id);
      }
      return { levels: record.levels, availability: record.availability,
        selectedId: preferences.get(id) ?? "", scope: "reported-maximum" };
    },
    async logout({ signal } = {}) {
      if (loggingIn || loggingOut) throw new NeteaseAccountError(409, "正在处理本机网易云账号，请稍候刷新。");
      loggingOut = true;
      reset();
      try {
        const reply = await run(["logout"], signal);
        if (!reply.ok || parseJson(reply.stdout)?.success === false) throw new NeteaseAccountError(502, "官方 CLI 未确认退出，请刷新登录状态。");
        const check = readLoginState(await run(["login", "--check"], signal));
        if (check.state !== "signed-out") throw new NeteaseAccountError(502, "官方 CLI 未确认退出，请刷新登录状态。");
        return { state: "signed-out", message: "已退出本机网易云官方 CLI 登录。" };
      } finally { loggingOut = false; }
    },
  };
}
