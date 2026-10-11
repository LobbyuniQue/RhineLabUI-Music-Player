import { assetUrl } from "./asset-url";
import { isWallpaper } from "./wallpaper";
import "./pwa.css";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
interface OfflineProgress {
  type: "RHINE_OFFLINE_PROGRESS";
  version: string;
  downloaded: number;
  total: number;
  bytes: number;
  totalBytes: number;
  downloading: boolean;
  complete: boolean;
  failed: boolean;
}
let installPrompt: InstallPrompt | undefined;
let registration: ServiceWorkerRegistration | undefined;
let ready = false, failed = false, reloading = false, started = false;
let tell: (message: string) => void = () => {};
let offline: OfflineProgress | undefined;
const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;
function requestOfflineStatus() {
  (navigator.serviceWorker?.controller ?? registration?.active)?.postMessage({ type: "RHINE_OFFLINE_STATUS" });
}
const installed = () => matchMedia("(display-mode: standalone)").matches ||
  Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
const ios = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event as InstallPrompt;
  refresh();
});
window.addEventListener("appinstalled", () => { installPrompt = undefined; refresh(); });
matchMedia("(display-mode: standalone)").addEventListener("change", refresh);

export function pwaSettingsMarkup() {
  if (isWallpaper) return "";
  const status = !import.meta.env.PROD ? "开发预览不保存离线副本。"
    : !window.isSecureContext ? "使用 HTTPS 地址后可保存离线副本。"
    : !("serviceWorker" in navigator) ? "当前浏览器支持在线使用。"
    : failed ? "离线副本未能保存，可联网后重试。"
    : ready ? "核心离线资源已就绪，可离线浏览内置档案与模型。其余字库会在使用时保存。"
    : "正在准备核心离线资源，首次需要保持联网。";
  const guidance = installed() ? "已从主屏幕打开。"
    : ios() ? "在 Safari 中轻点“分享”→“添加到主屏幕”，然后从主屏幕图标打开。"
    : installPrompt ? "安装后可在独立窗口中打开档案。"
    : "可通过浏览器菜单安装或添加到主屏幕。";
  const fullStatus = !ready || !offline ? "" : offline.complete ? "完整离线字库已就绪。"
    : offline.downloading ? `正在下载补充字库：${offline.downloaded}/${offline.total}，${size(offline.bytes)}/${size(offline.totalBytes)}。`
    : offline.failed ? `部分字库下载失败，已保存 ${offline.downloaded}/${offline.total}，可联网后重试。`
    : `已按需保存补充字库 ${offline.downloaded}/${offline.total}；可一次下载全部字库，离线显示更多曲目名称。`;
  const progress = ready && offline && !offline.complete
    ? `<progress class="pwa-download-progress" max="${offline.totalBytes || offline.total || 1}" value="${offline.totalBytes ? offline.bytes : offline.downloaded}" aria-label="完整离线字库下载进度"></progress>` : "";
  const download = ready && offline && !offline.complete
    ? `<button data-pwa-action="download" ${offline.downloading ? "disabled" : ""}>${offline.downloading ? "正在下载…" : offline.failed ? "重试完整离线字库 ↻" : `下载完整离线字库（剩余 ${size(Math.max(0, offline.totalBytes - offline.bytes))}） ↓`}</button>` : "";
  return `<section id="pwa-settings" class="pwa-settings" aria-label="主屏幕与离线使用"><h3>APP / 主屏幕与离线</h3><p>${guidance}</p><p class="pwa-status" role="status">${status}</p>${fullStatus ? `<p class="pwa-full-status" role="status">${fullStatus}</p>${progress}` : ""}<div class="pwa-actions">${installPrompt && !installed() ? '<button data-pwa-action="install">安装到设备 ↗</button>' : ""}${registration?.waiting ? '<span>新版本已准备好</span><button data-pwa-action="update">更新并重启 ↻</button>' : ""}${failed ? '<button data-pwa-action="retry">重试保存核心离线资源 ↻</button>' : ""}${download}</div></section>`;
}
function refresh() {
  const current = document.querySelector("#pwa-settings");
  if (current) current.outerHTML = pwaSettingsMarkup();
  document.documentElement.dataset.offlineReady = String(ready);
  document.documentElement.dataset.offlineComplete = String(Boolean(offline?.complete));
  const notice = document.querySelector<HTMLElement>("#pwa-update-notice");
  const waiting = Boolean(registration?.waiting);
  if (notice) notice.hidden = !waiting;
  const stage = document.querySelector<HTMLElement>("#stage");
  if (stage) stage.dataset.pwaUpdate = String(waiting);
}

export async function initPwa(notify: (message: string) => void) {
  if (isWallpaper) return;
  tell = notify;
  if (started || !import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator)) return;
  started = true;
  try {
    registration = await navigator.serviceWorker.register(assetUrl("sw.js"), {
      scope: import.meta.env.BASE_URL, updateViaCache: "none",
    });
    const watch = () => {
      const worker = registration?.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") {
          failed = false;
          refresh();
        } else if (worker.state === "redundant" && !registration?.active) {
          failed = true; refresh();
        }
      });
    };
    registration.addEventListener("updatefound", watch);
    watch();
    refresh();
    void navigator.serviceWorker.ready.then(() => { ready = true; failed = false; requestOfflineStatus(); refresh(); });
    let lastCheck = Date.now();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) requestOfflineStatus();
      if (!document.hidden && Date.now() - lastCheck > 3_600_000) {
        lastCheck = Date.now(); void registration?.update().catch(() => {});
      }
    });
  } catch { failed = true; }
  refresh();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("controllerchange", () => {
  if (reloading) location.reload();
  else { offline = undefined; requestOfflineStatus(); refresh(); }
});
if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", event => {
  const active = navigator.serviceWorker.controller ?? registration?.active;
  const state = event.data as OfflineProgress | undefined;
  if (!active || event.source !== active || state?.type !== "RHINE_OFFLINE_PROGRESS") return;
  if (![state.downloaded, state.total, state.bytes, state.totalBytes].every(value => Number.isFinite(value) && value >= 0)) return;
  const wasDownloading = offline?.downloading;
  offline = state;
  refresh();
  if (wasDownloading && !state.downloading) {
    if (state.complete) tell("完整离线字库已下载");
    else if (state.failed) tell("补充字库下载未完成，已保存成功部分，可重试");
  }
});
document.addEventListener("click", async event => {
  if ((event.target as Element).closest('[data-action="settings"]')) requestOfflineStatus();
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-pwa-action]");
  if (!button) return;
  if (button.dataset.pwaAction === "install" && installPrompt) {
    const prompt = installPrompt; installPrompt = undefined;
    try { await prompt.prompt(); await prompt.userChoice; } catch { tell("请通过浏览器菜单添加到主屏幕"); }
    refresh();
  }
  if (button.dataset.pwaAction === "update" && registration?.waiting) {
    reloading = true;
    button.disabled = true;
    registration.waiting.postMessage({ type: "RHINE_APPLY_UPDATE" });
  }
  if (button.dataset.pwaAction === "retry") {
    failed = false;
    refresh();
    if (registration) {
      try { await registration.update(); } catch { failed = true; refresh(); }
    } else { started = false; void initPwa(tell); }
  }
  if (button.dataset.pwaAction === "download" && ready) {
    const worker = navigator.serviceWorker.controller ?? registration?.active;
    if (!worker) return;
    button.disabled = true;
    worker.postMessage({ type: "RHINE_DOWNLOAD_OFFLINE" });
  }
});
