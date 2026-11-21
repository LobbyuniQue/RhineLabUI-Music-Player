import assert from "node:assert/strict";
import { test } from "node:test";
import { NeteasePlaylistError, readNeteasePlaylist } from "./lib/netease-playlist.mjs";

const id = "3778678";
const canonical = `https://music.163.com/playlist?id=${id}`;
const first = '<li><a href="/song?id=90071992547409931">First &amp; &#x266b;</a></li>';
const second = '<li><a href="/song?id=27">Second &lt;edit&gt;</a></li>';
function page({ items = first + second, total = "2", identity = id, url = canonical } = {}) {
  return `<head><link href="${url}" rel="canonical"><title>A &amp; B - 歌单 - 网易云音乐</title></head>
    <span id="playlist-track-count">${total}</span>
    <ul class="f-hide"><li><a href="/song?id=42">Unrelated</a></li></ul>
    <div data-key="track_playlist-${identity}" id="song-list-pre-cache"><div>Loading</div>
      <ul class="f-hide">${items}</ul>
      <textarea id="song-list-pre-data">opaque platform data</textarea>
    </div><div><ul class="f-hide"><li><a href="/song?id=45">Other playlist</a></li></ul></div>`;
}
const html = value => new Response(value, { headers: { "content-type": "text/html; charset=utf-8" } });
const from = document => readNeteasePlaylist(id, { fetchImpl: async () => html(document) });
const hasStatus = status => error => error instanceof NeteasePlaylistError && error.status === status;

test("canonical playlist lookup uses only the validated ID for all long-link and share formats", async () => {
  for (const source of [id, canonical, `http://music.163.com/#/playlist?id=${id}`,
    `分享歌单：https://music.163.com/m/playlist?share=discard&id=${id} （来自网易云音乐）`]) {
    const value = await readNeteasePlaylist(source, { fetchImpl: async (url, init) => {
      assert.equal(url, canonical);
      assert.equal(init.redirect, "manual");
      assert.equal(init.credentials, "omit");
      assert.equal(new Headers(init.headers).has("cookie"), false);
      return html(page());
    } });
    assert.deepEqual(value, { id, name: "A & B", total: 2, partial: false, tracks: [
      { id: "90071992547409931", name: "First & ♫", artists: [], album: "" },
      { id: "27", name: "Second <edit>", artists: [], album: "" },
    ] });
  }
});

test("a shared short link resolves once and its target is reduced to the canonical playlist ID", async () => {
  const calls = [];
  const result = await readNeteasePlaylist("分享歌单 http://163cn.tv/Ab12?share=discard (@网易云音乐)", {
    fetchImpl: async (url, init) => {
      calls.push(url);
      assert.equal(init.redirect, "manual");
      return calls.length === 1 ? Response.redirect(`https://music.163.com/m/playlist?id=${id}&other=discard`, 302) : html(page());
    },
  });
  assert.equal(result.id, id);
  assert.deepEqual(calls, ["https://163cn.tv/Ab12", canonical]);
});

test("invalid hosts, link types and IDs cause no outgoing requests", async () => {
  let requests = 0;
  for (const source of ["", "0", "-34", "9".repeat(21), "https://example.com/playlist?id=34",
    "https://music.163.com/song?id=34", "https://music.163.com:444/playlist?id=34",
    "https://name@music.163.com/playlist?id=34", "https://music.163.com/playlist?id=3&id=4",
    "https://163cn.tv/folder/code", "https://music.163.com/#//example.com/playlist?id=34"]) {
    await assert.rejects(readNeteasePlaylist(source, { fetchImpl: async () => { requests++; } }), hasStatus(400));
  }
  assert.equal(requests, 0);
});

test("short links and canonical pages do not follow unexpected redirects", async () => {
  for (const [source, location, expectedStatus] of [
    ["https://163cn.tv/Ab12", "https://example.com/playlist?id=1", 422],
    ["https://163cn.tv/Ab12", "https://music.163.com/song?id=1", 422],
    [id, "https://music.163.com/playlist?id=1", 502],
  ]) {
    const calls = [];
    await assert.rejects(readNeteasePlaylist(source, { fetchImpl: async (url, init) => {
      calls.push(url);
      assert.equal(init.redirect, "manual");
      return Response.redirect(location, 302);
    } }), hasStatus(expectedStatus));
    assert.equal(calls.length, 1);
  }
});

test("reports partial and uncounted public lists, and distinguishes a confirmed empty playlist", async () => {
  const partial = await from(page({ total: "277" }));
  assert.equal(partial.total, 277);
  assert.equal(partial.tracks.length, 2);
  assert.equal(partial.partial, true);
  const unknown = await from(page({ total: "" }));
  assert.equal(unknown.total, null);
  assert.equal(unknown.partial, true);
  const empty = await from(page({ items: "", total: "0" }));
  assert.equal(empty.tracks.length, 0);
  assert.equal(empty.partial, false);
});

test("fail closed for inaccessible, mismatched or truncated pages, even if they contain song recommendations", async () => {
  for (const doc of [page({ items: "", total: "9" }), page({ items: first, total: "0" }),
    page({ identity: "999" }), page({ url: "https://music.163.com/playlist?id=999" }),
    page().replace(/<ul class="f-hide">[^]*?<\/ul>/g, ""),
    page().slice(0, page().indexOf("<textarea")), "<head><title>登录验证</title></head>", ""]) {
    await assert.rejects(from(doc), hasStatus(422));
  }
});

test("retains order and every published item for a playlist over 1000 entries", async () => {
  const items = Array.from({ length: 1021 }, (_, i) => `<li><a href="/song?id=${i+1}">Track ${i+1}</a></li>`).join("");
  const result = await from(page({ items, total: "1021" }));
  assert.deepEqual(result.tracks.map(row => row.id), Array.from({ length: 1021 }, (_, i) => String(i+1)));
  assert.equal(result.partial, false);
});

test("rejects upstream errors and oversized streamed or non-HTML responses", async () => {
  for (const [response, status] of [[new Response(null, { status: 429 }), 429],
    [new Response(null, { status: 403 }), 422], [new Response(null, { status: 404 }), 422],
    [new Response(null, { status: 503 }), 502], [new Response("{}", { headers: { "content-type": "application/json" } }), 502],
    [new Response(new Uint8Array(6 * 1024 * 1024 + 1), { headers: { "content-type": "text/html" } }), 502]]) {
    await assert.rejects(readNeteasePlaylist(id, { fetchImpl: async () => response }), hasStatus(status));
  }
  await assert.rejects(readNeteasePlaylist(id, { fetchImpl: async () => { throw new Error("network error"); } }), hasStatus(502));
});

test("forwards caller cancellation to the request and returns a controlled cancellation", async () => {
  const controller = new AbortController();
  const result = readNeteasePlaylist(id, { signal: controller.signal, fetchImpl: async (_, options) =>
    new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason))) });
  controller.abort();
  await assert.rejects(result, hasStatus(499));
});
