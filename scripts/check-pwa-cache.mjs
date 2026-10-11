// Exercise the actual release planner and service worker with synthetic assets.
// No browser, network access or repository build output is needed.
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { buildPwa, coreFontFiles, planOfflineResources } from "./build-pwa.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = join(root, ".local");
await mkdir(temporaryRoot, { recursive: true });
const fixture = await mkdtemp(join(temporaryRoot, "pwa-check-"));
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log(`pwa: ${name}`); };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const scope = "https://rhine.test/app/";
const template = await readFile(new URL("pwa-worker.js", import.meta.url), "utf8");

function worker({ version = "fixture", core = ["index.html", "assets/index-fixture.js"],
  optional = ["fonts/one.woff2", "fonts/two.woff2"], storage = new Map(), contents = new Map() } = {}) {
  const listeners = {}, fetched = [], messages = [], failures = new Set();
  for (const file of [...core, ...optional]) if (!contents.has(file)) contents.set(file, `original:${file}`);
  const sizes = Object.fromEntries([...contents].map(([file, bytes]) => [file, Buffer.byteLength(bytes)]));
  const hashes = Object.fromEntries(optional.map(file => [file, sha256(contents.get(file))]));
  const keyOf = input => typeof input === "string" ? input : input.url;
  const caches = {
    keys: async () => [...storage.keys()],
    delete: async key => storage.delete(key),
    open: async name => {
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name);
      return {
        keys: async () => [...entries.keys()].map(url => new Request(url)),
        match: async key => entries.get(keyOf(key))?.clone(),
        put: async (key, response) => entries.set(keyOf(key), response.clone()),
        add: async request => {
          const response = await fetchResource(request);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          entries.set(request.url, response.clone());
        },
      };
    },
  };
  async function fetchResource(input) {
    const url = keyOf(input), file = url === scope ? "index.html" : url.slice(scope.length);
    fetched.push(file);
    await Promise.resolve();
    if (failures.has(file)) throw new Error(`offline:${file}`);
    return contents.has(file) ? new Response(contents.get(file)) : new Response("missing", { status: 404 });
  }
  let claimed = false, skipped = false;
  runInNewContext(template
    .replace("__CACHE_VERSION__", JSON.stringify(version))
    .replace("__PRECACHE_FILES__", JSON.stringify(core))
    .replace("__OPTIONAL_FILES__", JSON.stringify(optional))
    .replace("__FILE_SIZES__", JSON.stringify(sizes))
    .replace("__OPTIONAL_HASHES__", JSON.stringify(hashes)), {
    URL, Request, Response, crypto: webcrypto, fetch: fetchResource, caches,
    self: {
      registration: { scope }, location: { origin: new URL(scope).origin },
      addEventListener: (name, handler) => { listeners[name] = handler; },
      skipWaiting: async () => { skipped = true; },
      clients: {
        claim: async () => { claimed = true; },
        matchAll: async () => [
          { url: scope, postMessage: message => messages.push(JSON.parse(JSON.stringify(message))) },
          { url: "https://rhine.test/other/", postMessage: () => { throw new Error("wrong scope"); } },
        ],
      },
    },
  });
  async function dispatch(name, event = {}) {
    let completion;
    listeners[name]({ ...event, waitUntil: promise => { completion = promise; } });
    return completion;
  }
  async function request(file, method = "GET", mode = "cors") {
    let response;
    listeners.fetch({ request: { url: new URL(file, scope).href, method, mode },
      respondWith: promise => { response = promise; } });
    return response;
  }
  return {
    storage, contents, failures, fetched, messages, request, dispatch,
    cacheKey: `rhine-lab:/app/:${version}`,
    status: async () => {
      let status;
      await dispatch("message", { data: { type: "RHINE_OFFLINE_STATUS" }, source: { postMessage: value => { status = value; } } });
      return status;
    },
    download: () => dispatch("message", { data: { type: "RHINE_DOWNLOAD_OFFLINE" } }),
    claimed: () => claimed, skipped: () => skipped,
  };
}

try {
  await check("unicode ranges select the UI/archive glyph shards and handle supplementary characters", async () => {
    const face = (path, range) => `@font-face{src:url('/fonts/misans-webfont-fixture/regular/${path}.woff2');unicode-range:${range}}`;
    const css = face("latin", "U+00??") + face("han", "U+4E00-4E10") + face("rare", "U+20000-20002") + face("unused", "U+5000");
    const selected = coreFontFiles(css, "A一𠀀");
    assert.deepEqual([...selected].map(file => basename(file)).sort(), ["han.woff2", "latin.woff2", "rare.woff2"]);
  });

  await check("release manifest retains optional fonts for publishing and fingerprints their bytes", async () => {
    const source = join(fixture, "source"), output = join(fixture, "output");
    async function write(base, path, text) { const file = join(base, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); }
    await write(source, "src/main.ts", 'const title = "一";');
    await write(source, "content/archives.json", '{"title":"丁"}');
    await write(source, "index.html", "<title>A</title>");
    const fonts = ["latin", "han", "rare"].map(name => `fonts/misans-webfont-fixture/regular/${name}.woff2`);
    await write(source, "src/fonts.css", ["U+00??", "U+4E00-4E10", "U+20000"].map((range, i) => `@font-face{src:url('/${fonts[i]}');unicode-range:${range}}`).join("\n"));
    const files = ["index.html", "manifest.webmanifest", "assets/index-fixture.js", "assets/archive-cassette.0123456789abcdef.glb", "audio/atmosphere.ogg", "fonts/LICENSE.txt", ...fonts];
    for (const file of files) await write(output, file, file);
    await write(output, "assets/archive-cassette.glb", "legacy alias");
    const plan = await planOfflineResources(output, source);
    assert.deepEqual(plan.files, files.sort());
    assert.deepEqual(plan.optional.files, [fonts[2]]);
    assert.ok(plan.precache.files.includes(fonts[1]), "built-in text is available offline");
    assert.equal(plan.bytes, plan.precache.bytes + plan.optional.bytes);
    const first = await buildPwa(output, source);
    assert.deepEqual(JSON.parse(await readFile(join(output, "pwa-build.json"), "utf8")).files, files.sort());
    await write(output, fonts[2], "changed optional release bytes");
    const second = await buildPwa(output, source);
    assert.notEqual(first.version, second.version);
    assert.equal((await readFile(join(output, "sw.js"), "utf8")).includes("__OPTIONAL_HASHES__"), false);
  });

  await check("install downloads only core; optional requests populate cache on demand", async () => {
    const value = worker(); await value.dispatch("install");
    assert.deepEqual(value.fetched.sort(), ["assets/index-fixture.js", "index.html"]);
    assert.equal((await value.status()).downloaded, 0);
    assert.equal(await (await value.request("fonts/one.woff2?tag=1")).text(), "original:fonts/one.woff2");
    value.failures.add("fonts/one.woff2");
    assert.equal(await (await value.request("fonts/one.woff2")).text(), "original:fonts/one.woff2");
    assert.equal(value.fetched.filter(file => file === "fonts/one.woff2").length, 1);
    assert.equal((await value.status()).downloaded, 1);
    assert.equal(await value.request("/api/library"), undefined);
    assert.equal(await value.request("fonts/two.woff2", "POST"), undefined);
  });

  await check("full downloads report partial failures, preserve successes and retry only missing files", async () => {
    const value = worker(); await value.dispatch("install");
    value.failures.add("fonts/two.woff2");
    await Promise.all([value.download(), value.download()]);
    let status = await value.status();
    assert.equal(status.downloaded, 1); assert.equal(status.failed, true); assert.equal(status.downloading, false);
    assert.equal(status.complete, false);
    assert.equal(value.fetched.filter(file => file === "fonts/one.woff2").length, 1);
    assert.equal(value.fetched.filter(file => file === "fonts/two.woff2").length, 1);
    assert.ok(value.messages.some(message => message.downloading));
    value.failures.clear(); await value.download(); status = await value.status();
    assert.equal(status.complete, true); assert.equal(status.failed, false);
    assert.equal(status.bytes, status.totalBytes);
    assert.equal(value.fetched.filter(file => file === "fonts/one.woff2").length, 1);
    assert.equal(value.fetched.filter(file => file === "fonts/two.woff2").length, 2);
    assert.equal(value.messages.at(-1).downloading, false);
  });

  await check("an old release rejects changed optional bytes after deployment", async () => {
    const value = worker(); await value.dispatch("install");
    value.contents.set("fonts/one.woff2", "modified:fonts/one.woff2");
    assert.equal(Buffer.byteLength(value.contents.get("fonts/one.woff2")), Buffer.byteLength("original:fonts/one.woff2"));
    await assert.rejects(value.request("fonts/one.woff2"), /release mismatch/);
    assert.equal((await value.status()).downloaded, 0);
    assert.equal(await (await value.request("index.html")).text(), "original:index.html");
    value.contents.set("fonts/two.woff2", "short");
    await assert.rejects(value.request("fonts/two.woff2"), /size mismatch/);
  });

  await check("failed installation discards its partial cache and keeps the previous release", async () => {
    const previous = worker({ version: "old" }); await previous.dispatch("install");
    const update = worker({ version: "new", storage: previous.storage });
    update.failures.add("assets/index-fixture.js");
    await assert.rejects(update.dispatch("install"), /offline/);
    assert.ok(update.storage.has(previous.cacheKey)); assert.equal(update.storage.has(update.cacheKey), false);
    assert.equal(await (await previous.request("index.html")).text(), "original:index.html");
  });

  await check("activation removes only older releases within this application scope", async () => {
    const storage = new Map([["rhine-lab:/other/:old", new Map()], ["unrelated", new Map()]]);
    const old = worker({ version: "old", storage }); await old.dispatch("install");
    const current = worker({ version: "new", storage }); await current.dispatch("install");
    assert.ok(storage.has(old.cacheKey), "waiting update preserves active cache");
    await current.dispatch("message", { data: { type: "RHINE_APPLY_UPDATE" } });
    assert.equal(current.skipped(), true);
    await current.dispatch("activate");
    assert.equal(current.claimed(), true); assert.equal(storage.has(old.cacheKey), false);
    assert.ok(storage.has("rhine-lab:/other/:old")); assert.ok(storage.has("unrelated"));
  });

  await check("settings display progress and retry while ignoring messages from another worker", async () => {
    const listeners = {}, serviceListeners = {}, dataset = {}, notices = [];
    const active = { postMessage() {} };
    const navigator = { userAgent: "Fixture", platform: "Win32", maxTouchPoints: 0,
      serviceWorker: { controller: active, ready: Promise.resolve(),
        register: async () => ({ active, addEventListener() {} }),
        addEventListener: (name, listener) => { serviceListeners[name] = listener; } } };
    const context = { navigator, console, URL, window: { isSecureContext: true, addEventListener() {} },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      document: { documentElement: { dataset }, querySelector: () => null, addEventListener: (name, listener) => { listeners[name] = listener; } },
      location: { reload() { throw new Error("unexpected reload"); } },
      assetUrl: value => value, isWallpaper: false };
    const source = (await readFile(new URL("../src/pwa.ts", import.meta.url), "utf8"))
      .replace(/^import .*;\r?\n/gm, "").replaceAll("import.meta.env.PROD", "true").replaceAll("import.meta.env.BASE_URL", '"/app/"');
    const code = ts.transpileModule(source.replace(/export /g, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(`${code}\nthis.api = { initPwa, pwaSettingsMarkup };`, context);
    await context.api.initPwa(message => notices.push(message)); await Promise.resolve();
    const progress = { type: "RHINE_OFFLINE_PROGRESS", version: "fixture", downloaded: 1, total: 2, bytes: 1024, totalBytes: 2048, downloading: true, complete: false, failed: false };
    serviceListeners.message({ source: {}, data: progress });
    assert.equal(context.api.pwaSettingsMarkup().includes("正在下载补充字库"), false);
    serviceListeners.message({ source: active, data: progress });
    assert.match(context.api.pwaSettingsMarkup(), /正在下载补充字库：1\/2/);
    assert.match(context.api.pwaSettingsMarkup(), /data-pwa-action="download" disabled/);
    serviceListeners.message({ source: active, data: { ...progress, downloading: false, failed: true } });
    assert.match(context.api.pwaSettingsMarkup(), /重试完整离线字库/);
    assert.equal(notices.length, 1);
    serviceListeners.message({ source: active, data: { ...progress, downloaded: 2, bytes: 2048, downloading: false, complete: true } });
    assert.match(context.api.pwaSettingsMarkup(), /完整离线字库已就绪/);
    assert.equal(dataset.offlineComplete, "true");
  });
} finally {
  // Delete only the fixture directory created by this invocation.
  assert.equal(dirname(resolve(fixture)), resolve(temporaryRoot));
  assert.ok(basename(fixture).startsWith("pwa-check-"));
  await rm(fixture, { recursive: true, force: true });
}
console.log(`PWA cache checks passed (${passed} scenarios).`);
