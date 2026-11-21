import { escapeHtml } from "./html.ts";

type AccountStatus = {
  state: "unconfigured" | "signed-out" | "pending" | "signed-in";
  message?: string; loginUrl?: string; userName?: string; membership?: { label: string } | null;
};
type Playlist = { id: string; name: string; kind: "liked" | "created" };
type Track = { id: string; name: string; artists: string[]; album: string; encryptedId?: string };
type QualityLevel = { id: string; label: string; playable: boolean | null };
type AccountReplies = {
  status: AccountStatus; login: AccountStatus; logout: AccountStatus;
  playlists: { playlists: Playlist[] }; tracks: { tracks: Track[]; hasMore: boolean };
  quality: { levels: QualityLevel[]; selectedId: string; scope?: string; availability: "available" | "unavailable" | "unknown" };
};
const localOnly = "请在本机使用「启动莱茵科技.cmd」打开音乐库，以连接自己的网易云账号。";

export function neteaseAccountMarkup() {
  return `<section class="netease-view" id="netease-account" aria-label="我的网易云账号" hidden>
    <p id="netease-account-status" role="status" aria-live="polite"></p>
    <div class="netease-account-actions">
      <button type="button" data-account="login" hidden>登录网易云音乐</button>
      <a id="netease-authorize" target="_blank" rel="noopener noreferrer" hidden>前往网易云授权 ↗</a>
      <button type="button" data-account="status" hidden>刷新登录状态</button>
      <button type="button" data-account="logout" aria-controls="netease-logout-confirm" hidden>退出本机网易登录</button>
    </div>
    <div id="netease-logout-confirm" role="group" aria-labelledby="netease-logout-warning" hidden>
      <p id="netease-logout-warning">确认退出本机网易登录？这会同时注销本机网易云官方 CLI 的账号，使用同一登录的其他工具也需要重新授权。</p>
      <div class="netease-account-actions"><button type="button" data-account="cancel-logout">取消</button><button type="button" data-account="confirm-logout">确认退出</button></div>
    </div>
    <details id="netease-account-setup" hidden><summary>如何配置本机账号服务</summary><p>先在<a href="https://developer.music.163.com/st/developer/apply/account?type=INDIVIDUAL" target="_blank" rel="noopener noreferrer">网易云音乐开放平台</a>申请应用凭证。在项目目录依次运行 <code>npm run netease:install</code> 和 <code>npm run netease:configure</code>，再刷新登录状态。</p></details>
    <p id="netease-membership" hidden></p>
    <div class="netease-account-list" hidden><label for="netease-my-playlists">我的歌单</label>
      <select id="netease-my-playlists"></select><button type="button" data-account="playlists">刷新歌单</button>
    </div>
    <p id="netease-account-notice" role="status" aria-live="polite"></p>
    <div id="netease-quality" hidden><strong id="netease-quality-title"></strong>
      <p id="netease-quality-status" role="status"></p>
      <label hidden>本曲音质偏好 <select id="netease-quality-choice"></select></label>
    </div>
    <ol id="netease-my-tracks" class="netease-tracks" aria-label="账号歌单曲目"></ol>
    <button type="button" data-account="more" hidden>继续显示曲目</button>
  </section>`;
}

function authorizationLink(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (url.hostname === "music.163.com" || url.hostname.endsWith(".music.163.com")) ? url.href : null;
  } catch { return null; }
}

export function bindNeteaseAccount(panel: HTMLElement, lifetime: AbortSignal) {
  const section = panel.querySelector<HTMLElement>("#netease-account")!;
  const sessionText = section.querySelector<HTMLElement>("#netease-account-status")!;
  const notice = section.querySelector<HTMLElement>("#netease-account-notice")!;
  const member = section.querySelector<HTMLElement>("#netease-membership")!;
  const auth = section.querySelector<HTMLAnchorElement>("#netease-authorize")!;
  const choices = section.querySelector<HTMLElement>(".netease-account-list")!;
  const select = section.querySelector<HTMLSelectElement>("#netease-my-playlists")!;
  const tracks = section.querySelector<HTMLOListElement>("#netease-my-tracks")!;
  const setup = section.querySelector<HTMLDetailsElement>("#netease-account-setup")!;
  const logoutConfirm = section.querySelector<HTMLElement>("#netease-logout-confirm")!;
  const detail = section.querySelector<HTMLElement>("#netease-quality")!;
  const qualityTitle = detail.querySelector<HTMLElement>("#netease-quality-title")!;
  const qualityStatus = detail.querySelector<HTMLElement>("#netease-quality-status")!;
  const qualityField = detail.querySelector<HTMLLabelElement>("label")!;
  const qualityChoice = detail.querySelector<HTMLSelectElement>("select")!;
  const action = (name: string) => section.querySelector<HTMLButtonElement>(`[data-account="${name}"]`)!;
  let request: AbortController | undefined;
  let qualityRequest: AbortController | undefined;
  let poll: number | undefined;
  let loadedTracks: Track[] = [];
  let qualityTrack: Track | undefined;
  let confirmedQuality = "";

  function cancel() {
    request?.abort();
    window.clearTimeout(poll);
  }
  function clearTracks() {
    qualityRequest?.abort();
    detail.hidden = qualityField.hidden = true;
    qualityStatus.textContent = qualityTitle.textContent = confirmedQuality = "";
    qualityTrack = undefined;
    qualityChoice.replaceChildren();
    tracks.replaceChildren();
    loadedTracks = [];
    action("more").hidden = true;
    notice.textContent = "";
  }
  function clearPrivateView() {
    clearTracks();
    sessionText.textContent = "";
    member.hidden = true;
    member.textContent = "";
    setup.open = false;
    setup.hidden = true;
    logoutConfirm.hidden = true;
    auth.hidden = true;
    auth.removeAttribute("href");
    select.replaceChildren();
    choices.hidden = true;
    for (const name of ["login", "logout", "status"]) action(name).hidden = true;
  }
  function hide() {
    cancel();
    clearPrivateView();
    section.hidden = true;
  }
  lifetime.addEventListener("abort", hide, { once: true });

  async function command<K extends keyof AccountReplies>(name: K, body: object = {}, live = new AbortController()): Promise<AccountReplies[K]> {
    if (name !== "quality") {
      cancel();
      request = live;
    }
    try {
      const reply = await fetch(`/api/netease/account/${name}`, {
        method: "POST", cache: "no-store", mode: "same-origin", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Rhine-Account": "1" }, body: JSON.stringify(body), signal: live.signal,
      });
      if (!reply.headers.get("content-type")?.includes("application/json")) throw new Error(localOnly);
      const data = await reply.json();
      live.signal.throwIfAborted();
      if (reply.status === 401) {
        cancel();
        clearPrivateView();
        sessionText.textContent = "登录已失效，请重新授权网易云账号。";
        action("login").hidden = action("status").hidden = false;
      }
      if (!reply.ok) throw new Error(typeof data?.error === "string" ? data.error : "账号服务暂时不可用，请重试。");
      return data;
    } catch (error) {
      live.signal.throwIfAborted();
      throw error;
    }
  }

  function errorText(error: unknown) {
    return error instanceof Error && !(error instanceof TypeError) ? error.message : "无法读取账号服务，请稍后重试。";
  }
  async function showQuality(track: Track, level?: string) {
    qualityRequest?.abort();
    const live = new AbortController();
    qualityRequest = live;
    qualityTrack = track;
    detail.hidden = false;
    qualityTitle.textContent = track.name;
    if (level === undefined) {
      qualityField.hidden = true;
      qualityChoice.replaceChildren();
      confirmedQuality = "";
    } else {
      qualityChoice.value = confirmedQuality;
    }
    if (!track.encryptedId) {
      qualityStatus.textContent = "平台未返回此曲的音质查询标识。";
      return;
    }
    qualityChoice.disabled = true;
    qualityStatus.textContent = level === undefined ? "正在向网易云查询本曲音质权限…" : "正在保存本曲音质偏好…";
    try {
      const { levels, selectedId, scope, availability } = await command("quality", { id: track.encryptedId, level }, live);
      live.signal.throwIfAborted();
      if (!Array.isArray(levels)) throw new Error("平台未提供此曲的音质权限。");
      const available = levels.filter(level => level.playable === true);
      if (availability !== "available" || !available.length) {
        qualityChoice.replaceChildren();
        qualityField.hidden = true;
        confirmedQuality = "";
        qualityStatus.textContent = availability === "unavailable"
          ? "网易云未授权当前账号通过本应用播放此曲。"
          : "网易云尚未确认本曲可用音质。";
        return;
      }
      const unavailable = levels.filter(level => level.playable === false).map(level => level.label);
      const unknown = levels.filter(level => level.playable == null).map(level => level.label);
      const info = [];
      if (scope === "reported-maximum") info.push("网易仅返回本曲最高可播档");
      if (unavailable.length) info.push(`无播放权限 · ${unavailable.join("、")}`);
      if (unknown.length) info.push(`权限未确认 · ${unknown.join("、")}`);
      qualityChoice.replaceChildren();
      qualityField.hidden = false;
      qualityChoice.add(new Option("自动", ""));
      for (const level of available) qualityChoice.add(new Option(level.label, level.id));
      confirmedQuality = available.some(level => level.id === selectedId) ? selectedId : "";
      qualityChoice.value = confirmedQuality;
      if (level !== undefined) info.push("本机账号服务已保存偏好");
      info.push("在网易云页面播放时，实际音质由该页面决定。");
      qualityStatus.textContent = info.join(" · ");
    } catch (error) {
      if (!live.signal.aborted) qualityStatus.textContent = errorText(error);
    } finally {
      if (!live.signal.aborted) qualityChoice.disabled = false;
    }
  }
  async function readTracks(append = false) {
    if (!append) clearTracks();
    const id = select.value;
    if (!id) { cancel(); return; }
    action("more").disabled = true;
    notice.textContent = "正在读取曲目…";
    try {
      const page = await command("tracks", { id, offset: loadedTracks.length });
      if (!Array.isArray(page.tracks)) throw new Error("账号服务未返回曲目。");
      const rows = page.tracks.map((track, index) => {
        const info = [...(track.artists ?? []), track.album].filter(Boolean).join(" · ");
        const label = `<strong>${escapeHtml(track.name)}</strong>${info ? `<small>${escapeHtml(info)}</small>` : ""}`;
        const song = /^[1-9]\d*$/.test(track.id)
          ? `<a href="https://music.163.com/song?id=${track.id}" target="_blank" rel="noopener noreferrer"><span>${label}</span><span aria-hidden="true">↗</span></a>`
          : `<span class="netease-track-title">${label}</span>`;
        return `<li><div class="netease-track-actions">${song}<button type="button" data-track-quality="${loadedTracks.length + index}" aria-label="查看${escapeHtml(track.name)}的音质">音质</button></div></li>`;
      });
      tracks.insertAdjacentHTML("beforeend", rows.join(""));
      loadedTracks.push(...page.tracks);
      action("more").hidden = !page.hasMore || rows.length === 0;
      notice.textContent = loadedTracks.length ? `已显示 ${loadedTracks.length} 首曲目` : "此歌单暂无可读取的曲目。";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      notice.textContent = errorText(error);
    }
    action("more").disabled = false;
  }

  async function readPlaylists() {
    clearTracks();
    select.replaceChildren();
    notice.textContent = "正在读取我的歌单…";
    try {
      const result = await command("playlists");
      if (!Array.isArray(result.playlists)) throw new Error("账号服务未返回歌单。");
      select.add(new Option("选择歌单", ""));
      for (const p of result.playlists) select.add(new Option(p.kind === "liked" ? "我喜欢的音乐" : p.name, p.id));
      notice.textContent = result.playlists.length ? "" : "当前账号没有可读取的歌单。";
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) notice.textContent = errorText(error);
    }
  }

  async function session(name: "status" | "login" | "logout", polling = false) {
    const previousLink = name === "status" ? auth.getAttribute("href") : null;
    if (!polling) {
      clearPrivateView();
      sessionText.textContent = name === "logout" ? "正在退出本机网易登录…" : "正在检查网易云账号…";
    }
    try {
      const result = await command(name);
      clearPrivateView();
      const signedIn = result.state === "signed-in";
      const pending = result.state === "pending";
      const fallback = { unconfigured: "请先在本机配置网易云官方 CLI 的开放平台凭证。", "signed-out": "尚未登录网易云音乐。", pending: "请前往网易云音乐完成授权。", "signed-in": "已登录网易云音乐。" };
      sessionText.textContent = signedIn && result.userName ? `已登录 · ${result.userName}` : result.message || fallback[result.state];
      action("status").hidden = false;
      action("login").hidden = result.state !== "signed-out";
      setup.hidden = result.state !== "unconfigured";
      action("logout").hidden = !signedIn;
      if (pending) {
        const url = authorizationLink(result.loginUrl || previousLink || undefined);
        if (url) { auth.href = url; auth.hidden = false; }
        poll = window.setTimeout(() => void session("status", true), 5000);
      } else if (signedIn) {
        member.hidden = false;
        member.textContent = result.membership?.label ? `会员 · ${result.membership.label}` : "平台未提供会员信息。";
        choices.hidden = false;
        await readPlaylists();
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      sessionText.textContent = errorText(error);
      action("status").hidden = false;
    }
  }

  select.addEventListener("change", () => void readTracks(), { signal: lifetime });
  qualityChoice.addEventListener("change", () => {
    if (qualityTrack) void showQuality(qualityTrack, qualityChoice.value);
  }, { signal: lifetime });
  tracks.addEventListener("click", event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-track-quality]");
    if (button) {
      const track = loadedTracks[Number(button.dataset.trackQuality)];
      if (track) void showQuality(track);
    }
  }, { signal: lifetime });
  action("more").addEventListener("click", () => void readTracks(true), { signal: lifetime });
  action("playlists").addEventListener("click", () => void readPlaylists(), { signal: lifetime });
  for (const name of ["status", "login"] as const)
    action(name).addEventListener("click", () => void session(name), { signal: lifetime });
  action("logout").addEventListener("click", () => {
    logoutConfirm.hidden = false;
    action("cancel-logout").focus();
  }, { signal: lifetime });
  action("cancel-logout").addEventListener("click", () => {
    logoutConfirm.hidden = true;
    action("logout").focus();
  }, { signal: lifetime });
  action("confirm-logout").addEventListener("click", () => void session("logout"), { signal: lifetime });
  return { hide, show() {
    section.hidden = false;
    if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) void session("status");
    else sessionText.textContent = localOnly;
  } };
}
