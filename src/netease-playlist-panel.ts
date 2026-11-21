import { escapeHtml } from "./html.ts";
import { bindNeteaseAccount, neteaseAccountMarkup } from "./netease-account-panel.ts";

type OnlineTrack = { id: string; name: string; artists: string[]; album: string };
type OnlinePlaylist = { id: string; name: string; total: number | null; tracks: OnlineTrack[]; partial: boolean };

export function neteasePlaylistMarkup() {
  return `<section id="netease-panel" class="netease-panel" aria-label="网易云音乐公开歌单" hidden>
    <header><h3>网易云歌单</h3><button type="button" id="netease-back">← 返回本地曲库</button></header>
    <div class="netease-sources" role="group" aria-label="歌单来源"><button type="button" id="netease-public-tab" aria-pressed="true">公开歌单</button><button type="button" id="netease-account-tab" aria-pressed="false">我的账号</button></div>
    <div id="netease-public-view" class="netease-view"><form id="netease-form">
      <label for="netease-source">公开歌单分享链接或歌单 ID</label>
      <div class="netease-input"><input id="netease-source" type="text" required maxlength="2048" autocomplete="off" spellcheck="false" placeholder="粘贴分享内容或输入歌单 ID"><button type="submit">读取歌单</button></div>
    </form>
    <p id="netease-status" role="status" aria-live="polite"></p>
    <div class="netease-heading" hidden><strong id="netease-playlist-title"></strong><a id="netease-playlist-link" target="_blank" rel="noopener noreferrer">在网易云查看歌单 ↗</a></div>
    <ol id="netease-results" aria-label="在网易云音乐打开曲目"></ol></div>
    ${neteaseAccountMarkup()}
  </section>`;
}

const serviceUnavailable = "此页面未提供在线歌单服务。请使用「启动莱茵科技.cmd」打开本地版本后重试。";
const validId = (id: unknown): id is string => typeof id === "string" && /^[1-9]\d*$/.test(id);

function isPlaylist(value: unknown): value is OnlinePlaylist {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<OnlinePlaylist>;
  return validId(p.id) && typeof p.name === "string" && typeof p.partial === "boolean" &&
    (p.total === null || (typeof p.total === "number" && Number.isSafeInteger(p.total) && p.total >= 0)) &&
    Array.isArray(p.tracks) && p.tracks.every(t => t && validId(t.id) && typeof t.name === "string" &&
      typeof t.album === "string" && Array.isArray(t.artists) && t.artists.every(a => typeof a === "string"));
}

// Owns only public metadata and official links; local library and player state
// are never passed to this view.
export function bindNeteasePlaylist(root: HTMLElement, lifetime: AbortSignal) {
  const panel = root.querySelector<HTMLElement>("#netease-panel")!;
  const open = root.querySelector<HTMLButtonElement>("#netease-open")!;
  const input = panel.querySelector<HTMLInputElement>("#netease-source")!;
  const form = panel.querySelector<HTMLFormElement>("#netease-form")!;
  const status = panel.querySelector<HTMLElement>("#netease-status")!;
  const heading = panel.querySelector<HTMLElement>(".netease-heading")!;
  const title = panel.querySelector<HTMLElement>("#netease-playlist-title")!;
  const link = panel.querySelector<HTMLAnchorElement>("#netease-playlist-link")!;
  const list = panel.querySelector<HTMLOListElement>("#netease-results")!;
  const publicView = panel.querySelector<HTMLElement>("#netease-public-view")!;
  const publicTab = panel.querySelector<HTMLButtonElement>("#netease-public-tab")!;
  const accountTab = panel.querySelector<HTMLButtonElement>("#netease-account-tab")!;
  const account = bindNeteaseAccount(panel, lifetime);
  let pending: AbortController | undefined;

  function cancel() {
    pending?.abort();
    pending = undefined;
  }
  lifetime.addEventListener("abort", cancel, { once: true });
  function showPublic() {
    account.hide();
    publicView.hidden = false;
    publicTab.setAttribute("aria-pressed", "true");
    accountTab.setAttribute("aria-pressed", "false");
  }
  publicTab.addEventListener("click", () => {
    showPublic();
    input.focus();
  }, { signal: lifetime });
  accountTab.addEventListener("click", () => {
    if (publicView.hidden) return;
    if (pending) status.textContent = "";
    cancel();
    publicView.hidden = true;
    publicTab.setAttribute("aria-pressed", "false");
    accountTab.setAttribute("aria-pressed", "true");
    account.show();
  }, { signal: lifetime });
  open.addEventListener("click", () => {
    panel.hidden = false;
    root.classList.add("show-netease");
    input.focus({ preventScroll: true });
  }, { signal: lifetime });
  panel.querySelector("#netease-back")!.addEventListener("click", () => {
    if (pending) status.textContent = "";
    cancel();
    showPublic();
    root.classList.remove("show-netease");
    panel.hidden = true;
    open.focus({ preventScroll: true });
  }, { signal: lifetime });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    cancel();
    const source = input.value.trim();
    heading.hidden = true;
    list.replaceChildren();
    if (!source) {
      status.textContent = "请输入网易云音乐的公开歌单链接或歌单 ID。";
      input.focus();
      return;
    }
    const request = new AbortController();
    pending = request;
    status.textContent = "正在读取网易云歌单…";
    try {
      const query = new URLSearchParams({ source });
      const response = await fetch(`/api/netease/playlist?${query}`, {
        headers: { Accept: "application/json" }, cache: "no-store", signal: request.signal,
      });
      if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(serviceUnavailable);
      const playlist = await response.json();
      if (!response.ok) throw new Error(typeof playlist?.error === "string" ? playlist.error : "读取网易云歌单失败，请稍后重试。");
      if (!isPlaylist(playlist)) throw new Error("歌单服务返回了无法识别的数据，请稍后重试。");
      if (request.signal.aborted) return;
      title.textContent = playlist.name;
      link.href = `https://music.163.com/playlist?id=${playlist.id}`;
      heading.hidden = false;
      const total = playlist.total === null ? "歌单总数未公开" : `歌单共 ${playlist.total} 首`;
      status.textContent = `已读取 ${playlist.tracks.length} 首公开曲目 · ${total}${playlist.partial ? " · 更多曲目信息请查看网易云歌单" : ""}`;
      list.innerHTML = playlist.tracks.map(track => {
        const info = [track.artists.join(" / "), track.album].filter(Boolean).join(" · ");
        return `<li><a href="https://music.163.com/song?id=${track.id}" target="_blank" rel="noopener noreferrer"><span><strong>${escapeHtml(track.name)}</strong>${info ? `<small>${escapeHtml(info)}</small>` : ""}</span><span aria-hidden="true">↗</span></a></li>`;
      }).join("");
      list.scrollTop = 0;
    } catch (error) {
      if (request.signal.aborted) return;
      status.textContent = error instanceof TypeError ? "无法连接歌单服务，请检查网络或使用本地启动器后重试。"
        : error instanceof Error ? error.message : "读取失败，请重试。";
    } finally {
      if (pending === request) pending = undefined;
    }
  }, { signal: lifetime });
}
