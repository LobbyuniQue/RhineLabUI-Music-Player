// Settings block for the local music library.
//
// Mirrors audio-settings.ts: a plain markup function plus a data-attribute
// driven contract, so the delegated handlers in main.ts can stay generic.

import { escapeHtml } from "./html";
import { formatLibrarySize } from "./music-search";
import type { MusicLibrary } from "./music-library";
import type { MusicGrouping } from "./music-grouping";
import { directoryPickerSupported } from "./music-source";
import { ROW_SPACING_MAX, ROW_SPACING_MIN } from "./row-spacing";

export type MusicSettingsState = {
  /** Which playback kernel is selected. */
  engine: "browser" | "vlc";
  /** Whether the VLC bridge answered the last probe. */
  bridgeConnected: boolean;
  bridgePort: number;
  bridgeToken: string;
  bridgeInfo: { root: string; tracks: number; vlc: string } | null;
  bridgeError: string;
  /** Whether local music drives the archive music reaction. */
  reactive: boolean;
  /** Rhythm style forwarded to the archive scene. */
  rhythm: "legacy" | "wave" | "lift" | "pulse" | "ripple" | "groove" | "shimmer";
  /** Column grouping for the music archive view. */
  grouping: MusicGrouping;
  /** Vertical spacing between music archive cards. */
  rowSpacing: number;
};

export function musicSettingsMarkup(library: MusicLibrary, state: MusicSettingsState) {
  const stats = library.stats();
  const supported = directoryPickerSupported();
  const label = library.label || "未选择目录";
  const lines = [
    `<span>${stats.count} 首</span>`,
    `<span>${formatLibrarySize(stats.bytes)}</span>`,
    stats.artists ? `<span>${stats.artists} 位艺术家</span>` : "",
    library.persistent ? `<span>已记忆目录</span>` : library.source ? `<span>本次会话</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  const bridgeStatus = state.bridgeConnected
    ? `已连接 · VLC ${escapeHtml(state.bridgeInfo?.vlc || "?")} · ${state.bridgeInfo?.tracks ?? 0} 首 · ${escapeHtml(state.bridgeInfo?.root ?? "")}`
    : state.bridgeError || "未连接（VLC 未安装时使用浏览器内核）";
  return `<div class="music-settings" data-music-settings>
  <div class="music-settings-item">
    <strong>PLAYBACK KERNEL</strong>
    <span>播放内核 · 编解码交由 VLC，网页只负责界面与动画</span>
    <div class="music-settings-rhythm" role="group" aria-label="播放内核">
      <button data-music-engine="browser" aria-pressed="${state.engine === "browser"}">浏览器内核</button>
      <button data-music-engine="vlc" aria-pressed="${state.engine === "vlc"}">VLC 桥接</button>
    </div>
    <div class="music-bridge-fields">
      <label>端口<input type="number" min="1024" max="65535" data-music-bridge-port value="${state.bridgePort}"/></label>
      <label>令牌<input type="text" data-music-bridge-token value="${escapeHtml(state.bridgeToken)}" placeholder="桥接启动时打印"/></label>
    </div>
    <div class="music-settings-actions">
      <button data-music-setting="playlists">管理与切换歌单</button>
      <button data-music-bridge="connect">连接桥接</button>
      <button data-music-bridge="disconnect" ${state.bridgeConnected ? "" : "disabled"}>断开</button>
    </div>
    <p class="music-bridge-status ${state.bridgeConnected ? "ok" : "idle"}">${bridgeStatus}</p>
  </div>
  <div class="music-settings-item">
    <strong>LOCAL MUSIC</strong>
    <span>本地曲库 · ${escapeHtml(label)}</span>
    <div class="music-settings-stats">${lines}</div>
    <div class="music-settings-actions">
      <button data-music-setting="pick" ${state.engine === "vlc" ? "disabled" : ""}>${supported ? "选择目录" : "选择文件"}</button>
      <button data-music-setting="scan" ${state.engine === "vlc" ? "" : library.source ? "" : "disabled"}>重新扫描</button>
      <button data-music-setting="clear" ${stats.count ? "" : "disabled"}>清除索引</button>
    </div>
  </div>
  <div class="music-settings-item">
    <strong>MUSIC REACTION</strong>
    <span>本地音乐驱动档案律动与频谱</span>
    <label class="music-settings-toggle"><input type="checkbox" data-music-reactive ${state.reactive ? "checked" : ""}/><i class="toggle"></i><span>播放本地音乐时让档案阵列响应节奏</span></label>
    <div class="music-settings-rhythm" role="group" aria-label="律动风格">
      ${(
        [
          ["legacy", "原版"],
          ["wave", "连续频谱"],
          ["lift", "层叠流波"],
          ["pulse", "响度律动"],
          ["ripple", "波频律动"],
          ["groove", "宽频律动"],
          ["shimmer", "高频微光"],
        ] as const
      )
        .map(
          ([value, text]) =>
            `<button data-music-rhythm="${value}" aria-pressed="${state.rhythm === value}">${text}</button>`,
        )
        .join("")}
    </div>
  </div>
  <div class="music-settings-item">
    <strong>ARCHIVE GROUPING</strong>
    <span>音乐库档案阵列 · 每一列为同一专辑、同一歌手或同一歌名首字母</span>
    <div class="music-settings-rhythm" role="group" aria-label="排列方式">
      ${(
        [
          ["album", "按专辑"],
          ["artist", "按歌手"],
          ["letter", "按歌名首字母"],
        ] as const
      )
        .map(
          ([value, text]) =>
            `<button data-music-grouping="${value}" aria-pressed="${state.grouping === value}">${text}</button>`,
        )
        .join("")}
    </div>
  </div>
  <div class="music-settings-item">
    <strong>ARCHIVE SPACING</strong>
    <span>音乐库档案行距 · 数值越大，每首歌曲的封面越独立</span>
    <label class="music-settings-range"><span>行距</span><input type="range" data-music-spacing min="${ROW_SPACING_MIN}" max="${ROW_SPACING_MAX}" step="0.01" value="${state.rowSpacing.toFixed(2)}" aria-label="音乐库档案行距"/><output data-music-spacing-output>${state.rowSpacing.toFixed(2)}</output></label>
  </div>
  <p class="music-settings-note">曲库索引与封面保存在本机浏览器中，不上传任何文件；VLC 桥接仅监听 127.0.0.1 并要求本次启动的令牌。VLC 为 GPLv2+ 独立程序，由 scripts/fetch-vlc.mjs 获取，不修改也不链接。</p>
</div>`;
}
