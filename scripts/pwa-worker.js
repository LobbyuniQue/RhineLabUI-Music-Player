/* The build replaces both tokens; this file is never registered in development. */
const VERSION = __CACHE_VERSION__;
const FILES = __PRECACHE_FILES__;
const OPTIONAL_FILES = __OPTIONAL_FILES__;
const SIZES = __FILE_SIZES__;
const OPTIONAL_HASHES = __OPTIONAL_HASHES__;
const PREFIX = `rhine-lab:${new URL(self.registration.scope).pathname}:`;
const CACHE = PREFIX + VERSION;
const urls = FILES.map(path => new URL(path, self.registration.scope).href);
const optionalUrls = OPTIONAL_FILES.map(path => new URL(path, self.registration.scope).href);
const optional = new Set(optionalUrls);
const allowed = new Set([...urls, ...optionalUrls]);
const index = new URL("index.html", self.registration.scope).href;
let downloadTask = null;
let downloadFailed = false;

async function saveOptional(cache, url) {
  const file = OPTIONAL_FILES[optionalUrls.indexOf(url)];
  const response = await fetch(new Request(url, { cache: "no-cache" }));
  if (!response.ok) throw new Error(`Resource download failed: ${response.status}`);
  const bytes = await response.clone().arrayBuffer();
  if (bytes.byteLength !== SIZES[file]) throw new Error("Resource size mismatch");
  // An old active page may request an uncached font after a new deployment.
  // Verify exact release bytes before accepting it into this version's cache.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  if (hash !== OPTIONAL_HASHES[file]) throw new Error("Resource release mismatch");
  await cache.put(url, response.clone());
  return response;
}

async function offlineStatus(cache = null, downloading = Boolean(downloadTask), failed = downloadFailed) {
  cache ??= await caches.open(CACHE);
  const present = new Set((await cache.keys()).map(request => request.url));
  let downloaded = 0, bytes = 0, totalBytes = 0;
  OPTIONAL_FILES.forEach((file, index) => {
    totalBytes += SIZES[file];
    if (present.has(optionalUrls[index])) {
      downloaded++;
      bytes += SIZES[file];
    }
  });
  return {
    type: "RHINE_OFFLINE_PROGRESS", version: VERSION,
    downloaded, total: OPTIONAL_FILES.length, bytes, totalBytes,
    downloading, complete: downloaded === OPTIONAL_FILES.length, failed,
  };
}

async function notifyProgress(status) {
  for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
    if (client.url.startsWith(self.registration.scope)) client.postMessage(status);
}

async function downloadOfflineResources() {
  if (downloadTask) return downloadTask;
  downloadFailed = false;
  const task = (async () => {
    const cache = await caches.open(CACHE);
    const present = new Set((await cache.keys()).map(request => request.url));
    const pending = optionalUrls.filter(url => !present.has(url));
    await notifyProgress(await offlineStatus(cache, true, false));
    let next = 0;
    const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (next < pending.length) {
        const url = pending[next++];
        try {
          if (!(await cache.match(url))) await saveOptional(cache, url);
        } catch {
          downloadFailed = true;
        }
        await notifyProgress(await offlineStatus(cache, true, downloadFailed));
      }
    });
    await Promise.all(workers);
    await notifyProgress(await offlineStatus(cache, false, downloadFailed));
  })();
  downloadTask = task;
  try {
    await task;
  } catch {
    downloadFailed = true;
    await notifyProgress(await offlineStatus(null, false, true)).catch(() => {});
  } finally {
    if (downloadTask === task) downloadTask = null;
  }
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      // Only core resources and the glyph shards used by UI/built-in archives.
      // Keep successful files private until every resource is present; failure
      // still deletes this entire release and leaves the active release intact.
      let next = 0;
      const workers = Array.from({ length: 6 }, async () => {
        while (next < urls.length) {
          const url = urls[next++];
          const immutable = /\/fonts\/misans-webfont-4\.3\.1\//.test(url) || /\/assets\/archive-(cassette|assembly)\.[a-f0-9]{16}\.glb$/.test(url);
          if (url === index) {
            // Pages redirects index.html to the directory URL. Keep the release's
            // cache key, but fetch the canonical page without a followed redirect.
            const response = await fetch(new Request(self.registration.scope, { cache: "no-cache" }));
            if (!response.ok) throw new Error(`Homepage download failed: ${response.status}`);
            await cache.put(url, response);
          } else {
            await cache.add(new Request(url, { cache: immutable ? "default" : "no-cache" }));
          }
        }
      });
      const results = await Promise.allSettled(workers);
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys())
      if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener("message", event => {
  if (event.data?.type === "RHINE_APPLY_UPDATE") event.waitUntil(self.skipWaiting());
  if (event.data?.type === "RHINE_OFFLINE_STATUS")
    event.waitUntil(offlineStatus().then(status => event.source?.postMessage(status)));
  if (event.data?.type === "RHINE_DOWNLOAD_OFFLINE")
    event.waitUntil(downloadOfflineResources());
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  url.search = "";
  url.hash = "";
  const navigation = event.request.mode === "navigate" &&
    (url.href === self.registration.scope || url.href === index);
  const key = navigation ? index : url.href;
  if (!allowed.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // HTML, hashed bundles and stable model URLs come from the same release.
    // A new release stays waiting until the user chooses to restart or exits.
    const cached = await cache.match(key);
    // A navigation uses redirect: manual and cannot consume a response whose
    // URL list contains a followed redirect (including older cached releases).
    if (navigation && cached?.redirected) {
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers: cached.headers,
      });
    }
    if (cached) return cached;
    // Full glyph coverage is cached as the user encounters it, or explicitly
    // downloaded from settings. Failed additions never remove the core cache.
    return optional.has(key) ? saveOptional(cache, key) : fetch(event.request);
  })());
});
