// Real built UI with a synthetic account API. This check never signs in to
// NetEase, contacts its servers, or starts a media player.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Cdp } from "../lib/cdp.mjs";
import { stopProcessTree } from "../lib/owned-process.mjs";
import { BROWSER, DIST_DIR, STATIC_SERVER, profilePath, removeLocalDirectory, requireE2EEnvironment } from "../lib/workspace-paths.mjs";

function installFixture() {
  localStorage.setItem("rhine-settings", JSON.stringify({ libraryMode: "archive", quality: false, superPerformance: true,
    musicEngine: "browser", motionPreset: "custom", motion: { preset: "custom", boot: false, surfaceTransitions: false }, sound: false, music: false }));
  const fixture = window.accountFixture = { state: "unconfigured", requests: [], selectedId: "", late: false, release: null, playCalls: 0 };
  HTMLMediaElement.prototype.play = function () { fixture.playCalls++; return Promise.reject(new Error("Unexpected playback")); };
  const pass = window.fetch.bind(window);
  const json = payload => new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url || input, location.href);
    if (url.origin !== location.origin) throw new Error("External fetch disabled in account fixture");
    if (!url.pathname.startsWith("/api/netease/account/")) return pass(input, init);
    const name = url.pathname.split("/").pop();
    const body = JSON.parse(init.body);
    if (init.method !== "POST" || init.cache !== "no-store" || new Headers(init.headers).get("X-Rhine-Account") !== "1")
      throw new Error("Unexpected private request options");
    fixture.requests.push(name);
    if (name === "status") return json({ state: fixture.state, membership: { label: "Fixture membership" } });
    if (name === "login") { fixture.state = "pending"; return json({ state: "pending" }); }
    if (name === "logout") { fixture.state = "signed-out"; fixture.selectedId = ""; return json({ state: "signed-out" }); }
    if (name === "playlists") return json({ playlists: [
      { id: "liked", name: "Fixture liked", kind: "liked" }, { id: "created-fixture", name: "Fixture collection", kind: "created" },
    ] });
    if (name === "tracks") {
      const track = { id: String(600 + body.offset), encryptedId: "fixture-song-key", name: body.id + "-" + body.offset, artists: [], album: "" };
      return json({ tracks: [track], hasMore: body.offset === 0 && body.id === "liked" });
    }
    if (name === "quality" && body.id === "fixture-song-key") {
      if (fixture.expired) return new Response('{"error":"Fixture session expired"}', { status: 401, headers: { "Content-Type": "application/json" } });
      const levels = [{ id: "A", label: "Fixture allowed", playable: true }, { id: "B", label: "Fixture denied", playable: false },
        { id: "C", label: "Fixture unknown", playable: null }];
      const current = () => fixture.availability
        ? json({ levels: [], selectedId: "", scope: "reported-maximum", availability: fixture.availability })
        : json({ levels, selectedId: fixture.selectedId, availability: "available" });
      if (Object.hasOwn(body, "level")) return new Promise(resolve => {
        fixture.save = () => { fixture.selectedId = body.level; resolve(current()); };
      });
      // Deliberately ignore AbortSignal: the late completion must never restore a signed-out view.
      if (fixture.late) return new Promise(resolve => { fixture.release = () => resolve(current()); });
      return current();
    }
    throw new Error("Unexpected fixture operation");
  };
}

async function waitFor(read, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const found = await read();
    if (found) return found;
    await sleep(150);
  }
  throw new Error("Timed out waiting for " + label);
}

requireE2EEnvironment();
const profile = profilePath("netease-account");
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = spawn(process.execPath, [STATIC_SERVER, DIST_DIR, String(port)], { stdio: "ignore", windowsHide: true });
const browser = spawn(BROWSER, ["--headless=new", "--mute-audio", "--no-first-run", "--disable-extensions", "--disable-component-update",
  "--disable-background-networking", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=960,600",
  "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore", windowsHide: true });
let socket;
let cdp;
try {
  const debug = await waitFor(async () => {
    try { return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }, "isolated browser");
  const tabs = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await once(socket, "open");
  cdp = new Cdp(socket);
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installFixture.toString()})();` });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/?review=1` });
  const ev = expr => cdp.evaluate(expr);
  const field = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const click = selector => ev(`${field(selector)}.click()`);
  const choose = (selector, value) => ev(`{const el=${field(selector)};el.value=${JSON.stringify(value)};el.dispatchEvent(new Event("change",{bubbles:true}))}`);
  const hasText = (selector, expected) => waitFor(() => ev(`${field(selector)}?.textContent.includes(${JSON.stringify(expected)})`), selector);
  const visible = selector => waitFor(() => ev(`Boolean(${field(selector)}?.getClientRects().length)`), selector);
  const account = name => `[data-account="${name}"]`;
  await waitFor(() => ev("Boolean(window.rhine?.stats().ready)"), "built application");
  await ev("rhine.archive()");
  assert.equal(await ev("rhine.music.library.tracks.length"), 0);
  await click('[data-action="library-mode"]');
  await visible("#netease-open");
  await click("#netease-open");
  await click("#netease-account-tab");
  await visible("#netease-account-setup");
  await ev('accountFixture.state="signed-out"');
  await click(account("status"));
  await visible(account("login"));
  await click(account("login"));
  await hasText("#netease-account-status", "授权");
  await ev('accountFixture.state="signed-in"');
  await click(account("status"));
  await hasText("#netease-membership", "Fixture membership");
  await hasText("#netease-my-playlists", "Fixture collection");
  assert.match(await ev(`${field("#netease-my-playlists")}.textContent`), /我喜欢的音乐/);
  await choose("#netease-my-playlists", "liked");
  await hasText("#netease-my-tracks", "liked-0");
  await click(account("more"));
  await hasText("#netease-my-tracks", "liked-1");
  await choose("#netease-my-playlists", "created-fixture");
  await hasText("#netease-my-tracks", "created-fixture-0");
  assert.equal(await ev("accountFixture.requests.includes('quality')"), false);
  await click("[data-track-quality]");
  await visible("#netease-quality-choice");
  assert.deepEqual(await ev(`Array.from(${field("#netease-quality-choice")}.options,o=>o.value)`), ["", "A"]);
  await hasText("#netease-quality-status", "Fixture denied");
  await hasText("#netease-quality-status", "Fixture unknown");
  await choose("#netease-quality-choice", "A");
  await waitFor(() => ev("Boolean(accountFixture.save)"), "pending preference receipt");
  assert.equal(await ev(`${field("#netease-quality-choice")}.value`), "");
  await ev("accountFixture.save()");
  await hasText("#netease-quality-status", "已保存");
  assert.equal(await ev(`${field("#netease-quality-choice")}.value`), "A");
  await click('[data-action="close-modal"]');
  await waitFor(() => ev("!document.querySelector('#netease-open')"), "closed modal");
  await click('[data-action="library-mode"]');
  await visible("#netease-open");
  await click("#netease-open");
  await click("#netease-account-tab");
  await hasText("#netease-my-playlists", "Fixture collection");
  await choose("#netease-my-playlists", "created-fixture");
  await hasText("#netease-my-tracks", "created-fixture-0");
  await click("[data-track-quality]");
  await visible("#netease-quality-choice");
  assert.equal(await ev(`${field("#netease-quality-choice")}.value`), "A");
  for (const [availability, message] of [["unavailable", "网易云未授权当前账号通过本应用播放此曲"], ["unknown", "网易云尚未确认本曲可用音质"]]) {
    await ev(`accountFixture.availability=${JSON.stringify(availability)}`);
    await click("[data-track-quality]");
    await hasText("#netease-quality-status", message);
    assert.equal(await ev(`${field("#netease-quality-choice")}.getClientRects().length`), 0);
    assert.equal(await ev(`${field("#netease-quality-choice")}.options.length`), 0);
  }
  await ev("delete accountFixture.availability");
  await ev("accountFixture.late=true");
  await click("[data-track-quality]");
  await waitFor(() => ev("Boolean(accountFixture.release)"), "deferred quality reply");
  await click(account("logout"));
  await hasText("#netease-logout-warning", "同时注销本机网易云官方 CLI");
  await click(account("cancel-logout"));
  assert.equal(await ev("accountFixture.requests.includes('logout')"), false);
  assert.equal(await ev(`${field("#netease-logout-confirm")}.hidden`), true);
  await click(account("logout"));
  await click(account("confirm-logout"));
  await visible(account("login"));
  await ev("accountFixture.release()");
  await sleep(100);
  assert.equal(await ev(`${field("#netease-quality")}.hidden`), true);
  assert.equal(await ev(`${field("#netease-my-tracks")}.childElementCount`), 0);
  assert.equal(await ev(`${field("#netease-account")}.textContent.includes("Fixture membership")`), false);
  await ev('Object.assign(accountFixture,{state:"signed-in",late:false,expired:true})');
  await click(account("status"));
  await hasText("#netease-my-playlists", "Fixture collection");
  await choose("#netease-my-playlists", "liked");
  await hasText("#netease-my-tracks", "liked-0");
  await click("[data-track-quality]");
  await hasText("#netease-account-status", "登录已失效");
  assert.equal(await ev(`${field("#netease-my-tracks")}.childElementCount`), 0);
  assert.equal(await ev(`${field("#netease-membership")}.textContent`), "");
  await click("#netease-back");
  assert.equal(await ev("accountFixture.playCalls"), 0);
  assert.equal(await ev("rhine.music.library.tracks.length"), 0);
} finally {
  await cdp?.send("Browser.close", {}, 1000).catch(() => {});
  socket?.close();
  await Promise.all([stopProcessTree(browser), stopProcessTree(server)]);
  // Windows can release Chromium's profile lock a little after the process exits.
  for (let attempt = 0; ; attempt++) {
    try { await removeLocalDirectory(profile); break; }
    catch (error) {
      if (attempt >= 12 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
      await sleep(250);
    }
  }
}
console.log("PASS · Static fixture account through the built UI: login, membership, liked/created playlists, pagination, track quality, logout and stale reply. Zero play calls.");
